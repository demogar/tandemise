/**
 * WCAG 2.x contrast, and the pairings the system promises. `npm run
 * check:design` measures every pairing in both themes, so the ratios quoted in
 * the README are measured rather than remembered.
 *
 * 4.5 is body text (WCAG 1.4.3); 3 is a UI boundary or graphic mark (1.4.11).
 */
import type { ColorRoleName } from './tokens.js';

const channel = (hex: string, i: number): number => {
  const s = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};

/** Relative luminance of a `#rrggbb` colour. */
export function luminance(hex: string): number {
  return 0.2126 * channel(hex, 0) + 0.7152 * channel(hex, 1) + 0.0722 * channel(hex, 2);
}

/** WCAG contrast ratio of two opaque `#rrggbb` colours, 1-21. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * `top` (`#rrggbb` or `#rrggbbaa`) laid over the opaque `bottom`, as the
 * browser paints it: a wash like `--status-failed-soft` over a card.
 */
export function composite(top: string, bottom: string): string {
  const alpha = top.length === 9 ? parseInt(top.slice(7, 9), 16) / 255 : 1;
  const mix = (i: number): string => {
    const t = parseInt(top.slice(1 + i * 2, 3 + i * 2), 16);
    const b = parseInt(bottom.slice(1 + i * 2, 3 + i * 2), 16);
    return Math.round(t * alpha + b * (1 - alpha))
      .toString(16)
      .padStart(2, '0');
  };
  return `#${mix(0)}${mix(1)}${mix(2)}`;
}

/**
 * [foreground, background, minimum ratio, surface under the background]. The
 * fourth entry is for a translucent background (a `-soft` wash): it is
 * measured as painted over that surface.
 */
export type ContrastPair = readonly [ColorRoleName, ColorRoleName, number, ColorRoleName?];

/** The ratio one pairing measures in a resolved theme (`resolveTheme()`). */
export function pairContrast(resolved: Readonly<Record<string, string>>, [fg, bg, , on]: ContrastPair): number {
  const background = on === undefined ? (resolved[bg] as string) : composite(resolved[bg] as string, resolved[on] as string);
  return contrast(resolved[fg] as string, background);
}

const SURFACES = ['canvas', 'surface', 'surface-raised', 'surface-sunken', 'surface-hover'] as const;

/**
 * A badge: small (--fs-xs) text in a colour, on that colour's wash, wherever
 * the badge sits. WCAG 1.4.3 asks 4.5:1 of text that size.
 */
const BADGES = [
  ['status-running', 'status-running-soft'],
  ['status-blocked', 'status-blocked-soft'],
  ['status-failed', 'status-failed-soft'],
  ['status-succeeded', 'status-succeeded-soft'],
  ['status-pending', 'status-pending-soft'],
  ['risk-release', 'risk-release-soft'],
  ['accent', 'accent-soft'],
] as const;

/** The pairings the system promises, each held in both themes. */
export const CONTRAST_PAIRS: readonly ContrastPair[] = [
  ...SURFACES.map((bg) => ['text', bg, 10] as const),
  ...SURFACES.map((bg) => ['text-secondary', bg, 4.5] as const),
  ...SURFACES.map((bg) => ['text-tertiary', bg, 4.5] as const),
  ...(['status-running', 'status-blocked', 'status-failed', 'status-succeeded', 'risk-release'] as const).map(
    (fg) => [fg, 'surface', 4.5] as const,
  ),
  ['accent', 'surface', 4.5],
  // Status text on its own wash: a badge, a StatusPill, a danger button.
  ...BADGES.flatMap(([fg, wash]) => SURFACES.map((on) => [fg, wash, 4.5, on] as const)),
  // A tab's count pill: small tertiary text on --surface-active.
  ['text-tertiary', 'surface-active', 4.5],
  ['accent-text', 'accent', 12],
  ['tooltip-text', 'tooltip-background', 10],
  // WCAG 1.4.11: the focus outline is a UI boundary, 3:1 against what it sits on.
  ...SURFACES.map((bg) => ['focus-ring', bg, 3] as const),
  ['terminal-foreground', 'terminal-background', 10],
  ['terminal-foreground', 'terminal-selection', 4.5],
];
