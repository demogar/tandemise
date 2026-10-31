import type { ReactElement } from 'react';
import { LOGO } from '../logo.js';

export interface LogoProps {
  /** Rendered width and height, in px. The mark's minimum is 16. */
  size?: number;
  /**
   * Every part in `--text-tertiary`. It means "nothing to connect to" (a
   * daemon that is down), never decoration.
   */
  muted?: boolean;
  /** An accessible name, when the mark stands alone (no product name beside it). */
  title?: string;
  className?: string;
}

/**
 * The product mark: two wheels on one axle, a tandem. The geometry is `LOGO`,
 * the colour the `--logo-*` roles (never `currentColor`), so the mark is the
 * palette in miniature in either theme.
 */
export function Logo({ size = 22, muted = false, title, className }: LogoProps): ReactElement {
  const { axle, trail, lead } = LOGO;
  const classes = [muted ? 'logo logo--muted' : 'logo', className].filter(Boolean).join(' ');
  return (
    <svg
      className={classes}
      width={size}
      height={size}
      viewBox={LOGO.viewBox}
      fill="none"
      strokeLinecap="round"
      focusable="false"
      {...(title ? { role: 'img', 'aria-label': title } : { 'aria-hidden': true })}
    >
      <g transform={LOGO.rotate}>
        <line className="logo__axle" x1={axle.x1} y1={axle.y1} x2={axle.x2} y2={axle.y2} strokeWidth={axle.strokeWidth} />
        <circle className="logo__trail" cx={trail.cx} cy={trail.cy} r={trail.r} strokeWidth={trail.strokeWidth} />
        <circle className="logo__lead" cx={lead.cx} cy={lead.cy} r={lead.r} strokeWidth={lead.strokeWidth} />
      </g>
    </svg>
  );
}
