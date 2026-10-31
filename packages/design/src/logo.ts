/**
 * The product mark: two wheels on one axle, a tandem. Read the other way it is
 * two nodes on an edge - one piece of work handed from one worker to the next.
 *
 * This is the small-size geometry (around 20px: in-app, the menu bar, a
 * favicon). The app icon (`assets/app-icon.svg`) is the same mark drawn for
 * 1024px on a tile, with thinner strokes; change the shape in both or neither.
 *
 * Don'ts, since they are easy to undo by accident: the wheels never touch (an
 * infinity sign), are never the same size (spectacles), the axle spans only the
 * gap (a stick through two hoops), and there is no hub (a blob at 16px).
 */
import type { PaletteName } from './tokens.js';

export const LOGO = {
  viewBox: '0 0 176 176',
  /** Tilted so the mark has a direction rather than sitting flat. */
  rotate: 'rotate(-10 88 88)',
  /** Drawn first, tucked under both wheels so the joins are clean. */
  axle: { x1: 72, y1: 88, x2: 97, y2: 88, strokeWidth: 15 },
  /** Smaller: unequal wheels read as a direction of travel. */
  trail: { cx: 42, cy: 88, r: 25, strokeWidth: 17 },
  lead: { cx: 134, cy: 88, r: 32, strokeWidth: 17 },
} as const;

/** The mark's colours per background; apps read the `--logo-*` roles instead. */
export const LOGO_COLORS = {
  onDark: { lead: 'brand-mint', trail: 'brand-sage', axle: 'brand-lichen' },
  onLight: { lead: 'brand-indigo', trail: 'brand-slate', axle: 'brand-lichen' },
} as const satisfies Record<string, Record<'lead' | 'trail' | 'axle', PaletteName>>;

/** The mark as an SVG document, each part stroked with the given CSS paint. */
export function logoSvg(paint: { lead: string; trail: string; axle: string }, options: { size?: number; style?: string } = {}): string {
  const { axle, trail, lead } = LOGO;
  const size = options.size ?? 176;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${LOGO.viewBox}" width="${size}" height="${size}">`,
    ...(options.style ? [`  <style>${options.style}</style>`] : []),
    `  <g transform="${LOGO.rotate}" fill="none" stroke-linecap="round">`,
    `    <line class="axle" x1="${axle.x1}" y1="${axle.y1}" x2="${axle.x2}" y2="${axle.y2}" stroke="${paint.axle}" stroke-width="${axle.strokeWidth}"/>`,
    `    <circle class="trail" cx="${trail.cx}" cy="${trail.cy}" r="${trail.r}" stroke="${paint.trail}" stroke-width="${trail.strokeWidth}"/>`,
    `    <circle class="lead" cx="${lead.cx}" cy="${lead.cy}" r="${lead.r}" stroke="${paint.lead}" stroke-width="${lead.strokeWidth}"/>`,
    '  </g>',
    '</svg>',
    '',
  ].join('\n');
}
