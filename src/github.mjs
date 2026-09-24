import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { digest } from './locations.mjs';

const encodePath = path => path.split('/').map(encodeURIComponent).join('/');
const plain = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('@', '&#64;');
const quoted = value => value.split('\n').map(line => `> ${plain(line)}`).join('\n');
export const sourceLink = (repo, sha, finding) => `https://github.com/${repo}/blob/${sha}/${encodePath(finding.path)}#L${finding.line}-L${finding.endLine}`;

export const findingFingerprint = finding => digest(JSON.stringify([finding.path, finding.rule, finding.question, finding.expected, finding.text])).slice(0, 24);

export function rightLines(patch = '') {
  const result = new Set();
  let line;
  for (const text of patch.split('\n')) {
    const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (match) { line = Number(match[1]); continue; }
    if (line === undefined) continue;
    if (text.startsWith('+')) result.add(line++);
    else if (text.startsWith(' ')) line++;
    else if (!text.startsWith('-') && !text.startsWith('\\')) line = undefined;
  }
  return result;
}

export function findingBody(finding, repo, sha) {
  return `**Jev: ${plain(finding.rule)}** — possible rule violation (localization probability ${finding.probability.toFixed(2)}).\n\nRule: ${plain(finding.question)}\n\nRequired answer: **${finding.expected ? 'yes' : 'no'}**. Jev identified this passage as a possible violation in context.\n\n${quoted(finding.text)}\n\n[Source lines ${finding.line}–${finding.endLine}](${sourceLink(repo, sha, finding)})\n\n${finding.contextTruncated ? 'Localization used cropped context. ' : ''}This is a probabilistic finding, not verified ground truth. Review the surrounding instructions and any intentional override before changing it.`;
}

