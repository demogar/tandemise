/**
 * The tokens as Tailwind theme values, for a site built on Tailwind
 * (tandemise-web is Next.js + Tailwind v4).
 *
 *   Tailwind v4   `@import '@tandemise/design/tailwind.css'` - an `@theme` block
 *                 emitted from `tailwindThemeCss()` below.
 *   Tailwind v3   `presets: [tailwindPreset]` in tailwind.config.
 *
 * Both give the same utility names. Palette hues are literal values, so
 * `bg-ink-950` / `text-mint` / `stroke-lichen` work with no other stylesheet.
 * Roles (`bg-canvas`, `text-text-secondary`, `border-border`) are bridges to the
 * custom properties in `tokens.css`, so they follow the theme - load tokens.css
 * to use them.
 *
 * Utility names: a brand anchor drops its `brand-` prefix (`brand-mint` ->
 * `mint`), every other hue splits at its last dash (`ink-950` -> `ink.950`,
 * `signal-red-bright` -> `signal-red.bright`), so the class is the token name.
 */
import { colorRoles, fontFamily, palette, radius, type PaletteName } from './tokens.js';

/** `brand-mint` -> ['mint', 'DEFAULT'], `ink-950` -> ['ink', '950']. */
function tailwindPath(name: PaletteName): [string, string] {
  if (name.startsWith('brand-')) return [name.slice('brand-'.length), 'DEFAULT'];
  const cut = name.lastIndexOf('-');
  return [name.slice(0, cut), name.slice(cut + 1)];
}

/** The Tailwind colour name (`bg-<name>`) of a palette hue. */
export function tailwindColorName(name: PaletteName): string {
  const [group, step] = tailwindPath(name);
  return step === 'DEFAULT' ? group : `${group}-${step}`;
}

type ColorScale = Record<string, string>;

const paletteColors = (): Record<string, ColorScale> => {
  const out: Record<string, ColorScale> = {};
  for (const name of Object.keys(palette) as PaletteName[]) {
    const [group, step] = tailwindPath(name);
    (out[group] ??= {})[step] = palette[name];
  }
  return out;
};

const roleColors = (): Record<string, string> =>
  Object.fromEntries(Object.keys(colorRoles).map((name) => [name, `var(--${name})`]));

const px = (n: number): string => `${n}px`;

/**
 * A Tailwind v3 preset. Extends rather than replaces the default theme, so
 * Tailwind's own scales stay available beside the brand's.
 */
export const tailwindPreset = {
  theme: {
    extend: {
      colors: { ...paletteColors(), ...roleColors() },
      fontFamily: { sans: [...fontFamily.sans], mono: [...fontFamily.mono] },
      borderRadius: Object.fromEntries(Object.entries(radius).map(([name, n]) => [name, px(n)])),
    },
  },
};

/** The whole of `css/tailwind.css`: a Tailwind v4 theme. */
export function tailwindThemeCss(generatedNote: string): string {
  const hues = (Object.keys(palette) as PaletteName[]).map((name) => `  --color-${tailwindColorName(name)}: ${palette[name]};`);
  const roles = Object.keys(colorRoles).map((name) => `  --color-${name}: var(--${name});`);
  return [
    `/*
 * @tandemise/design - tailwind.css, a Tailwind v4 theme.
 * ${generatedNote}
 *
 *   @import 'tailwindcss';
 *   @import '@tandemise/design/tokens.css';    (for the role utilities)
 *   @import '@tandemise/design/tailwind.css';
 *
 * Hues are literal, so bg-ink-950 or text-mint work on their own. Roles bridge
 * to tokens.css (\`@theme inline\`), so bg-canvas or text-text-secondary follow
 * the theme.
 */
`,
    '@theme {',
    ...hues,
    '',
    `  --font-sans: ${fontFamily.sans.join(', ')};`,
    `  --font-mono: ${fontFamily.mono.join(', ')};`,
    '',
    ...Object.entries(radius).map(([name, n]) => `  --radius-${name}: ${px(n)};`),
    '}',
    '',
    '@theme inline {',
    ...roles,
    '}',
    '',
  ].join('\n');
}
