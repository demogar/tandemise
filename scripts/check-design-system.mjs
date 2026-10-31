// Holds the desktop app, and the design package it is built from, to the
// design system (docs/DESIGN_SYSTEM.md).
//
// The system lives in `packages/design` (`@tandemise/design`): the palette and
// the roles are authored once in `src/tokens.ts` and emitted as
// `css/tokens.css`. The rule that makes it a contract rather than a suggestion
// is that colour enters the app only through that package. This check fails
// the build when:
//
//   0. a file emitted from tokens.ts (tokens.css, tailwind.css, the logo SVGs)
//      is stale, or a promised contrast pairing drops below its ratio
//   1. a colour literal (hex, rgb, hsl, oklch...) appears outside tokens.ts and
//      the files emitted from it
//   2. a palette primitive is read anywhere but the package's tokens.css
//   3. a `var(--token)` names a token nobody defines (a typo renders as nothing)
//   4. a `var()` carries a fallback, which is how those typos stay hidden
//   5. `light-dark()` is handed something other than colours (Chromium drops
//      the whole declaration, silently)
//   6. the app icon uses a colour that is not in the palette, or the template
//      mark uses anything but black
//   7. the main process's pre-paint window colours drift from the palette
//
//   node scripts/check-design-system.mjs     (after `npm run build`: it reads packages/design/dist)
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const desktop = join(root, 'apps/desktop');
const design = join(root, 'packages/design');
const TOKENS_TS = join(design, 'src/tokens.ts');
const TOKENS_CSS = join(design, 'css/tokens.css');
const TAILWIND_CSS = join(design, 'css/tailwind.css');
const DIST = join(design, 'dist/index.js');

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

// ------------------------------------------------------------------ package

if (!existsSync(DIST)) {
  console.error('design system: packages/design/dist is missing - run `npm run build` first');
  process.exit(1);
}
const tokens = await import(pathToFileURL(DIST).href);
const palette = new Map(Object.entries(tokens.palette).map(([name, hex]) => [`--${name}`, hex]));
for (const [name, hex] of palette) if (!/^#[0-9a-f]{6}$/.test(hex)) fail(TOKENS_TS, 0, `${name} must be a 6-digit lowercase hex value, not "${hex}"`);
const paletteValues = new Set(palette.values());

// 0. Emitted files are what tokens.ts says, and the promised contrast holds.
try {
  execFileSync(process.execPath, [join(design, 'scripts/emit.mjs'), '--check'], { cwd: root, stdio: ['ignore', 'ignore', 'pipe'] });
} catch (error) {
  fail(design, 0, String(error.stderr ?? error.message).trim());
}
for (const theme of ['light', 'dark']) {
  const resolved = tokens.resolveTheme(theme);
  for (const [fg, bg, min] of tokens.CONTRAST_PAIRS) {
    const ratio = tokens.contrast(resolved[fg], resolved[bg]);
    if (ratio < min) fail(TOKENS_TS, 0, `--${fg} on --${bg} is ${ratio.toFixed(2)}:1 in ${theme}, below the ${min}:1 it promises`);
  }
}

// ------------------------------------------------------------ renderer code

// Everything that reads tokens: the desktop's source and the package's own
// sources and hand-written CSS. The emitted CSS is not scanned for literals -
// it is proven equal to tokens.ts above - but its definitions count.
const files = [...walk(join(desktop, 'src')), ...walk(join(design, 'src')), ...walk(join(design, 'css'))];
const EMITTED = new Set([TOKENS_CSS, TAILWIND_CSS]);
const defined = new Set();
const uses = [];

const COLOUR_LITERAL = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/gi;

for (const file of files) {
  const text = stripComments(readFileSync(file, 'utf8'), file);
  const isCss = file.endsWith('.css');

  for (const m of text.matchAll(/(?:^|[\s;{'"])(--[a-z0-9-]+)\s*:/g)) defined.add(m[1]);

  // 1. Colour literals. In TS a hex is only a colour when it is a whole string
  // (`'#0d0e1e'`); `#/missions` and `#root` are routes and selectors.
  if (file !== TOKENS_TS && !EMITTED.has(file) && !file.endsWith(join('src/shared/brand.ts'))) {
    const pattern = isCss ? COLOUR_LITERAL : /['"`]#[0-9a-f]{3,8}['"`]|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/gi;
    for (const m of text.matchAll(pattern)) {
      fail(file, lineOf(text, m.index), `colour literal "${m[0]}" - use a role from @tandemise/design (tokens.css)`);
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
  if (palette.has(use.name) && !EMITTED.has(use.file)) {
    fail(use.file, use.line, `${use.name} is a palette primitive - read a role from @tandemise/design instead`);
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

const ICON = join(design, 'assets/app-icon.svg');
for (const colour of svgColours(ICON)) {
  if (!paletteValues.has(colour.toLowerCase())) fail(ICON, 0, `"${colour}" is not a palette colour`);
}

// A macOS template image is recoloured by the system and must be pure black.
const TRAY = join(design, 'assets/logo-mark-template.svg');
for (const colour of svgColours(TRAY)) {
  if (!/^#0{3}(0{3})?$/.test(colour)) fail(TRAY, 0, `"${colour}" - a template image must be drawn in #000 only`);
}

// ------------------------------------------------------ pre-paint colours

const BRAND = join(desktop, 'src/shared/brand.ts');
const brand = readFileSync(BRAND, 'utf8');
for (const m of brand.matchAll(/\/\*\*\s*`(--[a-z0-9-]+)`\s*\*\/\s*\n\s*\w+:\s*'(#[0-9a-f]{6})'/gi)) {
  const expected = palette.get(m[1]);
  if (!expected) fail(BRAND, lineOf(brand, m.index), `${m[1]} is not in the @tandemise/design palette`);
  else if (expected !== m[2].toLowerCase()) fail(BRAND, lineOf(brand, m.index), `${m[2]} drifted from ${m[1]} (${expected})`);
}

if (problems.length) {
  console.error(`design system: ${problems.length} problem(s)\n`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log(`design-system-ok (${files.length} files, ${palette.size} palette colours, ${uses.length} token reads)`);
