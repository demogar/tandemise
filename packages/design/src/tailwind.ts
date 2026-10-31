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
 *
 * Fonts, radii, shadows and easings: tokens.css names them `--tds-*` so they
 * never collide with Tailwind's own theme variables, and the v4 theme maps
 * Tailwind's names onto them (`--radius-md: var(--tds-radius-md)`), so
 * `rounded-md`, `shadow-lg`, `font-sans` and `ease-out` draw the Tandemise
 * values. A site that wants its own type or corners overrides those names in
 * its own `@theme`, after this file, as with any Tailwind theme.
 */
import { colorRoles, fontFamily, palette, radius, shadows, type PaletteName } from './tokens.js';

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
      boxShadow: Object.fromEntries(Object.keys(shadows).map((name) => [name, `var(--tds-shadow-${name})`])),
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
 * Hues are literal, so bg-ink-950 or text-mint work on their own. Everything
 * else bridges to tokens.css (\`@theme inline\`): the roles, so bg-canvas or
 * text-text-secondary follow the theme, and Tailwind's font, radius, shadow
 * and easing names, mapped onto the --tds-* tokens. tokens.css declares no
 * Tailwind name itself, so neither file overrides the other by accident; to
 * keep your own fonts or corners, restate those names in your own @theme.
 */
`,
    '@theme {',
    ...hues,
    '}',
    '',
    '@theme inline {',
    ...roles,
    '',
    '  --font-sans: var(--tds-font-sans);',
    '  --font-mono: var(--tds-font-mono);',
    '',
    ...Object.keys(radius).map((name) => `  --radius-${name}: var(--tds-radius-${name});`),
    '',
    ...Object.keys(shadows).map((name) => `  --shadow-${name}: var(--tds-shadow-${name});`),
    '',
    '  --ease-in: var(--tds-ease-in);',
    '  --ease-out: var(--tds-ease-out);',
    '  --ease-in-out: var(--tds-ease);',
    '}',
    '',
  ].join('\n');
}
