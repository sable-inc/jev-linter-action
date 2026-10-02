import { readFileSync, readdirSync } from 'node:fs';

/** Preserve license text and notices; an SPDX identifier cannot replace copyright notices. */
export function dependencyNotices(root, packages) {
  return Object.entries(packages).filter(([path]) => path.startsWith('node_modules/')).sort(([a], [b]) => a.localeCompare(b)).flatMap(([path, locked]) => {
    const dir = new URL(`${path}/`, root);
    let metadata;
    try { metadata = JSON.parse(readFileSync(new URL('package.json', dir), 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT' && (locked.dev || locked.optional)) return [];
      throw new Error(`Cannot read dependency metadata at ${path}/package.json: ${error.message}`);
    }
    try {
      const names = readdirSync(dir).filter(name => /^(licen[cs]e|copying|notice)(?:[._-].*)?$/i.test(name)).sort();
      if (!names.length) throw new Error(`no license/notice text found (declared license: ${metadata.license ?? 'unspecified'}); add the required text before bundling`);
      return [`${metadata.name}@${metadata.version}\n${names.map(name => readFileSync(new URL(name, dir), 'utf8')).join('\n')}`];
    } catch (error) { throw new Error(`Cannot bundle notices for ${path}: ${error.message}`); }
  }).join('\n\n');
}
