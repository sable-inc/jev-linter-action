import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publishLocations, rightLines } from '../src/github.mjs';
const sha = 'a'.repeat(40);
const repo = 'example/prompts';
const text = 'Always finish every demo even when the visitor declines.';
const finding = { id: 'finding-1', rule: 'forced_scope', question: 'Must the visitor finish after declining?', expected: false, text, path: 'moment.md', line: 3, endLine: 3, probability: 0.94 };
const report = { passed: false, locations: { findings: [finding], requests: 1, omittedCandidates: 0, unlocatedGroups: 0 } };
const options = { repo, token: 'github-only', reviewId: 'acme/demo', eventName: 'pull_request', event: { pull_request: { number: 4, head: { sha, repo: { full_name: repo } }, base: { repo: { full_name: repo } } } } };

function server({ patch = '@@ -1,3 +1,3 @@\n # Demo\n \n+' + text, content = '# Demo\n\n' + text, stale = false, encoding = 'base64', head = sha } = {}) {
  const comments = [], summaries = [], writes = [];
  let headChecks = 0;
  return { comments, summaries, writes, fetcher: async (url, request) => {
    assert.equal(new URL(url).origin, 'https://api.github.com');
    assert.equal(request.headers.Authorization, 'Bearer github-only');
    const path = new URL(url).pathname;
    if (request.method === 'POST') {
      const body = JSON.parse(request.body); writes.push({ path, body });
      if (path.endsWith('/reviews')) comments.push(...body.comments.map(comment => ({ ...comment, commit_id: body.commit_id })));
      else summaries.push(body);
      return Response.json(body);
    }
    if (path.endsWith('/pulls/4')) return Response.json({ head: { sha: stale && ++headChecks > 1 ? 'b'.repeat(40) : head }, state: 'open' });
    if (path.endsWith('/files')) return Response.json([{ filename: 'moment.md', patch }]);
    if (path.includes('/contents/')) return Response.json({ encoding, content: encoding === 'base64' ? Buffer.from(content).toString('base64') : '' });
    if (path.includes('/issues/')) return Response.json(summaries);
    if (path.endsWith('/comments')) return Response.json(comments);
    throw new Error(`Unexpected request ${path}`);
  } };
}

test('diff parser locates right-side context/additions without treating deletions as anchors', () => {
  assert.deepEqual([...rightLines('@@ -10,3 +10,3 @@\n keep\n-old\n+new\n last')], [10, 11, 12]);
});
test('posts source-verified inline comments and deduplicates a retry', async () => {
  const mock = server();
  const posted = await publishLocations(report, options, mock);
  assert.equal(posted.comments, 1);
  assert.equal(mock.comments[0].line, 3);
  assert.equal(mock.comments[0].commit_id, sha);
  assert.ok(mock.comments[0].body.includes(text));
  await publishLocations(report, options, mock);
  assert.equal(mock.writes.length, 1); // All inline comments are submitted as one review.
  assert.equal(mock.summaries.length, 0);
});
test('unchanged or mismatched source never creates a PR conversation comment', async () => {
  const outside = server({ patch: '' });
  await publishLocations(report, options, outside);
  assert.equal(outside.comments.length, 0);
  assert.equal(outside.writes.length, 0);
  const mismatch = server({ content: '# Different\n\nSomething else' });
  const result = await publishLocations(report, options, mismatch);
  assert.equal(result.unmapped, 1);
  assert.equal(mismatch.comments.length, 0);
  assert.equal(mismatch.writes.length, 0);
});
test('stale heads and forks cannot receive review writes', async () => {
  const stale = server({ stale: true });
  await assert.rejects(publishLocations(report, options, stale), /stale findings/);
  assert.equal(stale.writes.length, 0);
  const fork = structuredClone(options); fork.event.pull_request.head.repo.full_name = 'fork/prompts';
  await assert.rejects(publishLocations(report, fork, server()), /same-repository/);
});

test('the inline comment cap applies across retries while all findings remain in the report', async () => {
  const mock = server();
  const multiple = structuredClone(report);
  multiple.locations.findings.push({ ...finding, id: 'finding-2', rule: 'other_rule' });
  await publishLocations(multiple, { ...options, maxComments: 1 }, mock);
  await publishLocations(multiple, { ...options, maxComments: 1 }, mock);
  assert.equal(mock.comments.length, 1);
  assert.equal(mock.writes.length, 1);
  assert.equal(mock.summaries.length, 0);
  assert.equal(multiple.locations.findings.length, 2);
});

test('manual events skip publishing and malformed contexts or limits fail before HTTP', async () => {
  const deps = { fetcher: async () => assert.fail('No GitHub call expected') };
  const result = await publishLocations(report, { ...options, eventName: 'workflow_dispatch' }, deps);
  assert.equal(result.comments, 0);
  assert.match(result.skipped, /pull_request/);
  await assert.rejects(publishLocations(report, { ...options, maxComments: 21 }, deps), /max-comments/);
  const invalid = structuredClone(options); invalid.event.pull_request.head.sha = 'invalid';
  await assert.rejects(publishLocations(report, invalid, deps), /Invalid GitHub PR context/);
});

test('unavailable large-file contents remain in the report without publication errors or PR noise', async () => {
  const mock = server({ encoding: 'none' });
  const result = await publishLocations(report, options, mock);
  assert.equal(result.unmapped, 1);
  assert.equal(mock.comments.length, 0);
  assert.equal(mock.writes.length, 0);
  assert.equal(report.locations.findings[0].text, text);
});

test('no localized findings produce no GitHub calls or comments', async () => {
  const empty = { ...report, locations: { ...report.locations, findings: [] } };
  const result = await publishLocations(empty, options, { fetcher: async () => assert.fail('No GitHub call expected') });
  assert.equal(result.comments, 0);
});

test('many findings produce only one bounded review and no summary comments', async () => {
  const mock = server();
  const large = structuredClone(report);
  large.locations.findings = Array.from({ length: 50 }, (_, i) => ({ ...finding, id: `finding-${i}`, rule: `rule_${i}` }));
  await publishLocations(large, options, mock);
  assert.equal(mock.writes.length, 1);
  assert.ok(mock.writes[0].path.endsWith('/reviews'));
  assert.equal(mock.writes[0].body.event, 'COMMENT');
  assert.equal(mock.comments.length, 5);
  assert.equal(mock.summaries.length, 0);
  await publishLocations(large, options, mock);
  assert.equal(mock.writes.length, 1);
});

test('the same finding is not reposted after an unrelated commit or a shifted line', async () => {
  const first = server();
  await publishLocations(report, options, first);
  const head = 'c'.repeat(40);
  const next = server({ head }); next.comments.push(...first.comments);
  const nextOptions = structuredClone(options); nextOptions.event.pull_request.head.sha = head;
  const nextReport = structuredClone(report); nextReport.locations.findings[0].line++;
  const result = await publishLocations(nextReport, nextOptions, next);
  assert.equal(result.duplicates, 1);
  assert.equal(next.writes.length, 0);
});

test('advisory findings publish as nonblocking suggestions even when the gate passes', async () => {
  const mock = server();
  await publishLocations({passed:true, locations:{findings:[{...finding, advisory:true}]}}, options, mock);
  assert.equal(mock.comments.length, 1);
  assert.match(mock.comments[0].body, /advisory suggestion \(does not block CI\)/);
  assert.doesNotMatch(mock.comments[0].body, /failed check/);
});
