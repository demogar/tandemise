/**
 * The product mark: two wheels on one axle, a tandem.
 *
 * This is the in-app drawing of the same mark as `build/icon.svg` (the dock
 * icon) and `build/tray.svg` (the menu bar). It shares the tray's geometry
 * rather than the dock icon's, because it is drawn at the same optical size -
 * around 20px - where the dock icon's thinner strokes break up. Change the
 * shape in all three places, or in none; docs/DESIGN_SYSTEM.md#logo.
 *
 * Colour comes from the `--logo-*` roles, never from `currentColor`: the mark
 * is the palette in miniature and must not pick up whatever text colour it
 * happens to sit in.
 */
export function Logo({ size = 22, muted = false }: { size?: number; muted?: boolean }): JSX.Element {
  return (
    <svg
      className={muted ? 'logo logo--muted' : 'logo'}
      width={size}
      height={size}
      viewBox="0 0 176 176"
      fill="none"
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
    >
      <g transform="rotate(-10 88 88)">
        {/* Axle first, tucked under both wheels so the joins are clean. */}
        <line className="logo__axle" x1="72" y1="88" x2="97" y2="88" strokeWidth="15" />
        {/* Trailing wheel smaller: unequal wheels read as a direction of travel. */}
        <circle className="logo__trail" cx="42" cy="88" r="25" strokeWidth="17" />
        <circle className="logo__lead" cx="134" cy="88" r="32" strokeWidth="17" />
      </g>
    </svg>
  );
}
