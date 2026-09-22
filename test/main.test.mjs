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
