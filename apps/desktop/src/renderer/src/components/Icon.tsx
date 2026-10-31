import { ICON_PATHS, ICON_STROKE_WIDTH, ICON_VIEWBOX, type IconName } from '@tandemise/design/icons';

/**
 * The inline icon set, drawn from `@tandemise/design`'s path data: stroke
 * icons in `currentColor` on a 24px grid, so they work in both themes and need
 * nothing a strict CSP would refuse. Add a glyph in packages/design/src/icons.ts.
 */
export type { IconName };

interface IconProps {
  name: IconName;
  size?: number;
  strokeWidth?: number;
  className?: string;
}

export function Icon({ name, size = 16, strokeWidth = ICON_STROKE_WIDTH, className }: IconProps): JSX.Element {
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
      aria-hidden="true"
      focusable="false"
    >
      <path d={ICON_PATHS[name]} />
    </svg>
  );
}
