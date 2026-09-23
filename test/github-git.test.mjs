import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reviewDiff, publishLocations } from '../src/github.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'jev-git-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'main');
  git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.test');
  const path = 'moment [démo].md';
  await writeFile(join(root, path), '# Demo\nKeep this.\nOld instruction.\n');
  git('add', '.'); git('commit', '-m', 'base');
  const ancestor = git('rev-parse', 'HEAD');
  await writeFile(join(root, path), '# Base-only change\nKeep this.\nOld instruction.\n');
  git('commit', '-am', 'base advanced');
  const base = git('rev-parse', 'HEAD');
  git('checkout', '-b', 'feature', ancestor);
  await writeFile(join(root, path), '# Demo\nKeep this.\nNew instruction.\n');
  git('commit', '-am', 'PR change');
  const head = git('rev-parse', 'HEAD');
  const repo = 'example/prompts';
  const options = { root, repo, token: 'fake', reviewId: 'test', eventName: 'pull_request', event: { pull_request: {
    number: 1, head: { sha: head, repo: { full_name: repo } }, base: { sha: base, repo: { full_name: repo } },
  } } };
  const files = [{ filename: path, status: 'modified', additions: 1, deletions: 1, changes: 2 }];
  const writes = [];
  const fetcher = async (url, request) => {
    const route = new URL(url).pathname;
    if (request.method === 'POST') { writes.push(JSON.parse(request.body)); return Response.json({}); }
    if (route.endsWith('/pulls/1')) return Response.json({ state: 'open', head: { sha: options.event.pull_request.head.sha }, base: { sha: base }, changed_files: files.length });
    if (route.endsWith('/files')) return Response.json(files);
    if (route.endsWith('/comments')) return Response.json([]);
    if (route.includes('/contents/')) return Response.json({ encoding: 'base64', content: Buffer.from('# Demo\nKeep this.\nNew instruction.\n').toString('base64') });
    throw new Error(`Unexpected ${route}`);
  };
  return { root, git, path, options, files, writes, fetcher };
}

test('missing API patch uses the merge base and comments only on the added line', async t => {
  const f = await fixture(t);
  assert.deepEqual([...(await reviewDiff(f.options, f)).get(f.path)], [3]);
  const finding = { path: f.path, rule: 'test', question: 'Is it compliant?', expected: true, probability: 0.95 };
  const report = { locations: { findings: [
    { ...finding, line: 2, endLine: 2, text: 'Keep this.' },
    { ...finding, line: 3, endLine: 3, text: 'New instruction.' },
  ] } };
  const result = await publishLocations(report, f.options, f);
  assert.equal(result.outsideDiff, 1);
  assert.equal(result.comments, 1);
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].comments[0].line, 3);
  assert.equal(f.writes[0].commit_id, f.options.event.pull_request.head.sha);
});

test('fallback handles renamed files without treating unchanged lines as additions', async t => {
  const f = await fixture(t);
  const next = 'renamed : [démo].md';
  await rename(join(f.root, f.path), join(f.root, next));
  f.git('add', '.'); f.git('commit', '-m', 'rename');
  f.options.event.pull_request.head.sha = f.git('rev-parse', 'HEAD');
  f.files[0] = { ...f.files[0], status: 'renamed', filename: next, previous_filename: f.path };
  assert.deepEqual([...(await reviewDiff(f.options, f)).get(next)], [3]);
});

test('fallback handles new files with or without a final newline and deletions', async t => {
  const f = await fixture(t);
  for (const [path, content] of [['new.md', 'One\nTwo\n'], ['no-newline.md', 'One\nTwo']]) {
    await writeFile(join(f.root, path), content);
    f.files.push({ filename: path, status: 'added', changes: 2 });
  }
  f.files.push({ filename: 'deleted.md', status: 'removed', changes: 3 });
  f.git('add', '.'); f.git('commit', '-m', 'new files');
  f.options.event.pull_request.head.sha = f.git('rev-parse', 'HEAD');
  const diff = await reviewDiff(f.options, f);
  assert.deepEqual([...diff.get('new.md')], [1, 2]);
  assert.deepEqual([...diff.get('no-newline.md')], [1, 2]);
  assert.deepEqual([...diff.get('deleted.md')], []);
});

test('missing history and wrong checkouts fail explicitly instead of returning a clean review', async t => {
  const f = await fixture(t);
  f.git('checkout', 'main');
  await assert.rejects(reviewDiff(f.options, f), /exact PR HEAD with fetch-depth: 0/);
  f.git('checkout', 'feature');
  const missingBase = { fetcher: async (url, request) => new URL(url).pathname.endsWith('/pulls/1')
    ? Response.json({ state: 'open', head: f.options.event.pull_request.head, base: { sha: 'b'.repeat(40) }, changed_files: 1 })
    : f.fetcher(url, request) };
  await assert.rejects(reviewDiff(f.options, missingBase), /local Git fallback failed/);
});

test('available API patches do not require a local checkout', async t => {
  const f = await fixture(t);
  f.files[0].patch = '@@ -3 +3 @@\n-Old instruction.\n+New instruction.\n';
  const options = { ...f.options, root: '/does-not-exist' };
  assert.deepEqual([...(await reviewDiff(options, f)).get(f.path)], [3]);
});
