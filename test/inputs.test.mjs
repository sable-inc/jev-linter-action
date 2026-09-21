import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inlineConfig, loadConfig } from '../src/inputs.mjs';
import { lint } from '../src/lint.mjs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const inputs = {model: 'jev-1.13.0', glob: '*.md\nprompts/*.tmpl', questions: '- Is it consistent?\n- Does it avoid guessed paths?'};
test('inline workflow list needs no file and supplies passing expectations', async () => {
 const config = await loadConfig('/nonexistent', {INPUT_MODEL: inputs.model, INPUT_GLOB: inputs.glob, INPUT_QUESTIONS: inputs.questions});
 assert.deepEqual(config.suites[0].files, ['*.md','prompts/*.tmpl']);
 assert.deepEqual(config.suites[0].questions[0], {id: 'question_1', question: 'Is it consistent?', expect: true, minProbability: 0.8});
});
test('question objects support negative expectations, thresholds and multiline text', () => {
 const config = inlineConfig({...inputs, perFile: 'true', questions: '- question: >\n    Are there contradictions\n    after overrides?\n  expect: false\n  minProbability: 0.9\n  id: contradictions'});
 assert.equal(config.suites[0].questions[0].id, 'contradictions');
 assert.equal(config.suites[0].questions[0].question, 'Are there contradictions after overrides?\n');
 assert.equal(config.suites[0].perFile, true);
 assert.equal(config.suites[0].questions[0].expect, false);
 assert.equal(config.suites[0].questions[0].minProbability, 0.9);
});
test('incomplete, ambiguous and invalid input fails closed', async () => {
 for (const extra of [{model: ''}, {glob: '../secret'}, {perFile: 'yes'}, ...['text', '[]', '- false', '- question: Hi\n  typo: false', '- question: Hi\n  expect: no', '- {question: Hi, minProbability: 0.5}', '- [broken', '- &q Hi\n- *q'].map(questions => ({questions}))]) assert.throws(() => inlineConfig({...inputs, ...extra}));
 await assert.rejects(loadConfig('.', {INPUT_MODEL: inputs.model, INPUT_CONFIG: 'file.json'}), /not both/);
});
test('inline review runs the existing pass/fail path and file input remains compatible', async t => {
 const root = await mkdtemp(join(tmpdir(), 'jev-inline-')); t.after(() => rm(root, {recursive:true,force:true}));
 await writeFile(join(root, 'a.md'), 'Be clear.');
 const config = inlineConfig({...inputs, glob: '*.md', questions: '- Is it clear?'});
 await writeFile(join(root, 'config.json'), JSON.stringify(config));
 assert.deepEqual(await loadConfig(root, {INPUT_CONFIG:'config.json'}), config);
 for (const [noul, passed] of [[0.9,true],[0.6,false]]) {
  const result = await lint(config, root, 'test', {fetcher:async () => Response.json({answers:{question_1:{type:'noul',noul}}})});
  assert.equal(result.passed, passed);
 }
});
