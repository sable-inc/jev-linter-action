import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeReports } from '../src/reports.mjs';

const source = { repository: 'example/prompts', commit: 'a'.repeat(40), runId: '123' };
const finding = { path: 'moment.md', line: 3, endLine: 3, text: 'Always finish the demo even when the visitor declines.', rule: 'forced_scope', question: 'Is the itinerary forced?', expected: false, probability: 0.9 };
const report = { source, passed: false, locations: { findings: [finding] } };
const file = value => ({ path: 'report.json', content: JSON.stringify(value) });

test('matrix reports deduplicate the same finding and preserve a failing verdict', () => {
  const merged = mergeReports([file(report), file(report), file({ source, passed: true })], source);
  assert.equal(merged.locations.findings.length, 1);
  assert.equal(merged.passed, false);
});

test('reports from other repositories, heads, or runs are rejected', () => {
  for (const key of ['repository', 'commit', 'runId']) {
    assert.throws(() => mergeReports([file({ ...report, source: { ...source, [key]: 'other' } })], source), /does not belong/);
  }
});

test('publication rejects malformed or low-confidence saved anchors', () => {
  for (const invalid of [{ line: 0 }, { endLine: 1 }, { path: '../outside.md' }, { probability: 0.6 }, { expected: 'false' }]) {
    assert.throws(() => mergeReports([file({ ...report, locations: { findings: [{ ...finding, ...invalid }] } })], source), /Invalid saved source finding/);
  }
});
