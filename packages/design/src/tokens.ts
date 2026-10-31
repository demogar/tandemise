/**
 * The Tandemise design tokens - the single source of truth.
 *
 * Every colour, length and timing the brand uses is written here once and
 * nowhere else. `scripts/emit.mjs` turns this file into `css/tokens.css` (the
 * custom properties an app reads), `css/tailwind.css` (a Tailwind v4 theme) and
 * the logo SVGs in `assets/`; `tailwind.ts` turns it into a Tailwind v3 preset;
 * `resolve.ts` turns it into plain per-theme values for code that cannot read
 * CSS (a canvas, the Electron main process). `npm run check:design` fails when
 * any emitted file is stale, so the CSS can never drift from this file.
 *
 * Two layers, and the rule that makes them a contract:
 *
 *   palette  hues, named for what they are (`brand-mint`, `ink-900`). Only the
 *            roles below may read them.
 *   roles    what a colour is for (`canvas`, `accent`, `status-failed`), each
 *            written once for both themes. Apps read roles, never hues.
 *
 * This module has no imports, so a browser bundle can load it at runtime.
 */

/* ------------------------------------------------------------------ palette */

/**
 * The five brand anchors are the source. Every ramp was derived from them in
 * OKLCH, so steps are perceptually even and the neutrals carry the brand's hue
 * instead of reading as flat grey:
 *
 *   - ink    the indigo anchor, desaturated and darkened: dark-theme surfaces
 *   - paper  the sage anchor, nearly white: light-theme surfaces
 *   - signal status hues, pulled toward the brand so they sit in it rather than
 *            on top of it, contrast-checked (>= 4.5:1) on their theme's surfaces.
 *            `-bright` reads on ink, `-deep` reads on paper.
 *
 * Values are 6-digit lowercase hex, always.
 */
export const palette = {
  // brand anchors
  'brand-mint': '#c4f1be',
  'brand-sage': '#a2c3a4',
  'brand-lichen': '#869d96',
  'brand-slate': '#525b76',
  'brand-indigo': '#201e50',

  // Tints and shades of the anchors, for places the anchor itself fails
  // contrast (mint text on white, indigo on a dark surface).
  'mint-50': '#eef9ec',
  'mint-100': '#d5fbd0',
  'mint-700': '#3a6b3d',
  'sage-700': '#4c6d4f',
  'lichen-300': '#b3c6bb',
  'lichen-700': '#526962',
  'lichen-750': '#536c69',
  'slate-300': '#a7b0cf',
  'indigo-300': '#999fdc',
  'indigo-500': '#4a4b96',
  'indigo-600': '#2f2f6a',
  'indigo-900': '#15133e',

  // ink
  'ink-1000': '#090917',
  'ink-950': '#0d0e1e',
  'ink-900': '#141528',
  'ink-850': '#1a1b30',
  'ink-800': '#1f2138',
  'ink-750': '#272943',
  'ink-700': '#323550',

  // paper
  'paper-0': '#ffffff',
  'paper-25': '#f5f9f5',
  'paper-50': '#ecf3ed',
  'paper-100': '#e5eee7',
  'paper-150': '#dbe6de',
  'paper-200': '#d0ddd5',
  'paper-300': '#bbccc4',

  // signal
  'signal-blue-bright': '#9badf1',
  'signal-blue-deep': '#4a5bac',
  'signal-green-bright': '#7cd591',
  'signal-green-deep': '#317a45',
  'signal-amber-bright': '#efb656',
  'signal-amber-deep': '#a06306',
  'signal-red-bright': '#f47c6b',
  'signal-red-deep': '#c13e2e',
  'signal-violet-bright': '#c39dee',
  'signal-violet-deep': '#7847a6',
} as const;

export type PaletteName = keyof typeof palette;

/* -------------------------------------------------------------------- roles */

