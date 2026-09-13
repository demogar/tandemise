/**
 * Inline icon set.
 *
 * Hand-rolled rather than pulled from a package: the app needs about thirty
 * glyphs, they must inherit `currentColor` to work in both themes, and a CSP
 * that forbids remote content makes an icon font the wrong shape anyway.
 */
const PATHS = {
  home: 'M3 10.5 12 3l9 7.5M5.5 9.5V20h13V9.5',
  missions: 'M4 5h16M4 12h16M4 19h9',
  flag: 'M5 21V4m0 0 6.5 2.5L18 4v9l-6.5 2.5L5 13',
  approvals: 'M4 5h16v9.5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2zM4 11h4l1.5 2.5h5L16 11h4',
  artifacts: 'M6 3h7l5 5v13H6zM13 3v5h5',
  workforce: 'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7M2.5 20a6.5 6.5 0 0 1 13 0M17 11.5a2.8 2.8 0 1 0 0-5.6M18 14.4c2 .7 3.5 2.6 3.5 5.1',
  runtimes: 'M7 7h10v10H7zM9.5 3v3M14.5 3v3M9.5 18v3M14.5 18v3M3 9.5h3M3 14.5h3M18 9.5h3M18 14.5h3',
  integrations: 'M9 3v6M15 3v6M6.5 9h11v4a5.5 5.5 0 0 1-11 0zM12 18.5V22',
  settings:
    'M4 7h9M17 7h3M4 17h3M11 17h9M15 4.5v5M8 14.5v5',
  plus: 'M12 5v14M5 12h14',
  search: 'M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13M15.5 15.5 20 20',
  chevronRight: 'm9 5 7 7-7 7',
  chevronDown: 'm5 9 7 7 7-7',
  chevronUp: 'm5 15 7-7 7 7',
  check: 'm5 12.5 4.5 4.5L19 7',
  x: 'M6 6 18 18M18 6 6 18',
  alert: 'M12 4 2.5 20.5h19zM12 10v4.5M12 17.5v.01',
  alertCircle: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18M12 7.5V13M12 16.2v.01',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18M12 11v5.5M12 7.6v.01',
  play: 'M7 4.5 19 12 7 19.5z',
  pause: 'M8.5 5v14M15.5 5v14',
  stop: 'M6 6h12v12H6z',
  refresh: 'M20 12a8 8 0 1 1-2.6-5.9M20 4v4.5h-4.5',
  folder: 'M3 6.5h6l2 2.5h10V19H3z',
  externalLink: 'M14 4h6v6M20 4 11 13M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
  branch: 'M6.5 4v11M6.5 20.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5M6.5 6.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5M17.5 9.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5M17.5 9.5c0 4-5 3-11 5.5',
  message: 'M4 5h16v11H9l-5 4z',
  file: 'M6 3h7l5 5v13H6zM13 3v5h5M9 13h6M9 16.5h4',
  filePlus: 'M6 3h7l5 5v13H6zM13 3v5h5M12 11.5v6M9 14.5h6',
  shield: 'M12 3 4.5 6v6c0 4.5 3 7.7 7.5 9 4.5-1.3 7.5-4.5 7.5-9V6z',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18M12 7v5.2l3.4 2',
  zap: 'M13 2 4 14h7l-1 8 9-12h-7z',
  terminal: 'M5 6.5 10 12l-5 5.5M12.5 18h7',
  arrowUp: 'M12 19V5M5.5 11.5 12 5l6.5 6.5',
  arrowDown: 'M12 5v14M5.5 12.5 12 19l6.5-6.5',
  trash: 'M4.5 6.5h15M9.5 6.5V4h5v2.5M6.5 6.5 7.5 21h9l1-14.5M10.5 10.5v6M13.5 10.5v6',
  eye: 'M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6',
  activity: 'M3 12.5h4L10 5l4 14 3-6.5h4',
  gauge: 'M4 18a8 8 0 1 1 16 0M12 14l4-4',
  book: 'M4 4.5h6a2.5 2.5 0 0 1 2 2.5 2.5 2.5 0 0 1 2-2.5h6v13h-6a2.5 2.5 0 0 0-2 2 2.5 2.5 0 0 0-2-2H4z',
  sparkle: 'M12 3.5 13.8 9 19 10.8 13.8 12.6 12 18l-1.8-5.4L5 10.8 10.2 9zM18.5 16l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z',
  target: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18M12 16.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9M12 13.2a1.2 1.2 0 1 0 0-2.4 1.2 1.2 0 0 0 0 2.4',
  link: 'M10 13.5a3.5 3.5 0 0 0 5 0l3-3a3.5 3.5 0 0 0-5-5l-1.2 1.2M14 10.5a3.5 3.5 0 0 0-5 0l-3 3a3.5 3.5 0 0 0 5 5l1.2-1.2',
  camera: 'M3 8h4l1.5-2.5h7L17 8h4v11H3zM12 16.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7',
  moon: 'M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5',
  sun: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.5 1.5M17.6 17.6l1.5 1.5M19.1 4.9l-1.5 1.5M6.4 17.6l-1.5 1.5',
  monitor: 'M3 5h18v11H3zM9 20h6M12 16v4',
  wrench: 'M14.5 3.5a5 5 0 0 0-5.9 6.4L3 15.5V21h5.5l5.6-5.6a5 5 0 0 0 6.4-5.9l-3 3-2.5-2.5z',
  layers: 'M12 3 3 8l9 5 9-5zM3 13l9 5 9-5M3 17.5l9 5 9-5',
  pulse: 'M3 12h3.5L9 6l3 12 2.5-6H21',
} as const;

export type IconName = keyof typeof PATHS;

interface IconProps {
  name: IconName;
  size?: number;
  strokeWidth?: number;
  className?: string;
}

export function Icon({ name, size = 16, strokeWidth = 1.7, className }: IconProps): JSX.Element {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
