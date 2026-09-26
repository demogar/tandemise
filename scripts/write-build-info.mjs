// Writes `apps/daemon/dist/build-info.json` with the short git commit the
// daemon was just compiled from. The daemon reads it at startup and reports it
// as `daemonBuild` on `GET /v1/system`, next to its version, so Settings → About
// can say which code is actually running. Runs at the end of `npm run build`.
//
// The desktop app gets the same value through electron-vite `define`
// (apps/desktop/electron.vite.config.ts); both fall back to `dev` when git is
// not available (a tarball, a CI checkout without history).
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function shortCommit() {
  try {
    const sha = execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return /^[0-9a-f]{4,40}$/.test(sha) ? sha : 'dev';
  } catch {
    return 'dev';
  }
}

const out = join(root, 'apps/daemon/dist/build-info.json');
mkdirSync(dirname(out), { recursive: true });
const build = shortCommit();
writeFileSync(out, JSON.stringify({ build }, null, 2) + '\n');
console.log(`build-info: daemon build ${build}`);
