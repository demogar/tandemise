// Holds the desktop app to its design system (docs/DESIGN_SYSTEM.md).
//
// The system has two token layers - `palette.css` (hues) and `theme.css` (roles)
// - and the rule that makes it a contract rather than a suggestion: colour
// enters the app only through them. This check fails the build when:
//
//   1. a colour literal (hex, rgb, hsl, oklch...) appears outside palette.css
//   2. a palette primitive is read anywhere but theme.css
//   3. a `var(--token)` names a token nobody defines (a typo renders as nothing)
//   4. a `var()` carries a fallback, which is how those typos stay hidden
//   5. `light-dark()` is handed something other than colours (Chromium drops
//      the whole declaration, silently)
//   6. the app icon uses a colour that is not in the palette, or the menu-bar
//      template image uses anything but black
//   7. the main process's pre-paint window colours drift from the palette
//
//   node scripts/check-design-system.mjs
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const desktop = join(root, 'apps/desktop');
const styles = join(desktop, 'src/renderer/src/styles');
const PALETTE = join(styles, 'palette.css');
const THEME = join(styles, 'theme.css');

const problems = [];
const fail = (file, line, message) => problems.push(`${relative(root, file)}${line ? `:${line}` : ''}  ${message}`);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(css|tsx?)$/.test(name)) out.push(path);
  }
  return out;
}

/** Comments are prose - a hex value quoted in one is not a colour in use. */
const stripComments = (text, file) =>
  file.endsWith('.css')
    ? text.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '))
    : text.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' ')).replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

const lineOf = (text, index) => text.slice(0, index).split('\n').length;

// ------------------------------------------------------------------ palette

const paletteText = stripComments(readFileSync(PALETTE, 'utf8'), PALETTE);
const palette = new Map(); // --name -> #hex
for (const m of paletteText.matchAll(/(--[a-z0-9-]+)\s*:\s*(#[0-9a-f]{6})\s*;/gi)) palette.set(m[1], m[2].toLowerCase());
if (palette.size === 0) fail(PALETTE, 0, 'defines no palette colours');
for (const m of paletteText.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
  if (!/^#[0-9a-f]{6}$/i.test(m[2].trim())) fail(PALETTE, lineOf(paletteText, m.index), `${m[1]} must be a 6-digit hex value, not "${m[2].trim()}"`);
}
const paletteValues = new Set(palette.values());

// ------------------------------------------------------------ renderer code

const files = [...walk(join(desktop, 'src'))];
const defined = new Set();
const uses = [];

const COLOUR_LITERAL = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/gi;

for (const file of files) {
  const text = stripComments(readFileSync(file, 'utf8'), file);
  const isCss = file.endsWith('.css');

  for (const m of text.matchAll(/(?:^|[\s;{'"])(--[a-z0-9-]+)\s*:/g)) defined.add(m[1]);

  // 1. Colour literals. In TS a hex is only a colour when it is a whole string
  // (`'#0d0e1e'`); `#/missions` and `#root` are routes and selectors.
  if (file !== PALETTE && !file.endsWith(join('src/shared/brand.ts'))) {
    const pattern = isCss ? COLOUR_LITERAL : /['"`]#[0-9a-f]{3,8}['"`]|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/gi;
    for (const m of text.matchAll(pattern)) {
      fail(file, lineOf(text, m.index), `colour literal "${m[0]}" - use a role from theme.css`);
    }
  }

  for (const m of text.matchAll(/var\(\s*(--[a-z0-9-]+)(\$\{)?\s*(,)?/gi)) {
    uses.push({ file, line: lineOf(text, m.index), name: m[1], dynamic: Boolean(m[2]) });
    // 4. Fallbacks.
    if (m[3]) fail(file, lineOf(text, m.index), `var(${m[1]}, …) has a fallback - tokens are always defined, so it only hides typos`);
  }

  // 5. light-dark() takes two colours.
  for (const m of text.matchAll(/light-dark\(\s*([\d.]+(?:%|px|em|rem)?)\s*,/g)) {
    fail(file, lineOf(text, m.index), `light-dark(${m[1]}, …) - light-dark() accepts colours only`);
  }
}

for (const use of uses) {
  // 2. Primitives stay behind the semantic layer.
  if (palette.has(use.name) && use.file !== THEME && use.file !== PALETTE) {
    fail(use.file, use.line, `${use.name} is a palette primitive - read a role from theme.css instead`);
  }
  // 3. Undefined tokens. `var(--status-${tone})` is checked by its prefix.
  if (use.dynamic) {
    if (![...defined].some((name) => name.startsWith(use.name))) fail(use.file, use.line, `no token starts with ${use.name}`);
  } else if (!defined.has(use.name)) {
    fail(use.file, use.line, `${use.name} is not defined by any stylesheet`);
  }
}

// --------------------------------------------------------------------- logo

const svgColours = (file) => {
  const text = readFileSync(file, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  return [...text.matchAll(/(?:fill|stroke|stop-color)="([^"]+)"/g)].map((m) => m[1]).filter((v) => v !== 'none' && !v.startsWith('url('));
};

const ICON = join(desktop, 'build/icon.svg');
for (const colour of svgColours(ICON)) {
  if (!paletteValues.has(colour.toLowerCase())) fail(ICON, 0, `"${colour}" is not a palette colour`);
}

// A macOS template image is recoloured by the system and must be pure black.
const TRAY = join(desktop, 'build/tray.svg');
for (const colour of svgColours(TRAY)) {
  if (!/^#0{3}(0{3})?$/.test(colour)) fail(TRAY, 0, `"${colour}" - a template image must be drawn in #000 only`);
}

// ------------------------------------------------------ pre-paint colours

const BRAND = join(desktop, 'src/shared/brand.ts');
const brand = readFileSync(BRAND, 'utf8');
for (const m of brand.matchAll(/\/\*\*\s*`(--[a-z0-9-]+)`\s*\*\/\s*\n\s*\w+:\s*'(#[0-9a-f]{6})'/gi)) {
  const expected = palette.get(m[1]);
  if (!expected) fail(BRAND, lineOf(brand, m.index), `${m[1]} is not in palette.css`);
  else if (expected !== m[2].toLowerCase()) fail(BRAND, lineOf(brand, m.index), `${m[2]} drifted from ${m[1]} (${expected})`);
}

if (problems.length) {
  console.error(`design system: ${problems.length} problem(s)\n`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log(`design-system-ok (${files.length} files, ${palette.size} palette colours, ${uses.length} token reads)`);
