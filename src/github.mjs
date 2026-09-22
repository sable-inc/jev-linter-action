import { digest } from './locations.mjs';

const encodePath = path => path.split('/').map(encodeURIComponent).join('/');
const plain = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('@', '&#64;');
const quoted = value => value.split('\n').map(line => `> ${plain(line)}`).join('\n');
export const sourceLink = (repo, sha, finding) => `https://github.com/${repo}/blob/${sha}/${encodePath(finding.path)}#L${finding.line}-L${finding.endLine}`;

export function rightLines(patch = '') {
  const result = new Set();
  let line;
  for (const text of patch.split('\n')) {
    const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (match) { line = Number(match[1]); continue; }
    if (line === undefined) continue;
    if (text.startsWith('+') || text.startsWith(' ')) result.add(line++);
    else if (!text.startsWith('-') && !text.startsWith('\\')) line = undefined;
  }
  return result;
}

export function findingBody(finding, repo, sha) {
  return `**Jev: ${plain(finding.rule)}** — possible rule violation (localization probability ${finding.probability.toFixed(2)}).\n\nRule: ${plain(finding.question)}\n\nRequired answer: **${finding.expected ? 'yes' : 'no'}**. Jev identified this passage as contributing to the failed check in context.\n\n${quoted(finding.text)}\n\n[Source lines ${finding.line}–${finding.endLine}](${sourceLink(repo, sha, finding)})\n\n${finding.contextTruncated ? 'Localization used cropped context. ' : ''}This is a probabilistic finding, not verified ground truth. Review the surrounding instructions and any intentional override before changing it.`;
}

/** Only same-repository pull_request runs may write; all anchors are rechecked at PR HEAD. */
export async function publishLocations(report, { event, eventName, repo, token, reviewId, maxComments = 5 }, { fetcher = fetch } = {}) {
  if (eventName !== 'pull_request' || !event?.pull_request) return { skipped: 'Inline reviews require a pull_request event', comments: 0 };
  const pr = event.pull_request;
  if (pr.head?.repo?.full_name !== repo || pr.base?.repo?.full_name !== repo) throw new Error('Review publishing requires a same-repository PR');
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !Number.isInteger(pr.number) || pr.number < 1 || !/^[a-f0-9]{40}$/.test(pr.head.sha)) throw new Error('Invalid GitHub PR context');
  if (!token || !reviewId || reviewId.length > 128) throw new Error('github-token and review-id are required to post comments');
  if (!Number.isInteger(maxComments) || maxComments < 0 || maxComments > 20) throw new Error('max-comments must be 0–20');
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
  };
  await current();
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
  const files = await pages(`/pulls/${pr.number}/files`);
  const diffs = new Map(files.map(file => [file.filename, rightLines(file.patch)]));
  const existing = await pages(`/pulls/${pr.number}/comments`);
  const existingSummaries = await pages(`/issues/${pr.number}/comments`);
  const prefix = `jev-location:${digest(reviewId).slice(0, 16)}:${pr.head.sha}`;
  const alreadyPosted = existing.filter(comment => comment.body?.includes(`<!-- ${prefix}:`)).length;
  const contents = new Map();
  const verified = [];
  let unmapped = 0, comments = 0;
  for (const finding of report.locations.findings) {
    if (!contents.has(finding.path)) {
      const file = await api(`/contents/${encodePath(finding.path)}?ref=${pr.head.sha}`, 'GET', undefined, true);
      // GitHub omits inline content for large files. Preserve the finding in the report.
      if (!file || file.encoding !== 'base64' || typeof file.content !== 'string') { contents.set(finding.path, null); unmapped++; continue; }
      contents.set(finding.path, Buffer.from(file.content, 'base64').toString('utf8').split(/\r?\n/));
    }
    if (!contents.get(finding.path) || contents.get(finding.path).slice(finding.line - 1, finding.endLine).join('\n').trim() !== finding.text) { unmapped++; continue; }
    verified.push(finding);
    const anchor = [...(diffs.get(finding.path) ?? [])].find(line => line >= finding.line && line <= finding.endLine);
    if (!anchor || alreadyPosted + comments >= maxComments) continue;
    const marker = `<!-- ${prefix}:${finding.id} -->`;
    if (existing.some(comment => comment.body?.includes(marker))) continue;
    await current();
    await api(`/pulls/${pr.number}/comments`, 'POST', { commit_id: pr.head.sha, path: finding.path, line: anchor, side: 'RIGHT', body: `${marker}\n${findingBody(finding, repo, pr.head.sha)}` });
    comments++;
  }
  const rows = verified.map(f => `- [${plain(f.path)}:${f.line}–${f.endLine}](${sourceLink(repo, pr.head.sha, f)}) — **${plain(f.rule)}**, ${f.probability.toFixed(2)}`);
  if (!rows.length) rows.push('No source passage could be both confidently localized and verified at PR HEAD. The original failed checks still require review.');
  const footer = `Jev remains ${report.passed ? 'passing' : 'failing'}; localization never changes its verdict. ${report.locations.requests} localization requests; ${report.locations.omittedCandidates} candidate passages omitted by the request limit; ${report.locations.unlocatedGroups} failed contexts had no unambiguous source match; ${unmapped} anchors could not be verified at PR HEAD.\n\nInline comments are limited to diff lines and at most ${maxComments} per review-id/head. Other findings link directly to source. Findings are probabilistic, not ground truth.`;
  const pagesOfRows = [''];
  for (const row of rows) {
    if (row.length > 50_000) throw new Error('Source link exceeds the GitHub summary size budget');
    if (pagesOfRows.at(-1).length + row.length + 1 > 50_000) pagesOfRows.push('');
    pagesOfRows[pagesOfRows.length - 1] += row + '\n';
  }
  for (const [index, rows] of pagesOfRows.entries()) {
    const marker = `<!-- ${prefix}:summary${index ? `-${index + 1}` : ''} -->`;
    if (existingSummaries.some(comment => comment.body?.includes(marker))) continue;
    const body = `${marker}\n### Jev source findings: ${plain(reviewId)} (${index + 1}/${pagesOfRows.length})\n\n${rows}\n${footer}`;
    await current();
    await api(`/issues/${pr.number}/comments`, 'POST', { body });
  }
  return { comments, verified: verified.length, unmapped };
}
