import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';

const structure = text => JSON.stringify(fromMarkdown(text, {
  extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()],
}), (key, value) => key === 'position' ? undefined : value);

/** Only exempt blank additions proven to preserve Markdown structure and literal values. */
export function classifyWhitespace(sources, units) {
  const unchanged = [], unreviewed = [];
  for (const source of sources) {
    const blanks = units.filter(unit => unit.path === source.path && !unit.text);
    if (!blanks.length) continue;
    const lines = source.content.split(/\r?\n/);
    const removed = new Set(blanks.flatMap(unit => Array.from({length:unit.endLine-unit.line+1}, (_, i) => unit.line+i)));
    let frontmatterEnd = -1;
    if (lines[0] === '---') frontmatterEnd = lines.findIndex((line, i) => i > 0 && /^(---|\.\.\.)$/.test(line));
    const eligible = /\.md$/i.test(source.path) && !source.content.includes('{{')
      && !(lines[0] === '---' && frontmatterEnd < 0)
      && ![...removed].some(line => line <= frontmatterEnd + 1);
    const body = lines.slice(frontmatterEnd + 1).join('\n');
    const without = lines.filter((_, i) => i > frontmatterEnd && !removed.has(i+1)).join('\n');
    const activatesFrontmatter = lines[0] !== '---' && without.split('\n')[0] === '---';
    const safe = eligible && !activatesFrontmatter && structure(body) === structure(without);
    (safe ? unchanged : unreviewed).push(...blanks.map(({path,line,endLine}) => ({path,line,endLine})));
  }
  return {unchanged, unreviewed};
}
