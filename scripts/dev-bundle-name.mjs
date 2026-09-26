#!/usr/bin/env node
/**
 * Names the development Electron bundle "Tandemise" on macOS.
 *
 * `electron-vite dev` runs the unpackaged `node_modules/electron/dist/Electron.app`.
 * `app.setName` fixes the menu bar, but the Dock and the app switcher read the
 * name from the bundle's Info.plist (`CFBundleName` / `CFBundleDisplayName`),
 * which cannot change at runtime. So after every install this script writes
 * the name into that plist and swaps the bundle icon for ours. Packaged builds
 * do not need it: they get `productName` from `apps/desktop/package.json`.
 *
 * Runs from the root `postinstall`, and by hand with `npm run dev:bundle-name`.
 * It is idempotent, a no-op off macOS or when the bundle is missing (CI,
 * `--ignore-scripts`), and it never fails the install.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, utimesSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const NAME = 'Tandemise';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const ourIcon = join(root, 'apps/desktop/build/icon.icns');

/** npm workspaces hoist electron to the root, but a version clash can keep it under the app. */
const candidates = [
  join(root, 'node_modules/electron/dist/Electron.app'),
  join(root, 'apps/desktop/node_modules/electron/dist/Electron.app'),
];

function plistGet(plist, key) {
  try {
    return execFileSync('plutil', ['-extract', key, 'raw', '-o', '-', plist], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined;
  }
}

function signatureValid(app) {
  try {
    execFileSync('codesign', ['--verify', '--deep', app], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function patch(app) {
  const plist = join(app, 'Contents/Info.plist');
  if (!existsSync(plist)) return 'no Info.plist';

  const iconFile = plistGet(plist, 'CFBundleIconFile') ?? 'electron.icns';
  const bundleIcon = join(app, 'Contents/Resources', iconFile.endsWith('.icns') ? iconFile : `${iconFile}.icns`);
  const needsName =
    plistGet(plist, 'CFBundleName') !== NAME || plistGet(plist, 'CFBundleDisplayName') !== NAME;
  const needsIcon =
    existsSync(ourIcon) &&
    existsSync(bundleIcon) &&
    !readFileSync(ourIcon).equals(readFileSync(bundleIcon));
  if (!needsName && !needsIcon) return 'already named';

  // Editing the bundle breaks a valid signature; Apple silicon will not launch
  // it then, so re-sign ad hoc - but only if it was valid to begin with.
  const wasSigned = signatureValid(app);

  if (needsName) {
    for (const key of ['CFBundleName', 'CFBundleDisplayName']) {
      execFileSync('plutil', ['-replace', key, '-string', NAME, plist], { stdio: 'ignore' });
    }
  }
  if (needsIcon) copyFileSync(ourIcon, bundleIcon);
  if (wasSigned && !signatureValid(app)) {
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'ignore' });
  }
  // A fresh mtime tells Launch Services to re-read the bundle instead of its cache.
  const now = new Date();
  utimesSync(app, now, now);
  return 'renamed';
}

if (process.platform === 'darwin') {
  for (const app of candidates) {
    if (!existsSync(app)) continue;
    try {
      const result = patch(app);
      if (result === 'renamed') console.log(`dev-bundle-name: ${app} now shows as ${NAME}`);
    } catch (error) {
      console.log(`dev-bundle-name: skipped ${app} (${error instanceof Error ? error.message : error})`);
    }
  }
}
process.exit(0);