function reviewClient({ event, eventName, repo, token }, { fetcher = fetch } = {}) {
  if (eventName !== 'pull_request' || !event?.pull_request) return null;
  const pr = event.pull_request;
  if (pr.head?.repo?.full_name !== repo || pr.base?.repo?.full_name !== repo) throw new Error('Review publishing requires a same-repository PR');
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !Number.isInteger(pr.number) || pr.number < 1 || !/^[a-f0-9]{40}$/.test(pr.head.sha)) throw new Error('Invalid GitHub PR context');
  if (!token) throw new Error('github-token is required');
  const base = `https://api.github.com/repos/${repo}`;
  const api = async (path, method = 'GET', body, allowMissing = false) => {
    const response = await fetcher(`${base}${path}`, { method, headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' }, ...(body ? { body: JSON.stringify(body) } : {}), redirect: 'error', signal: AbortSignal.timeout(30_000) });
    if (response.status === 404 && allowMissing) return null;
    if (!response.ok) throw new Error(`GitHub review API returned HTTP ${response.status}`);
    try { return await response.json(); } catch { throw new Error('GitHub returned invalid review JSON'); }
  };
  const current = async () => {
    const live = await api(`/pulls/${pr.number}`);
    if (live.head?.sha !== pr.head.sha || live.state !== 'open') throw new Error('PR changed or closed; refusing to publish stale findings');
    return live;
  };
  const pages = async path => {
    const all = [];
    for (let page = 1; page <= 30; page++) {
      const items = await api(`${path}?per_page=100&page=${page}`);
      if (!Array.isArray(items)) throw new Error('Invalid GitHub collection');
      all.push(...items);
      if (items.length < 100) return all;
    }
    throw new Error('GitHub review pagination limit exceeded');
  };
  return { pr, api, current, pages };
}

const exec = promisify(execFile);

// Compare committed blobs so renames preserve their unchanged lines and Git
// attributes cannot run external diff/textconv commands on the checked-out PR.
async function fileDiffs(files, options, pr, live) {
  const diffs = new Map();
  let mergeBase;
  const git = async args => (await exec('git', args, {
    cwd: options.root, encoding: 'utf8', timeout: 30_000, maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' },
  })).stdout;
  for (const file of files) {
    if (typeof file.patch === 'string' || file.changes === 0 || file.status === 'removed' || file.status === 'deleted') {
      diffs.set(file.filename, rightLines(file.patch));
      continue;
    }
    if (!options.root) { diffs.set(file.filename, null); continue; }
    try {
      if (!mergeBase) {
        const base = live.base?.sha ?? pr.base.sha;
        if (!/^[a-f0-9]{40}$/.test(base ?? '')) throw new Error('Missing PR base SHA');
        if ((await git(['rev-parse', 'HEAD'])).trim() !== pr.head.sha) throw new Error('Checkout is not PR HEAD');
        mergeBase = (await git(['merge-base', base, pr.head.sha])).trim();
        if (!/^[a-f0-9]{40}$/.test(mergeBase)) throw new Error('Invalid merge base');
      }
      const after = `${pr.head.sha}:${file.filename}`;
      if (file.status === 'added') {
        const content = await git(['show', after]);
        const count = content === '' ? 0 : content.split('\n').length - Number(content.endsWith('\n'));
        diffs.set(file.filename, new Set(Array.from({ length: count }, (_, i) => i + 1)));
      } else {
        const before = `${mergeBase}:${file.previous_filename ?? file.filename}`;
        const patch = await git(['diff', '--no-ext-diff', '--no-textconv', '--text', '--unified=0', before, after, '--']);
        diffs.set(file.filename, rightLines(patch));
      }
    } catch {
      throw new Error(`PR patch unavailable for ${file.filename}; local Git fallback failed. Check out the exact PR HEAD with fetch-depth: 0 (including the PR base).`);
    }
  }
  return diffs;
}

export async function reviewDiff(options, deps) {
  const client = reviewClient(options, deps);
  if (!client) return new Map();
  const live = await client.current();
  if (live.changed_files > 3000) throw new Error('PR diff exceeds the GitHub 3000-file limit; cannot review complete additions');
  const files = await client.pages(`/pulls/${client.pr.number}/files`);
  if (Number.isInteger(live.changed_files) && files.length !== live.changed_files) throw new Error('Incomplete PR diff: changed-file count does not match returned files');
  return fileDiffs(files, options, client.pr, live);
}

/** Only same-repository pull_request runs may write; all anchors are rechecked at PR HEAD. */
export async function publishLocations(report, options, deps) {
  const client = reviewClient(options, deps);
  if (!client) return { skipped: 'Inline reviews require a pull_request event', comments: 0 };
  const { repo, reviewId, maxComments = 5 } = options;
  if (!reviewId || reviewId.length > 128) throw new Error('review-id is required to post comments');
  if (!Number.isInteger(maxComments) || maxComments < 0 || maxComments > 20) throw new Error('max-comments must be 0–20');
  if (!report.locations.findings.length) return { comments: 0, verified: 0, unmapped: 0, outsideDiff: 0, duplicates: 0 };
  const { pr, api, current, pages } = client;
  const live = await current();
  const files = await pages(`/pulls/${pr.number}/files`);
  const paths = new Set(report.locations.findings.map(finding => finding.path));
  const diffs = await fileDiffs(files.filter(file => paths.has(file.filename)), options, pr, live);
  const existing = await pages(`/pulls/${pr.number}/comments`);
  const prefix = `jev-location:${digest(reviewId).slice(0, 16)}`;
  const headMarker = `<!-- ${prefix}:head:${pr.head.sha} -->`;
  const alreadyPosted = existing.filter(comment => comment.body?.includes(headMarker)).length;
  const pending = [];
  const seen = new Set();
  const contents = new Map();
  const verified = [];
  let unmapped = 0, outsideDiff = 0, duplicates = 0;
  for (const finding of report.locations.findings) {
    const id = findingFingerprint(finding);
    const marker = `<!-- ${prefix}:finding:${id} -->`;
    if (seen.has(id) || existing.some(comment => comment.body?.includes(marker))) { duplicates++; continue; }
    seen.add(id);
    if (!contents.has(finding.path)) {
      const file = await api(`/contents/${encodePath(finding.path)}?ref=${pr.head.sha}`, 'GET', undefined, true);
      // GitHub omits inline content for large files. Preserve the finding in the report.
      if (!file || file.encoding !== 'base64' || typeof file.content !== 'string') { contents.set(finding.path, null); unmapped++; continue; }
      contents.set(finding.path, Buffer.from(file.content, 'base64').toString('utf8').split(/\r?\n/));
    }
    if (!contents.get(finding.path) || contents.get(finding.path).slice(finding.line - 1, finding.endLine).join('\n').trim() !== finding.text) { unmapped++; continue; }
    verified.push(finding);
    const anchor = [...(diffs.get(finding.path) ?? [])].find(line => line >= finding.line && line <= finding.endLine);
    if (!anchor) { outsideDiff++; continue; }
    if (alreadyPosted + pending.length >= maxComments) continue;
    pending.push({ path: finding.path, line: anchor, side: 'RIGHT', body: `${marker}\n${headMarker}\n${findingBody(finding, repo, pr.head.sha)}` });
  }
  if (pending.length) {
    await current();
    await api(`/pulls/${pr.number}/reviews`, 'POST', {
      commit_id: pr.head.sha, event: 'COMMENT',
      body: 'Jev flagged the following source passages for review against the named rules.',
      comments: pending,
    });
  }
  return { comments: pending.length, verified: verified.length, unmapped, outsideDiff, duplicates };

}
