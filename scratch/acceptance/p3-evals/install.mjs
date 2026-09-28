// A fresh installation for the P3b evals harnesses (run-all.mjs, ui-shots.mjs): a new TANDEMISE_HOME and
// project behind a short symlink (p0/setup.mjs), the daemon from this checkout's build, and the real
// desktop window (electron-vite dev) with its own user-data-dir and CDP on `port`.
//
// The window reads the folder a native "Choose…" dialog would pick from `<link>/pick-directory.txt`
// (TANDEMISE_TEST_PICK_DIRECTORY), since a native dialog can't be driven over CDP.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(here, '../../..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Stops a previous run's window and daemon behind `link`, if any. */
export async function stopPrevious(link) {
  try { execFileSync('pkill', ['-f', `user-data-dir=${link}/electron`]); } catch { /* none */ }
  if (existsSync(`${link}/env.json`)) { try { process.kill(JSON.parse(readFileSync(`${link}/env.json`, 'utf8')).pid); } catch { /* gone */ } }
  await sleep(1500);
}

/**
 * Builds the installation and launches the window. `daemonEnv` is added to the daemon's environment
 * (the scripted agent's SCRIPTED_* knobs reach every run through it). Returns the real folder, the
 * pick-directory file and `stop()`, which ends the window and the daemon this call started.
 */
export async function freshInstall({ link, port, prefix, daemonEnv = {} }) {
  await stopPrevious(link);
  // Socket paths must stay under macOS's 104-byte limit, so the run lives behind a short symlink.
  const real = join(process.env.ACCEPTANCE_REAL_DIR ?? tmpdir(), `${prefix}-${Date.now().toString(36)}`);
  mkdirSync(real, { recursive: true });
  rmSync(link, { recursive: true, force: true });
  symlinkSync(real, link);

  execFileSync(process.execPath, [join(here, '../p0/setup.mjs'), link], {
    env: { ...process.env, SCRIPTED_STATE_DIR: `${link}/scripted-state`, ...daemonEnv },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const pick = `${link}/pick-directory.txt`;
  writeFileSync(pick, '');
  // A window behind others stops painting, and a screenshot then never returns: keep it rendering while occluded.
  const desktop = spawn('npx', ['electron-vite', 'dev', '--', `--remote-debugging-port=${port}`, `--user-data-dir=${link}/electron`, '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'], {
    cwd: join(repoRoot, 'apps/desktop'),
    env: { ...process.env, TANDEMISE_HOME: `${link}/home`, TANDEMISE_TEST_PICK_DIRECTORY: pick },
    stdio: ['ignore', 'ignore', 'ignore'],
    detached: true,
  });
  desktop.unref();

  const stop = () => {
    try { process.kill(-desktop.pid, 'SIGTERM'); } catch { /* gone */ }
    try { execFileSync('pkill', ['-f', `user-data-dir=${link}/electron`]); } catch { /* none */ }
    try { process.kill(JSON.parse(readFileSync(`${link}/env.json`, 'utf8')).pid); } catch { /* gone */ }
  };
  return { real, pick, desktop, stop };
}
