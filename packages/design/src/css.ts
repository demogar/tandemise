/**
 * tokens.ts -> CSS custom properties. Pure string building; `scripts/emit.mjs`
 * writes the result to `css/tokens.css` and checks the committed file is fresh.
 *
 * Naming is the stable public API of the stylesheet: the palette keeps its own
 * names (`--brand-mint`, `--ink-900`), roles keep theirs (`--canvas`,
 * `--status-failed`), and the scales use the short names the desktop has always
 * read (`--s4`, `--fs-base`, `--radius-md`, `--duration`, `--ease`).
 */
import {
  colorRoles, controlHeight, duration, easing, focusRing, fontFamily, fontSize, lineHeight, palette, radius, shadows, space, zIndex,
  type ColorRole, type Paint, type Wash,
} from './tokens.js';

const v = (name: string): string => `var(--${name})`;
const washCss = (of: string, percent: number): string => `color-mix(in srgb, ${v(of)} ${percent}%, transparent)`;
const paintCss = (paint: Paint): string => (typeof paint === 'string' ? v(paint) : washCss((paint as Wash).hue, paint.percent));

/** The CSS value of one colour role. */
export function roleCss(role: ColorRole): string {
  if ('both' in role) return v(role.both);
  if ('alias' in role) return v(role.alias);
  if ('wash' in role) return washCss(role.wash, role.percent);
  return `light-dark(${paintCss(role.light)}, ${paintCss(role.dark)})`;
}

const px = (n: number): string => `${n}px`;

/** Every custom property the stylesheet declares, by block, in order. */
export function cssVariables(): {
  palette: [string, string][];
  roles: [string, string][];
  scales: [string, string][];
  compact: [string, string][];
} {
  return {
    palette: Object.entries(palette).map(([name, hex]) => [`--${name}`, hex]),
    roles: [
      ...Object.entries(colorRoles).map(([name, role]): [string, string] => [`--${name}`, roleCss(role as ColorRole)]),
      // light-dark() takes colours only, so a shadow mixes inside each branch.
      ...Object.entries(shadows).map(([name, s]): [string, string] => [
        `--shadow-${name}`,
        `0 ${px(s.offsetY)} ${px(s.blur)} light-dark(${paintCss(s.light)}, ${paintCss(s.dark)})`,
      ]),
    ],
    scales: [
      ...Object.entries(radius).map(([name, n]): [string, string] => [`--radius-${name}`, px(n)]),
      ...Object.entries(space).map(([step, n]): [string, string] => [`--s${step}`, px(n)]),
      ['--font-sans', fontFamily.sans.join(', ')],
      ['--font-mono', fontFamily.mono.join(', ')],
      ...Object.entries(fontSize).map(([name, n]): [string, string] => [`--fs-${name}`, px(n)]),
      ['--lh-base', String(lineHeight.base)],
      ['--duration-fast', `${duration.fast}ms`],
      ['--duration', `${duration.base}ms`],
      ['--duration-slow', `${duration.slow}ms`],
      ['--duration-shimmer', `${duration.shimmer}ms`],
      ['--duration-pulse', `${duration.pulse}ms`],
      ['--ease', easing.standard],
      ['--ease-out', easing.enter],
      ['--ease-in', easing.exit],
      ['--focus-ring-width', px(focusRing.width)],
      ['--focus-ring-offset', px(focusRing.offset)],
      ...Object.entries(zIndex).map(([name, n]): [string, string] => [`--z-${name}`, String(n)]),
      ...controlHeights('comfortable'),
    ],
    compact: controlHeights('compact'),
  };
}

function controlHeights(density: keyof typeof controlHeight): [string, string][] {
  return Object.entries(controlHeight[density]).map(([size, n]): [string, string] => [size === 'md' ? '--control-h' : `--control-h-${size}`, px(n)]);
}

const block = (selector: string, decls: [string, string][]): string =>
  `${selector} {\n${decls.map(([name, value]) => `  ${name}: ${value};`).join('\n')}\n}\n`;

export const GENERATED_NOTE = 'Generated from packages/design/src/tokens.ts by `npm run -w @tandemise/design emit`. Do not edit.';

/** The whole of `css/tokens.css`. */
export function tokensCss(): string {
  const vars = cssVariables();
  return [
    `/*
 * @tandemise/design - tokens.css
 * ${GENERATED_NOTE}
 *
 * Theming. Each colour role is written once as light-dark(<light>, <dark>) and
 * the theme is chosen by color-scheme alone:
 *   - no data-theme (the "system" preference): \`dark light\`, so the OS decides
 *   - data-theme="light" | "dark" on any element: that scheme, for its subtree
 * Dark stays the fallback because the desktop app sits beside a terminal all day.
 *
 * The roles are declared on :root AND on every [data-theme] element. Natively
 * that is redundant - light-dark() resolves where the property is used - but a
 * bundler that lowers light-dark() for older browsers (Lightning CSS does)
 * substitutes it where the custom property is DECLARED, so a nested
 * data-theme subtree would otherwise keep its ancestor's colours.
 */
`,
    block(':root', [['color-scheme', 'dark light']]),
    block("[data-theme='dark']", [['color-scheme', 'dark']]),
    block("[data-theme='light']", [['color-scheme', 'light']]),
    '/* Palette: hues. Only the roles below read these; apps read roles. */',
    block(':root', vars.palette),
    '/* Roles: what a colour is for, in both themes. */',
    block(':root,\n[data-theme]', vars.roles),
    '/* Scales: radius, the 4pt spacing scale, type, motion, focus, stacking, control heights. */',
    block(':root', vars.scales),
    "/* Density: control heights for a dense table or toolbar, on any subtree. */",
    block("[data-density='compact']", vars.compact),
  ].join('\n');
}