/** A palette hue at some opacity: `color-mix(in srgb, var(--hue) N%, transparent)`. */
export interface Wash {
  readonly hue: PaletteName;
  readonly percent: number;
}

/** One side of a role: a palette hue, or a wash of one. */
export type Paint = PaletteName | Wash;

/**
 * How a colour role is written:
 *
 *   { light, dark }     a different paint per theme - `light-dark(<light>, <dark>)`
 *   { both }            the same hue in both themes
 *   { alias }           another role, whatever it resolves to
 *   { wash, percent }   another role at some opacity (the `-soft` fills)
 */
export type ColorRole =
  | { readonly light: Paint; readonly dark: Paint }
  | { readonly both: PaletteName }
  | { readonly alias: string }
  | { readonly wash: string; readonly percent: number };

const wash = (hue: PaletteName, percent: number): Wash => ({ hue, percent });

/**
 * The semantic colour roles, grouped as they are documented. Order is the order
 * they are emitted in, and a role may only alias or wash a role above it.
 */
export const colorRoles = {
  /* surfaces */
  canvas: { light: 'paper-25', dark: 'ink-950' },
  surface: { light: 'paper-0', dark: 'ink-900' },
  'surface-raised': { light: 'paper-0', dark: 'ink-850' },
  'surface-sunken': { light: 'paper-50', dark: 'ink-1000' },
  'surface-hover': { light: 'paper-100', dark: 'ink-800' },
  'surface-active': { light: 'paper-150', dark: 'ink-750' },

  border: { light: 'paper-150', dark: 'ink-800' },
  'border-strong': { light: 'paper-300', dark: 'ink-700' },
  'border-focus': { light: 'indigo-500', dark: 'brand-mint' },

  /* text */
  text: { light: 'brand-indigo', dark: 'mint-50' },
  'text-secondary': { light: 'brand-slate', dark: 'lichen-300' },
  // The lichen anchor itself on ink; darkened on paper, where it fails 4.5:1.
  'text-tertiary': { light: 'lichen-750', dark: 'brand-lichen' },
  'text-inverse': { light: 'paper-0', dark: 'ink-950' },

  /* accent: mint on ink, indigo on paper - the two ends of the brand, each
     where it carries. Text on an accent fill takes the other end. */
  accent: { light: 'brand-indigo', dark: 'brand-mint' },
  'accent-hover': { light: 'indigo-600', dark: 'mint-100' },
  'accent-text': { light: 'brand-mint', dark: 'brand-indigo' },
  'accent-soft': { light: wash('brand-indigo', 8), dark: wash('brand-mint', 12) },
  'accent-line': { light: wash('brand-indigo', 30), dark: wash('brand-mint', 36) },

  /* status */
  'status-running': { light: 'signal-blue-deep', dark: 'signal-blue-bright' },
  'status-blocked': { light: 'signal-amber-deep', dark: 'signal-amber-bright' },
  'status-failed': { light: 'signal-red-deep', dark: 'signal-red-bright' },
  'status-succeeded': { light: 'signal-green-deep', dark: 'signal-green-bright' },
  'status-pending': { alias: 'text-tertiary' },

  'status-running-soft': { wash: 'status-running', percent: 13 },
  'status-blocked-soft': { wash: 'status-blocked', percent: 13 },
  'status-failed-soft': { wash: 'status-failed', percent: 12 },
  'status-succeeded-soft': { wash: 'status-succeeded', percent: 13 },
  'status-pending-soft': { wash: 'status-pending', percent: 13 },

  /* presence with the team: online, away, offline */
  'presence-online': { alias: 'status-succeeded' },
  'presence-away': { alias: 'status-blocked' },
  'presence-offline': { alias: 'status-pending' },

  /* risk of an action */
  'risk-read': { alias: 'status-pending' },
  'risk-write': { alias: 'status-running' },
  'risk-external': { alias: 'status-blocked' },
  'risk-destructive': { alias: 'status-failed' },
  'risk-release': { light: 'signal-violet-deep', dark: 'signal-violet-bright' },

  /* terminal: xterm.js paints on a canvas and takes plain colours, so an app
     resolves these through getComputedStyle (or `resolveTheme`) and hands it
     the result; solid colours only, so the selection stays legible under the
     text drawn over it. */
  'terminal-background': { light: 'paper-0', dark: 'ink-1000' },
  'terminal-foreground': { light: 'brand-indigo', dark: 'mint-50' },
  'terminal-cursor': { light: 'indigo-500', dark: 'brand-mint' },
  'terminal-selection': { light: 'paper-200', dark: 'ink-700' },

  /* brand: the product mark - lead wheel, trailing wheel, axle */
  'logo-lead': { light: 'brand-indigo', dark: 'brand-mint' },
  'logo-trail': { light: 'brand-slate', dark: 'brand-sage' },
  'logo-axle': { both: 'brand-lichen' },

  /* identity tints: monograms and avatars for things without an icon of their
     own. One per brand anchor, so a list of them reads as the palette. */
  'tint-1': { light: 'mint-700', dark: 'brand-mint' },
  'tint-2': { light: 'sage-700', dark: 'brand-sage' },
  'tint-3': { light: 'lichen-700', dark: 'brand-lichen' },
  'tint-4': { light: 'brand-slate', dark: 'slate-300' },
  'tint-5': { light: 'brand-indigo', dark: 'indigo-300' },
} as const satisfies Record<string, ColorRole>;

