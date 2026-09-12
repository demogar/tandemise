#!/usr/bin/env node
/**
 * Builds every app icon artefact from `apps/desktop/build/icon.svg`.
 *
 * Electron does the rasterizing because it is already a dependency and it is
 * the same renderer that will draw the app - no image toolchain to install, and
 * no chance of the icon looking different from the UI it belongs to. macOS
 * `iconutil` assembles the .icns.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const buildDir = join(root, 'apps/desktop/build');
const work = join(buildDir, '.iconwork');
const resources = join(root, 'apps/desktop/resources');

const run = (cmd, args, opts = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit', ...opts });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
    child.on('error', reject);
  });

rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });

/** Photographs an SVG at `size`² on a transparent background. */
async function rasterize(svgPath, size, outPath) {
  const svg = readFileSync(svgPath, 'utf8');
  const shot = join(work, 'shot.cjs');
  writeFileSync(shot, `
const { app, BrowserWindow } = require('electron');
const { writeFileSync } = require('node:fs');
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: ${size}, height: ${size}, show: false, frame: false,
    // Transparent so the artwork's own shape is the icon's shape.
    transparent: true, backgroundColor: '#00000000',
    webPreferences: { offscreen: true },
  });
  const html = '<style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}svg{display:block;width:${size}px;height:${size}px}</style>' +
    ${JSON.stringify(svg)};
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await new Promise((r) => setTimeout(r, 400));
  writeFileSync(process.argv[2], (await win.webContents.capturePage()).toPNG());
  app.exit(0);
});
`);
  await run(join(root, 'node_modules/.bin/electron'), [shot, outPath], { cwd: root });
}

const master = join(work, 'icon-1024.png');
await rasterize(join(buildDir, 'icon.svg'), 1024, master);

// The sizes macOS actually asks for, each at 1x and 2x.
const iconset = join(work, 'icon.iconset');
mkdirSync(iconset, { recursive: true });
for (const size of [16, 32, 128, 256, 512]) {
  await run('sips', ['-z', String(size), String(size), master, '--out', join(iconset, `icon_${size}x${size}.png`)], { stdio: 'ignore' });
  await run('sips', ['-z', String(size * 2), String(size * 2), master, '--out', join(iconset, `icon_${size}x${size}@2x.png`)], { stdio: 'ignore' });
}
await run('iconutil', ['-c', 'icns', iconset, '-o', join(buildDir, 'icon.icns')]);

// A plain PNG too: Linux/Windows builds and the dev dock icon use it.
await run('sips', ['-z', '512', '512', master, '--out', join(buildDir, 'icon.png')], { stdio: 'ignore' });
// The menu-bar mark. Rendered at its real pixel sizes rather than downscaled,
// because a 22px template image has no pixels to spare.
await rasterize(join(buildDir, 'tray.svg'), 22, join(resources, 'trayTemplate.png'));
await rasterize(join(buildDir, 'tray.svg'), 44, join(resources, 'trayTemplate@2x.png'));

rmSync(work, { recursive: true, force: true });
console.log('✓ wrote apps/desktop/build/icon.icns, icon.png, and resources/trayTemplate*.png');
