import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publishLocations, rightLines } from '../src/github.mjs';
const sha = 'a'.repeat(40);
const repo = 'example/prompts';
const text = 'Always finish every demo even when the visitor declines.';
const finding = { id: 'finding-1', rule: 'forced_scope', question: 'Must the visitor finish after declining?', expected: false, text, path: 'moment.md', line: 3, endLine: 3, probability: 0.94 };
const report = { passed: false, locations: { findings: [finding], requests: 1, omittedCandidates: 0, unlocatedGroups: 0 } };
const options = { repo, token: 'github-only', reviewId: 'acme/demo', eventName: 'pull_request', event: { pull_request: { number: 4, head: { sha, repo: { full_name: repo } }, base: { repo: { full_name: repo } } } } };

function server({ patch = '@@ -1,3 +1,3 @@\n # Demo\n \n+' + text, content = '# Demo\n\n' + text, stale = false } = {}) {
  const comments = [], summaries = [], writes = [];
  let headChecks = 0;
  return { comments, summaries, writes, fetcher: async (url, request) => {
    assert.equal(new URL(url).origin, 'https://api.github.com');
    assert.equal(request.headers.Authorization, 'Bearer github-only');
    const path = new URL(url).pathname;
    if (request.method === 'POST') {
      const body = JSON.parse(request.body); writes.push({ path, body });
      (path.includes('/issues/') ? summaries : comments).push(body);
      return Response.json(body);
    }
    if (path.endsWith('/pulls/4')) return Response.json({ head: { sha: stale && ++headChecks > 1 ? 'b'.repeat(40) : sha }, state: 'open' });
    if (path.endsWith('/files')) return Response.json([{ filename: 'moment.md', patch }]);
    if (path.includes('/contents/')) return Response.json({ encoding: 'base64', content: Buffer.from(content).toString('base64') });
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
  assert.equal(mock.writes.length, 2); // One inline comment and one summary total.
});
test('unchanged source goes to a permalink summary; mismatched source never gets an inline comment', async () => {
  const outside = server({ patch: '' });
  await publishLocations(report, options, outside);
  assert.equal(outside.comments.length, 0);
  assert.ok(outside.summaries[0].body.includes(`/blob/${sha}/moment.md#L3-L3`));
  const mismatch = server({ content: '# Different\n\nSomething else' });
  const result = await publishLocations(report, options, mismatch);
  assert.equal(result.unmapped, 1);
  assert.equal(mismatch.comments.length, 0);
});
test('stale heads and forks cannot receive review writes', async () => {
  const stale = server({ stale: true });
  await assert.rejects(publishLocations(report, options, stale), /stale findings/);
  assert.equal(stale.writes.length, 0);
  const fork = structuredClone(options); fork.event.pull_request.head.repo.full_name = 'fork/prompts';
  await assert.rejects(publishLocations(report, fork, server()), /same-repository/);
});

test('the inline comment cap applies across retries while all findings remain in the summary', async () => {
  const mock = server();
  const multiple = structuredClone(report);
  multiple.locations.findings.push({ ...finding, id: 'finding-2', rule: 'other_rule' });
  await publishLocations(multiple, { ...options, maxComments: 1 }, mock);
  await publishLocations(multiple, { ...options, maxComments: 1 }, mock);
  assert.equal(mock.comments.length, 1);
  assert.equal(mock.summaries.length, 1);
  assert.ok(mock.summaries[0].body.includes('other_rule'));
});
