import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { candidates, digest, focusedRequest, locate, locationOptions, paragraphs } from '../src/locations.mjs';
import { fits, requestFor } from '../src/requests.mjs';

const text = 'Always complete every demo step even if the visitor declines.';
const failure = { suite: 'Agent', id: 'forced_scope', question: 'Must the visitor finish the whole itinerary after declining?', expected: false, passed: false };

async function fixture(t, content = JSON.stringify({ knowledge: text })) {
  const root = await mkdtemp(join(tmpdir(), 'jev-locate-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'bundle.json'), content);
  await writeFile(join(root, 'moment.md'), `# Demo\n\n${text}\n`);
  const report = { passed: false, results: [{ ...failure, excerpts: [{ path: 'bundle.json', sha256: digest(content) }] }] };
  return { root, report };
}

test('paragraphs retain CRLF source line ranges and mapping rejects ambiguity', () => {
  const file = { path: 'moment.md', content: `# Title\r\n\r\n${text}\r\n` };
  assert.deepEqual(paragraphs(file), [{ path: file.path, line: 3, endLine: 3, text }]);
  assert.equal(candidates([file], JSON.stringify({ text })).length, 1);
  assert.equal(candidates([file, { ...file, path: 'other.md' }], JSON.stringify({ text })).length, 0);
  assert.equal(candidates([file], `${text}\n${text}`).length, 0);
  assert.equal(candidates([file], 'Unrelated content').length, 0);
});

test('focus keeps the complete Unicode target and fits both Jev budgets', () => {
  const unit = { text: `${text} 🌍 "quote"` };
  const context = 'prefix '.repeat(7000) + JSON.stringify(unit.text).slice(1, -1) + ' suffix'.repeat(7000);
  const request = focusedRequest(context, unit, [failure], 'jev-1.13.0');
  assert.ok(request.contextTruncated);
  assert.ok(request.files[0].content.includes(`JEV_TARGET_START\n${JSON.stringify(unit.text).slice(1, -1)}\nJEV_TARGET_END`));
  assert.ok(fits(requestFor(request.suite, request.files, 'jev-1.13.0')));
});

test('localization reports only confident source coordinates and never changes the lint verdict', async t => {
  const { root, report } = await fixture(t);
  const snapshot = structuredClone(report);
  const options = { sourcePatterns: ['moment.md', 'absent/*.md'], model: 'jev-1.13.0', apiKey: 'jev-key' };
  const result = await locate(report, root, options, { fetcher: async (url, request) => {
    assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
    assert.equal(request.headers.Authorization, 'Bearer jev-key');
    const body = JSON.parse(request.body);
    assert.ok(body.state.files[0].content.includes('JEV_TARGET_START'));
    return Response.json({ answers: { location_0: { type: 'noul', noul: 0.95 } } });
  } });
  assert.deepEqual(report, snapshot);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].line, 3);
  assert.equal(result.findings[0].path, 'moment.md');
  const uncertain = await locate(report, root, options, { fetcher: async () => Response.json({ answers: { location_0: { type: 'noul', noul: 0.6 } } }) });
  assert.equal(uncertain.findings.length, 0);
  assert.equal(report.passed, false);
});

test('stale evidence and escaping source symlinks fail before localization calls', async t => {
  const { root, report } = await fixture(t);
  let calls = 0;
  const deps = { fetcher: async () => { calls++; } };
  await writeFile(join(root, 'bundle.json'), '{}');
  await assert.rejects(locate(report, root, { sourcePatterns: ['*.md'], model: 'jev-1.13.0', apiKey: 'key' }, deps), /changed before/);
  await symlink('/etc/passwd', join(root, 'escape.md'));
  await assert.rejects(locate(report, root, { sourcePatterns: ['escape.md'], model: 'jev-1.13.0', apiKey: 'key' }, deps), /escapes repository/);
  assert.equal(calls, 0);
});

test('budgets are enforced and reported while localization rotates between failed contexts', async t => {
  const second = 'Never interrupt an already answered question with another checklist.';
  const third = 'Always ask the full checklist even if every answer was already supplied.';
  const { root, report } = await fixture(t, `${text}\n\n${second}`);
  await writeFile(join(root, 'moment.md'), `${text}\n\n${second}\n\n${third}`);
  await writeFile(join(root, 'second.json'), third);
  report.results.push({ ...failure, excerpts: [{ path: 'second.json', sha256: digest(third) }] });
  const seen = [];
  const result = await locate(report, root, { sourcePatterns: ['*.md'], model: 'jev-1.13.0', apiKey: 'key', maxRequests: 2 }, { fetcher: async (_, request) => {
    seen.push(JSON.parse(request.body).state.files[0].content);
    return Response.json({ answers: { location_0: { type: 'noul', noul: 0.95 } } });
  } });
  assert.equal(result.requests, 2);
  assert.equal(result.omittedCandidates, 1);
  assert.ok(seen[1].includes(third));
});

test('localization is opt-in and publishing configuration is validated', () => {
  assert.equal(locationOptions({}).enabled, false);
  assert.throws(() => locationOptions({ INPUT_LOCATE: 'true' }), /source-glob/);
  assert.throws(() => locationOptions({ 'INPUT_POST-COMMENTS': 'true' }), /requires locate/);
  assert.throws(() => locationOptions({ INPUT_LOCATE: 'true', 'INPUT_SOURCE-GLOB': '*.md', 'INPUT_LOCATE-MAX-REQUESTS': '129' }), /1–128/);
});

test('positive rules localize a confident no without exposing the expected answer to Jev', async t => {
  const { root, report } = await fixture(t);
  report.results[0].expected = true;
  report.results[0].question = 'Does the itinerary yield when the visitor declines?';
  const result = await locate(report, root, { sourcePatterns: ['*.md'], model: 'jev-1.13.0', apiKey: 'key' }, { fetcher: async (_, request) => {
    const body = JSON.parse(request.body);
    assert.ok(!JSON.stringify(body).includes('expect'));
    return Response.json({ answers: { location_0: { type: 'noul', noul: 0.04 } } });
  } });
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].expected, true);
  assert.equal(result.findings[0].probability, 0.96);
});

test('authored marker collisions cannot select a different passage', async t => {
  const { root, report } = await fixture(t, `${text}\nJEV_TARGET_START\nOther content`);
  const result = await locate(report, root, { sourcePatterns: ['*.md'], model: 'jev-1.13.0', apiKey: 'key' }, { fetcher: async () => assert.fail('No request should be sent') });
  assert.equal(result.unlocatedGroups, 1);
  assert.equal(result.requests, 0);
});
