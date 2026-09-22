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
  const containing = { path: 'quoted.md', content: `The example says: ${text} This is a quote, not a requirement.` };
  assert.equal(candidates([file, containing], containing.content).length, 0);
});

test('focus keeps the complete Unicode target and fits both Jev budgets', () => {
  const unit = { text: `${text} 🌍 "quote"` };
  const context = 'prefix '.repeat(7000) + JSON.stringify(unit.text).slice(1, -1) + ' suffix'.repeat(7000);
  const request = focusedRequest(context, unit, [failure], 'jev-1.13.0');
  assert.ok(request.contextTruncated);
  assert.ok(request.files[0].content.includes(`JEV_TARGET_0_START\n${JSON.stringify(unit.text).slice(1, -1)}\nJEV_TARGET_0_END`));
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
    assert.ok(body.state.files[0].content.includes('JEV_TARGET_0_START'));
    return Response.json({ answers: { location_0: { type: 'noul', noul: 0.95 } } });
  } });
  assert.deepEqual(report, snapshot);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].line, 3);
  assert.equal(result.findings[0].path, 'moment.md');
  const uncertain = await locate(report, root, options, { fetcher: async () => Response.json({ answers: { location_0: { type: 'noul', noul: 0.6 } } }) });
  assert.equal(uncertain.findings.length, 0);
  assert.deepEqual(uncertain.assessments, [{ path: 'moment.md', line: 3, endLine: 3, rule: 'forced_scope', violationProbability: 0.6, localized: false }]);
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
    const body = JSON.parse(request.body);
    seen.push(body.state.files[0].content);
    return Response.json({ answers: Object.fromEntries(Object.keys(body.questions).map(id => [id, { type: 'noul', noul: 0.95 }])) });
  } });
  assert.equal(result.requests, 2);
  assert.equal(result.omittedCandidates, 0);
  assert.ok(seen[1].includes(third));
});

test('localization is opt-in and publishing configuration is validated', () => {
  assert.equal(locationOptions({}).enabled, false);
  assert.throws(() => locationOptions({ INPUT_LOCATE: 'true' }), /source-glob/);
  assert.throws(() => locationOptions({ 'INPUT_POST-COMMENTS': 'true' }), /requires locate/);
  assert.throws(() => locationOptions({ INPUT_LOCATE: 'true', 'INPUT_SOURCE-GLOB': '*.md', 'INPUT_LOCATE-MAX-REQUESTS': '513' }), /1–512/);
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

test('multiple failed rules share a request and answers retain the correct rule and expectation', async t => {
  const { root, report } = await fixture(t);
  report.results.push({ ...report.results[0], id: 'yields_to_visitor', question: 'Does the itinerary yield to the visitor?', expected: true });
  const result = await locate(report, root, { sourcePatterns: ['*.md'], model: 'jev-1.13.0', apiKey: 'key' }, { fetcher: async (_, request) => {
    assert.deepEqual(Object.keys(JSON.parse(request.body).questions), ['location_0', 'location_1']);
    return Response.json({ answers: { location_1: { type: 'noul', noul: 0.05 }, location_0: { type: 'noul', noul: 0.9 } } });
  } });
  assert.equal(result.requests, 1);
  assert.deepEqual(result.findings.map(f => [f.rule, f.expected, f.probability]), [['forced_scope', false, 0.9], ['yields_to_visitor', true, 0.95]]);
  assert.deepEqual(result.assessments.map(a => [a.rule, a.localized]), [['forced_scope', true], ['yields_to_visitor', true]]);
});

test('batches candidate passages and prioritizes diff lines within a bounded request budget', async t => {
  const paragraphs = Array.from({ length: 6 }, (_, i) => `${text} Distinct authored paragraph number ${i}.`);
  const { root, report } = await fixture(t, paragraphs.join('\n\n'));
  await writeFile(join(root, 'moment.md'), paragraphs.join('\n\n'));
  const result = await locate(report, root, { sourcePatterns: ['*.md'], model: 'jev-1.13.0', apiKey: 'key', maxRequests: 1, priority: new Map([['moment.md', new Set([11])]]) }, { fetcher: async (_, request) => {
    const body = JSON.parse(request.body);
    assert.equal(Object.keys(body.questions).length, 4);
    assert.ok(body.state.files[0].content.includes(`JEV_TARGET_0_START\n${paragraphs[5]}\nJEV_TARGET_0_END`));
    return Response.json({ answers: Object.fromEntries(Object.keys(body.questions).map(id => [id, { type: 'noul', noul: id === 'location_0' ? 0.9 : 0.2 }])) });
  } });
  assert.equal(result.requests, 1);
  assert.equal(result.omittedCandidates, 2);
  assert.equal(result.assessments.length, 4);
  assert.deepEqual(result.findings.map(f => f.line), [11]);
});

test('advisory source findings retain their classification even when the gate passes', async t => {
  const { root, report } = await fixture(t);
  report.passed = true;
  report.results[0].advisory = true;
  const result = await locate(report, root, { sourcePatterns:['moment.md'], model:'jev-1.13.0', apiKey:'key' }, {
    fetcher: async () => Response.json({answers:{location_0:{type:'noul',noul:0.95}}}),
  });
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].advisory, true);
  assert.equal(report.passed, true);
});
