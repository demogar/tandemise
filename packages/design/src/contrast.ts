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

const SURFACES = ['canvas', 'surface', 'surface-raised', 'surface-sunken', 'surface-hover'] as const;

/** [foreground, background, minimum ratio], held in both themes. */
export const CONTRAST_PAIRS: readonly (readonly [ColorRoleName, ColorRoleName, number])[] = [
  ...SURFACES.map((bg) => ['text', bg, 10] as const),
  ...SURFACES.map((bg) => ['text-secondary', bg, 4.5] as const),
  ...SURFACES.map((bg) => ['text-tertiary', bg, 4.5] as const),
  ...(['status-running', 'status-blocked', 'status-failed', 'status-succeeded', 'risk-release'] as const).map(
    (fg) => [fg, 'surface', 4.5] as const,
  ),
  ['accent', 'surface', 4.5],
  ['accent-text', 'accent', 12],
  ['tooltip-text', 'tooltip-background', 10],
  // WCAG 1.4.11: the focus outline is a UI boundary, 3:1 against what it sits on.
  ...SURFACES.map((bg) => ['focus-ring', bg, 3] as const),
  ['terminal-foreground', 'terminal-background', 10],
  ['terminal-foreground', 'terminal-selection', 4.5],
];
