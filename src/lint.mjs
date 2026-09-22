import { glob, readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import { requestFor, assertBudget, planRequests, maxRequests, budgetOf } from './requests.mjs';

const endpoint = 'https://api.typesafe.ai/v1/systemone';
const limit = 2 * 1024 * 1024;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function keys(value, allowed, name) {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new Error(`Invalid ${name}: unexpected field or shape`);
}
export function validate(config) {
  keys(config, ['model', 'suites'], 'config');
  if (typeof config.model !== 'string' || !config.model.trim()) throw new Error('model must be a nonempty Jev model ID');
  if (!Array.isArray(config.suites) || !config.suites.length || config.suites.length > 100) throw new Error('suites must contain 1–100 entries');
  const names = new Set();
  for (const suite of config.suites) {
    keys(suite, ['name', 'files', 'questions', 'perFile'], 'suite');
    if (typeof suite.name !== 'string' || !suite.name.trim() || names.has(suite.name)) throw new Error('Suite names must be nonempty and unique');
    names.add(suite.name);
    if (!Array.isArray(suite.files) || !suite.files.length || suite.files.some(p => typeof p !== 'string' || !p.trim() || isAbsolute(p) || p.split(/[\\/]/).includes('..'))) throw new Error(`${suite.name}: files must be repository-relative patterns`);
    if (suite.perFile !== undefined && typeof suite.perFile !== 'boolean') throw new Error('perFile must be a boolean');
    if (!Array.isArray(suite.questions) || !suite.questions.length || suite.questions.length > 64) throw new Error(`${suite.name}: questions must contain 1–64 entries`);
    const ids = new Set();
    for (const q of suite.questions) {
      keys(q, ['id', 'question', 'expect', 'minProbability'], 'question');
      if (typeof q.id !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(q.id) || ids.has(q.id)) throw new Error('Question IDs must be unique snake_case identifiers');
      ids.add(q.id);
      if (typeof q.question !== 'string' || !q.question.trim() || typeof q.expect !== 'boolean') throw new Error(`${q.id}: question and boolean expect are required`);
      if (!Number.isFinite(q.minProbability) || q.minProbability <= 0.5 || q.minProbability > 1) throw new Error(`${q.id}: minProbability must be > 0.5 and <= 1`);
    }
  }
  return config;
}

export async function inside(root, file) {
  const actual = await realpath(resolve(root, file));
  const path = relative(await realpath(root), actual);
  if (path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) throw new Error('Target escapes repository');
  return actual;
}

export async function collect(root, patterns, perFile = false) {
  const files = new Map();
  let bytes = 0;
  for (const pattern of patterns) {
    let matched = false;
    for await (const path of glob(pattern, { cwd: root, exclude: ['**/.git/**', '**/node_modules/**'] })) {
      const actual = await inside(root, path);
      const info = await stat(actual);
      if (!info.isFile()) throw new Error(`Target is not a file: ${path}`);
      matched = true;
      if (files.has(actual)) continue;
      bytes += info.size;
      if (info.size > limit || bytes > 16 * 1024 * 1024 || files.size >= 128) throw new Error('Target set exceeds limits (2 MiB per file, 16 MiB per suite, 128 files); narrow the suite');
      const content = await readFile(actual, 'utf8');
      if (content.includes('\0')) throw new Error(`Target is binary: ${path}`);
      files.set(actual, { path: relative(root, resolve(root, path)).split(sep).join('/'), content });
    }
    if (!matched) throw new Error(`No files matched ${pattern}`);
  }
  return [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
}

export async function evaluate(suite, files, model, apiKey, { fetcher = fetch, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}, review) {
  const request = requestFor(suite, files, model, review);
  assertBudget(request);
  const body = JSON.stringify(request);
  let response;
  for (let attempt = 0; attempt < 3; attempt++) {
    response = await fetcher(endpoint, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(30_000), redirect: 'error' });
    if (response.ok) break;
    if (attempt < 2 && [429, 500, 502, 503, 504, 529].includes(response.status)) {
      await response.body?.cancel();
      const retrySeconds = Number(response.headers.get("retry-after"));
      await sleep(Number.isFinite(retrySeconds) && retrySeconds > 0 ? Math.min(retrySeconds * 1000, 10_000) : 1000 * 2 ** attempt); continue;
    }
    throw new Error(`TypeSafe returned HTTP ${response.status}`);
  }
  let payload;
  try { payload = await response.json(); } catch { throw new Error("TypeSafe returned invalid JSON"); }
  if (!object(payload?.answers)) throw new Error('TypeSafe returned no answer map');
  return suite.questions.map(q => {
    const answer = payload.answers[q.id];
    if (answer?.type !== 'noul' || !Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1) throw new Error(`Invalid or missing TypeSafe answer: ${q.id}`);
    const probability = q.expect ? answer.noul : 1 - answer.noul;
    return { suite: suite.name, files: [...new Set(files.map(f => f.path))], excerpts: files.map(({ content, ...source }) => source), review: request.state.review, budget: budgetOf(request), id: q.id, question: q.question, expected: q.expect, yesProbability: answer.noul, probability, minProbability: q.minProbability, passed: probability >= q.minProbability, model: payload.model ?? model };
  });
}

export async function lint(config, root, apiKey, deps) {
  validate(config);
  if (typeof apiKey !== 'string' || !apiKey.trim()) throw new Error('TYPESAFE_API_KEY / api-key is required');
  // Read and validate every target before making any paid requests.
  const jobs = [];
  for (const suite of config.suites) {
    const files = await collect(root, suite.files, suite.perFile);
    for (const planned of planRequests(suite, files, config.model)) jobs.push({ suite, ...planned });
    if (jobs.length > maxRequests) throw new Error(`Review exceeds ${maxRequests} requests; narrow the target set`);
  }
  const results = [];
  // Bounded requests avoid surprising fan-out against a repository of agents.
  for (let offset = 0; offset < jobs.length; offset += 3) {
    const batch = await Promise.all(jobs.slice(offset, offset + 3).map(j => evaluate(j.suite, j.files, config.model, apiKey, deps, j.review)));
    results.push(...batch.flat());
  }
  return { passed: results.every(r => r.passed), split: jobs.some(job => job.review.split), requests: jobs.length, results };
}
