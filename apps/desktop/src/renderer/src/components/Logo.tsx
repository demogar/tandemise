import { LOGO } from '@tandemise/design/logo';

/**
 * The product mark: two wheels on one axle, a tandem.
 *
 * The geometry is `LOGO` from `@tandemise/design`, the same drawing the menu
 * bar's template image and the website's mark are emitted from; the dock icon
 * (`packages/design/assets/app-icon.svg`) is the same mark redrawn for 1024px.
 * docs/DESIGN_SYSTEM.md#logo.
 *
 * Colour comes from the `--logo-*` roles, never from `currentColor`: the mark
 * is the palette in miniature and must not pick up whatever text colour it
 * happens to sit in.
 */
export function Logo({ size = 22, muted = false }: { size?: number; muted?: boolean }): JSX.Element {
  const { axle, trail, lead } = LOGO;
  return (
    <svg
      className={muted ? 'logo logo--muted' : 'logo'}
      width={size}
      height={size}
      viewBox={LOGO.viewBox}
      fill="none"
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
    >
      <g transform={LOGO.rotate}>
        <line className="logo__axle" x1={axle.x1} y1={axle.y1} x2={axle.x2} y2={axle.y2} strokeWidth={axle.strokeWidth} />
        <circle className="logo__trail" cx={trail.cx} cy={trail.cy} r={trail.r} strokeWidth={trail.strokeWidth} />
        <circle className="logo__lead" cx={lead.cx} cy={lead.cy} r={lead.r} strokeWidth={lead.strokeWidth} />
      </g>
    </svg>
  );
}
