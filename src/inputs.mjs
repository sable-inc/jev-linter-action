import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { inside, validate } from './lint.mjs';

// Action inputs are strings; questions is a YAML sequence inside a workflow block.
export function inlineConfig({ model, glob, questions, perFile }) {
  if (!model?.trim() || !glob?.trim() || !questions?.trim()) throw new Error('Inline mode requires model, glob, and questions');
  let parsed;
  try { parsed = parse(questions, { maxAliasCount: 0 }); }
  catch { throw new Error('questions must be a valid YAML list'); }
  if (!Array.isArray(parsed)) throw new Error('questions must be a YAML list');
  if (perFile && !['true', 'false'].includes(perFile)) throw new Error('per-file must be true or false');
  const entries = parsed.map((value, i) => {
    const defaults = { id: `question_${i + 1}`, expect: true, minProbability: 0.8 };
    if (typeof value === 'string') return { ...defaults, question: value };
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Each question must be text or a question object');
    return { ...defaults, ...value };
  });
  return validate({ model: model.trim(), suites: [{ name: 'Review', files: glob.split(/\r?\n/).map(s => s.trim()).filter(Boolean), perFile: perFile === 'true', questions: entries }] });
}

export async function loadConfig(root, env = process.env, argument) {
  const inline = ['INPUT_MODEL', 'INPUT_GLOB', 'INPUT_QUESTIONS'].some(key => env[key]?.trim());
  const file = env.INPUT_CONFIG?.trim() || argument;
  if (inline) {
    if (file) throw new Error('Use inline inputs or config, not both');
    return inlineConfig({ model: env.INPUT_MODEL, glob: env.INPUT_GLOB, questions: env.INPUT_QUESTIONS, perFile: env['INPUT_PER-FILE'] });
  }
  if (env['INPUT_PER-FILE'] && env['INPUT_PER-FILE'] !== 'false') throw new Error('per-file requires inline inputs');
  return JSON.parse(await readFile(await inside(root, file || '.jev-lint.json'), 'utf8'));
}
