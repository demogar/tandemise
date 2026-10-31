#!/usr/bin/env node
// Writes every file derived from src/tokens.ts: css/tokens.css, css/tailwind.css
// and the small logo SVGs in assets/. The derived files are committed, so a
// reader (or a site that copies a file) never needs a build to see them, and a
// review shows exactly what a token change does to the CSS.
//
//   npm run -w @tandemise/design build && npm run -w @tandemise/design emit
//   node packages/design/scripts/emit.mjs --check    fails if any file is stale (check:design runs this)
//
// Reads the compiled module in dist/, so build first.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkg = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(pkg, 'dist/index.js');
if (!existsSync(dist)) {
  console.error('@tandemise/design: dist/ is missing - run `npm run build` first');
  process.exit(1);
}
const { tokensCss, tailwindThemeCss, logoSvg, LOGO_COLORS, palette } = await import(dist);
const { GENERATED_NOTE } = await import(join(pkg, 'dist/css.js'));

const hex = (colours) => Object.fromEntries(Object.entries(colours).map(([part, name]) => [part, palette[name]]));
const svgNote = (what) => `<!--\n  ${what}\n  ${GENERATED_NOTE}\n-->\n`;

const adaptive = (() => {
  // Each part's colour switches with the viewer's scheme; the light colours are the default.
  const { onLight, onDark } = LOGO_COLORS;
  const rule = (c) => `.lead{stroke:${palette[c.lead]}}.trail{stroke:${palette[c.trail]}}.axle{stroke:${palette[c.axle]}}`;
  return logoSvg(hex(onLight), { style: `${rule(onLight)}@media (prefers-color-scheme: dark){${rule(onDark)}}` });
})();

const files = {
  'css/tokens.css': tokensCss(),
  'css/tailwind.css': tailwindThemeCss(GENERATED_NOTE),
  'assets/logo-mark.svg': svgNote('The Tandemise mark, following the viewer\'s light or dark scheme.') + adaptive,
  'assets/logo-mark-on-dark.svg': svgNote('The Tandemise mark for a dark background: mint lead wheel, sage trailing wheel, lichen axle.') + logoSvg(hex(LOGO_COLORS.onDark)),
  'assets/logo-mark-on-light.svg': svgNote('The Tandemise mark for a light background: indigo lead wheel, slate trailing wheel, lichen axle.') + logoSvg(hex(LOGO_COLORS.onLight)),
  // A macOS template image is recoloured by the system and must be drawn in black only.
  // The desktop's menu-bar icon (resources/trayTemplate*.png) is rasterised from it by `npm run icons`.
  'assets/logo-mark-template.svg':
    svgNote('The Tandemise mark as a macOS template image: black only, the system recolours it.') +
    logoSvg({ lead: '#000', trail: '#000', axle: '#000' }),
};

const check = process.argv.includes('--check');
const stale = [];
for (const [path, content] of Object.entries(files)) {
  const target = join(pkg, path);
  const current = existsSync(target) ? readFileSync(target, 'utf8') : null;
  if (current === content) continue;
  if (check) stale.push(relative(process.cwd(), target));
  else {
    writeFileSync(target, content);
    console.log(`wrote ${relative(process.cwd(), target)}`);
  }
}
if (stale.length) {
  console.error(`@tandemise/design: stale - regenerate with \`npm run -w @tandemise/design emit\`:\n  ${stale.join('\n  ')}`);
  process.exit(1);
}
if (check) console.log(`design-emit-ok (${Object.keys(files).length} derived files fresh)`);
