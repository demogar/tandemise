import type { ReactElement } from 'react';
import { ICON_PATHS, ICON_STROKE_WIDTH, ICON_VIEWBOX, type IconName } from '../icons.js';

export interface IconProps {
  /** A glyph from `ICON_PATHS`. Add one in `src/icons.ts`. */
  name: IconName;
  /** Rendered width and height, in px. */
  size?: number;
  strokeWidth?: number;
  className?: string;
  /**
   * The icon's accessible name. Without it the icon is decorative
   * (`aria-hidden`), which is right when a visible label sits beside it. With
   * it, the icon is announced as an image: use it only when the icon is the
   * only thing that says what it means.
   */
  label?: string;
}

/**
 * A stroke icon in `currentColor` on a 24px grid, drawn from the package's
 * path data, so it takes the colour of the text it sits in and works in both
 * themes.
 */
export function Icon({ name, size = 16, strokeWidth = ICON_STROKE_WIDTH, className, label }: IconProps): ReactElement {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox={ICON_VIEWBOX}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      focusable="false"
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
    >
      <path d={ICON_PATHS[name]} />
    </svg>
  );
}

export type { IconName };