export type ColorRoleName = keyof typeof colorRoles;

/* ------------------------------------------------------------------ shadows */

/** A shadow whose colour changes by theme. Cast by indigo rather than black, so it does not muddy the paper. */
export interface ShadowToken {
  readonly offsetY: number;
  readonly blur: number;
  readonly light: Wash;
  readonly dark: Wash;
}

export const shadows = {
  sm: { offsetY: 1, blur: 2, light: wash('brand-indigo', 8), dark: wash('ink-1000', 45) },
  md: { offsetY: 4, blur: 16, light: wash('brand-indigo', 11), dark: wash('ink-1000', 50) },
  lg: { offsetY: 18, blur: 48, light: wash('brand-indigo', 18), dark: wash('ink-1000', 62) },
} as const satisfies Record<string, ShadowToken>;

/* -------------------------------------------------------------------- shape */

/** Corner radii, in px. `full` is a pill. */
export const radius = { xs: 4, sm: 6, md: 9, lg: 13, full: 999 } as const;

/** The 4pt spacing scale, in px: `--s1` is 4px, `--s4` is 16px. */
export const space = { 1: 4, 2: 8, 3: 12, 4: 16, 5: 20, 6: 24, 7: 28, 8: 32, 10: 40, 12: 48, 16: 64 } as const;

/* --------------------------------------------------------------- typography */

/** System faces: no web font to load, and the app reads as native next to a terminal. */
export const fontFamily = {
  sans: [
    'ui-sans-serif', '-apple-system', 'BlinkMacSystemFont', "'Segoe UI'", 'Inter', 'Roboto', "'Helvetica Neue'", 'Arial', 'sans-serif',
  ],
  mono: ['ui-monospace', "'SF Mono'", 'SFMono-Regular', 'Menlo', "'JetBrains Mono'", 'Consolas', 'monospace'],
} as const;

/** Type sizes, in px. Dense on purpose: the app is a control surface. */
export const fontSize = { micro: 10.5, xs: 11.5, sm: 12.5, base: 13.5, md: 15, lg: 18, xl: 23, '2xl': 30 } as const;

/** Body line height, unitless. */
export const lineHeight = { base: 1.5 } as const;

/* ------------------------------------------------------------------- motion */

export const duration = { fast: 120, base: 160 } as const;
export const easing = { standard: 'cubic-bezier(0.32, 0.72, 0, 1)' } as const;

export type ThemeName = 'light' | 'dark';
