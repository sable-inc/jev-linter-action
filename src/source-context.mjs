// Context selection is deterministic and bounded; it is not a whole-agent consistency check.
const clip = (text, size, anchor = 0) => {
  const start = Math.min(Math.max(0, text.length - size), Math.max(0, anchor - Math.floor(size / 3)));
  return text.slice(start, start + size);
};

/** Decode JSON strings so compiled instructions remain usable alongside Markdown sources. */
export function contextIndex(files) {
  const entries = [];
  for (const file of files) {
    let value;
    try { value = /\.json$/i.test(file.path) ? JSON.parse(file.content) : file.content; }
    catch { entries.push(file); continue; }
    if (value === null || typeof value !== 'object') {
      entries.push({ ...file, content: typeof value === 'string' ? value : file.content });
      continue;
    }
    const pending = [{ value, path: file.path }];
    while (pending.length) {
      const {value, path} = pending.pop();
      if (typeof value === 'string') entries.push({path, content: value});
      else if (value && typeof value === 'object') {
        // Reverse the stack insertion to retain document order without recursion.
        const children = Object.entries(value);
        for (let i = children.length - 1; i >= 0; i--) {
          const [key, child] = children[i];
          pending.push({value: child, path: `${path}/${key}`});
        }
      }
    }
  }
  return entries;
}

export function passageContext(sources, entries, units) {
  let truncated = false;
  const local = units.map(unit => {
    const lines = sources.find(source => source.path === unit.path).content.split(/\r?\n/);
    let heading = unit.line - 1;
    while (heading >= 0 && !/^#{1,6}\s/.test(lines[heading])) heading--;
    const start = Math.max(0, heading, unit.line - 12);
    const excerpt = clip(lines.slice(start, unit.endLine + 12).join('\n'), 2400,
      lines.slice(start, unit.line - 1).join('\n').length);
    truncated ||= start > 0 || unit.endLine + 12 < lines.length || excerpt.length < lines.slice(start, unit.endLine + 12).join('\n').length;
    return `${unit.path} — enclosing source (${heading >= 0 ? lines[heading] : 'document'}):\n${excerpt}`;
  });
  const targetText = units.map(unit => unit.text).join('\n');
  const words = new Set(targetText.toLowerCase().match(/[\p{L}\p{N}_-]{4,}/gu) ?? []);
  const ranked = entries.map((entry, index) => {
    const match = units.map(unit => entry.content.indexOf(unit.text)).find(offset => offset >= 0);
    const shared = /(?:^|\/)(?:instructions|system|system_prompt|behavior|personality)(?:\/|\.|$)/i.test(entry.path)
      || (!entry.path.endsWith('.json') && !entry.path.includes('.json/'));
    const tokens = new Set(entry.content.toLowerCase().match(/[\p{L}\p{N}_-]{4,}/gu) ?? []);
    const overlap = [...words].filter(word => tokens.has(word)).length;
    return { ...entry, index, match, shared, overlap };
  });
  const selected = [], seen = new Set();
  function take(candidates, budget) {
    for (const entry of candidates) {
      if (seen.has(entry.index) || budget <= 0) continue;
      const text = clip(entry.content, Math.min(2400, budget), entry.match ?? 0);
      truncated ||= text.length < entry.content.length;
      selected.push(`${entry.path}:\n${text}`);
      seen.add(entry.index);
      budget -= text.length;
    }
  }
  // Reserve space for both common behavioral guidance and the compiled target's surroundings.
  take(ranked.filter(e => e.shared).sort((a, b) => b.overlap - a.overlap), 6000);
  take(ranked.filter(e => e.match !== undefined), 4000);
  take(ranked.filter(e => e.overlap > 0).sort((a, b) => b.overlap - a.overlap), 2000);
  truncated ||= seen.size < entries.length;
  return { text: [...local, `Selected built/shared context${truncated ? ' (not exhaustive)' : ''}:`, ...selected].join('\n\n'),
    truncated };
}
