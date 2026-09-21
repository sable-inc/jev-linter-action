import { readFileSync } from 'node:fs';
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
process.exit(build.status ?? 1);
