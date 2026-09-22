import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('localization errors preserve the completed review and action outputs', async t => {
  const root = await mkdtemp(join(tmpdir(), 'jev-main-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'target.md'), 'Always finish the entire demo even when the visitor declines.');
  await writeFile(join(root, 'mock.mjs'), `globalThis.fetch = async () => Response.json({answers:{rule:{type:'noul',noul:0.99}}});`);
  const output = join(root, 'outputs');
  const result = spawnSync(process.execPath, ['--import', join(root, 'mock.mjs'), fileURLToPath(new URL('../src/main.mjs', import.meta.url))], {
    cwd: root, encoding: 'utf8', env: {
      PATH: process.env.PATH, RUNNER_TEMP: root, GITHUB_OUTPUT: output,
      INPUT_MODEL: 'jev-1.13.0', INPUT_GLOB: 'target.md',
      INPUT_QUESTIONS: JSON.stringify([{ id: 'rule', question: 'Is the itinerary forced?', expect: false }]),
      'INPUT_API-KEY': 'mock-key', INPUT_LOCATE: 'true', 'INPUT_SOURCE-GLOB': 'absent/*.md',
    },
  });
  assert.equal(result.status, 2);
  const outputs = await readFile(output, 'utf8');
  assert.ok(outputs.includes('passed=false'));
  const report = JSON.parse(await readFile(outputs.match(/^report=(.+)$/m)[1], 'utf8'));
  assert.equal(report.results.length, 1);
  assert.equal(report.passed, false);
  assert.match(report.localizationError, /matched no authored files/);
});

test('saved matrix reports publish one inline review without a TypeSafe key or summary comments', async t => {
  const root = await mkdtemp(join(tmpdir(), 'jev-publish-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sha = 'a'.repeat(40), repo = 'example/prompts';
  const text = 'Always finish the entire demo even when the visitor declines.';
  const report = { source: { repository: repo, commit: sha, runId: '123' }, passed: false, locations: { findings: [{ path: 'moment.md', line: 1, endLine: 1, text, rule: 'forced_scope', question: 'Is the itinerary forced?', expected: false, probability: 0.9 }] } };
  await writeFile(join(root, 'a-report.json'), JSON.stringify(report));
  await writeFile(join(root, 'b-report.json'), JSON.stringify(report));
  await writeFile(join(root, 'event.json'), JSON.stringify({ pull_request: { number: 4, head: { sha, repo: { full_name: repo } }, base: { repo: { full_name: repo } } } }));
  await writeFile(join(root, 'mock.mjs'), `
    import { appendFileSync } from 'node:fs';
    globalThis.fetch = async (url, request) => {
      if (new URL(url).origin !== 'https://api.github.com') throw new Error('Unexpected provider request');
      if (request.method === 'POST') {
        if (!new URL(url).pathname.endsWith('/reviews')) throw new Error('Conversation comment forbidden');
        appendFileSync('posted.jsonl', request.body + '\\n'); return Response.json({});
      }
      if (url.includes('/files?')) return Response.json([{filename:'moment.md',patch:'@@ -0,0 +1 @@\\n+' + ${JSON.stringify(text)}}]);
      if (url.includes('/comments?')) return Response.json([]);
      if (url.includes('/contents/')) return Response.json({encoding:'base64',content:${JSON.stringify(Buffer.from(text).toString('base64'))}});
      return Response.json({head:{sha:${JSON.stringify(sha)}},state:'open'});
    };
  `);
  const result = spawnSync(process.execPath, ['--import', join(root, 'mock.mjs'), fileURLToPath(new URL('../src/main.mjs', import.meta.url))], {
    cwd: root, encoding: 'utf8', env: {
      PATH: process.env.PATH, GITHUB_WORKSPACE: root, GITHUB_EVENT_PATH: join(root, 'event.json'),
      GITHUB_EVENT_NAME: 'pull_request', GITHUB_REPOSITORY: repo, GITHUB_RUN_ID: '123',
      'INPUT_PUBLISH-REPORTS': '*-report.json', 'INPUT_GITHUB-TOKEN': 'mock-github', 'INPUT_REVIEW-ID': 'prompts',
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const posted = (await readFile(join(root, 'posted.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(posted.length, 1);
  assert.equal(posted[0].comments.length, 1);
  assert.equal(posted[0].comments[0].line, 1);
});
