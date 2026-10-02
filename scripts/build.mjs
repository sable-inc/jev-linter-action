import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const root = new URL('../', import.meta.url);
const required = readFileSync(new URL('.bun-version', root), 'utf8').trim();
const version = spawnSync('bun', ['--version'], { encoding: 'utf8' });
if (version.status !== 0 || version.stdout.trim() !== required) {
  console.error(`Build requires Bun ${required} from .bun-version; found ${version.stdout?.trim() || 'no working Bun installation'}. Install the pinned version and rerun npm run build.`);
  process.exit(1);
}

const build = spawnSync('bun', ['build', 'src/main.mjs', '--target=node', '--outfile=dist/main.mjs'], {
  cwd: root,
  stdio: 'inherit',
});
if (build.error) console.error(build.error.message);
if (build.status === 0) {
  const lock = JSON.parse(readFileSync(new URL('package-lock.json', root), 'utf8'));
  const notices = Object.keys(lock.packages).filter(path => path.startsWith('node_modules/')).sort().map(path => {
    const dir = new URL(`${path}/`, root);
    const metadata = JSON.parse(readFileSync(new URL('package.json', dir), 'utf8'));
    const license = ['LICENSE', 'LICENSE.md', 'license', 'license.md', 'LICENSE-MIT', 'LICENSE.txt'].map(name => new URL(name, dir)).find(existsSync);
    if (!license) throw new Error(`Missing license text for ${metadata.name}`);
    return `${metadata.name}@${metadata.version}\n${readFileSync(license, 'utf8')}`;
  });
  writeFileSync(new URL('dist/third-party-licenses.txt', root), notices.join('\n\n'));
}
process.exit(build.status ?? 1);
