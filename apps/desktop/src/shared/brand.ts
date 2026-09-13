/**
 * The few palette values the main process needs before the renderer has
 * painted - it cannot read CSS. Each must equal the value `palette.css` gives
 * the same role (`--canvas` in each scheme); `npm run check:design` fails if
 * they drift, since a mismatch shows as a flash of the wrong colour on launch.
 */
export const WINDOW_BACKGROUND = {
  /** `--ink-950` */
  dark: '#0d0e1e',
  /** `--paper-25` */
  light: '#f5f9f5',
} as const;
