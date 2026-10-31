/**
 * The foundations pages' building blocks. Every value is read from the
 * package (tokens.ts, resolveTheme(), contrast(), ICON_PATHS, LOGO) at render
 * time, so these pages cannot fall out of date: change a token and its page
 * changes with it.
 */
import { useMemo, useState, type ReactElement, type ReactNode } from 'react';
import { CONTRAST_PAIRS, pairContrast } from '../../src/contrast.js';
import { ICON_PATHS } from '../../src/icons.js';
import { resolveTheme } from '../../src/resolve.js';
import {
  colorRoles,
  controlHeight,
  duration,
  easing,
  fontFamily,
  fontSize,
  lineHeight,
  palette,
  radius,
  shadows,
  space,
  zIndex,
  focusRing,
  type ColorRoleName,
  type ThemeName,
} from '../../src/tokens.js';
import { Button, Icon, Logo, type IconName } from '../../src/react/index.js';

const THEMES: ThemeName[] = ['light', 'dark'];

/** The same content in a light and a dark panel, side by side. */
export function BothThemes({ children }: { children: (theme: ThemeName) => ReactNode }): ReactElement {
  return (
    <div className="fd-themes">
      {THEMES.map((theme) => (
        <div key={theme} className="fd-panel" data-theme={theme}>
          <div className="fd-panel__label">{theme}</div>
          {children(theme)}
        </div>
      ))}
    </div>
  );
}

function Swatch({ name, value, sub }: { name: string; value: string; sub?: string }): ReactElement {
  return (
    <div className="fd-swatch">
      <div className="fd-swatch__chip" style={{ background: value }} />
      <code className="fd-swatch__name">{name}</code>
      {sub ? <span className="fd-swatch__value">{sub}</span> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ colour */

/** The palette: hues, read only by the roles. Grouped by family. */
export function Palette(): ReactElement {
  const families = useMemo(() => {
    const groups = new Map<string, string[]>();
    for (const name of Object.keys(palette)) {
      const family = name.startsWith('brand-') ? 'brand' : name.replace(/-\d+$|-(bright|deep)$/, '');
      groups.set(family, [...(groups.get(family) ?? []), name]);
    }
    return [...groups];
  }, []);
  return (
    <>
      {families.map(([family, names]) => (
        <div key={family}>
          <h3>{family}</h3>
          <div className="fd-grid">
            {names.map((name) => (
              <Swatch key={name} name={`--${name}`} value={`var(--${name})`} sub={palette[name as keyof typeof palette]} />
            ))}
          </div>
        </div>
      ))}
    </>
  );
}

/** The roles in a group (by name prefix), in both themes, with each theme's resolved value. */
export function Roles({ prefix, exclude }: { prefix: string | string[]; exclude?: string[] }): ReactElement {
  const prefixes = Array.isArray(prefix) ? prefix : [prefix];
  const names = (Object.keys(colorRoles) as ColorRoleName[]).filter(
    (name) => prefixes.some((p) => name === p || name.startsWith(`${p}-`)) && !exclude?.some((e) => name.startsWith(e)),
  );
  return (
    <BothThemes>
      {(theme) => {
        const resolved = resolveTheme(theme);
        return (
          <div className="fd-grid">
            {names.map((name) => (
              <Swatch key={name} name={`--${name}`} value={`var(--${name})`} sub={resolved[name]} />
            ))}
          </div>
        );
      }}
    </BothThemes>
  );
}

/** Every pairing the system promises (CONTRAST_PAIRS), measured in both themes. */
export function ContrastPairs(): ReactElement {
  const resolved = { light: resolveTheme('light'), dark: resolveTheme('dark') };
  return (
    <table className="fd-table">
      <thead>
        <tr>
          <th>Text (or mark)</th>
          <th>On</th>
          <th>Promised</th>
          <th>Light</th>
          <th>Dark</th>
        </tr>
      </thead>
      <tbody>
        {CONTRAST_PAIRS.map((pair) => {
          const [fg, bg, min, on] = pair;
          return (
            <tr key={`${fg}/${bg}/${on ?? ''}`}>
              <td>
                <code>--{fg}</code>
              </td>
              <td>
                <code>--{bg}</code>
                {on ? (
                  <>
                    {' over '}
                    <code>--{on}</code>
                  </>
                ) : null}
              </td>
              <td>≥ {min}:1</td>
              {THEMES.map((theme) => {
                const ratio = pairContrast(resolved[theme], pair);
                return (
                  <td key={theme} data-theme={theme} style={{ background: 'transparent' }}>
                    <span
                      className="fd-pair"
                      style={{
                        color: `var(--${fg})`,
                        // A wash is painted over the surface it sits on, as in the app.
                        backgroundColor: on ? `var(--${on})` : `var(--${bg})`,
                        backgroundImage: on ? `linear-gradient(var(--${bg}), var(--${bg}))` : undefined,
                      }}
                    >
                      {ratio.toFixed(2)}:1 {ratio >= min ? '✓' : '✗'}
                    </span>
                  </td>
                );
              })}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/* -------------------------------------------------------------- typography */

export function TypeScale(): ReactElement {
  return (
    <table className="fd-table">
      <thead>
        <tr>
          <th>Token</th>
          <th>Size</th>
          <th>Sample</th>
        </tr>
      </thead>
      <tbody>
        {Object.entries(fontSize).map(([name, px]) => (
          <tr key={name}>
            <td>
              <code>--fs-{name}</code>
            </td>
            <td>{px}px</td>
            <td style={{ fontSize: `var(--fs-${name})`, lineHeight: 'var(--lh-base)' }}>Hand the work on to the next worker</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function FontFamilies(): ReactElement {
  return (
    <table className="fd-table">
      <tbody>
        {Object.entries(fontFamily).map(([name, stack]) => (
          <tr key={name}>
            <td>
              <code>--font-{name}</code>
            </td>
            <td style={{ fontFamily: `var(--font-${name})`, fontSize: 'var(--fs-md)' }}>Tandemise 0123456789 → ✓</td>
            <td style={{ color: 'var(--text-secondary)', fontSize: 'var(--fs-xs)' }}>{stack.join(', ')}</td>
          </tr>
        ))}
        <tr>
          <td>
            <code>--lh-base</code>
          </td>
          <td colSpan={2}>{lineHeight.base}</td>
        </tr>
      </tbody>
    </table>
  );
}

export function TextRoles(): ReactElement {
  return (
    <BothThemes>
      {() => (
        <div className="sb-stack">
          <span style={{ color: 'var(--text)', fontSize: 'var(--fs-md)', fontWeight: 600 }}>--text: the plan for the billing page</span>
          <span style={{ color: 'var(--text-secondary)' }}>--text-secondary: Step 2 of 4, six minutes in</span>
          <span style={{ color: 'var(--text-tertiary)', fontSize: 'var(--fs-sm)' }}>--text-tertiary: updated a minute ago</span>
          <span style={{ color: 'var(--accent)' }}>--accent: a link or the selected thing</span>
        </div>
      )}
    </BothThemes>
  );
}

/* ------------------------------------------------------------------ scales */

export function SpaceScale(): ReactElement {
  return (
    <table className="fd-table">
      <tbody>
        {Object.entries(space).map(([step, px]) => (
          <tr key={step}>
            <td>
              <code>--s{step}</code>
            </td>
            <td>{px}px</td>
            <td style={{ width: '70%' }}>
              <span className="fd-bar" style={{ width: `var(--s${step})` }} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function RadiusScale(): ReactElement {
  return (
    <div className="sb-row" style={{ gap: 'var(--s6)', margin: 'var(--s4) 0' }}>
      {Object.entries(radius).map(([name, px]) => (
        <div key={name} className="sb-stack" style={{ alignItems: 'center', gap: 'var(--s2)' }}>
          <span className="fd-box" style={{ borderRadius: `var(--radius-${name})` }} />
          <code>--radius-{name}</code>
          <span style={{ color: 'var(--text-secondary)', fontSize: 'var(--fs-xs)' }}>{px === 999 ? 'pill' : `${px}px`}</span>
        </div>
      ))}
    </div>
  );
}

export function Elevation(): ReactElement {
  return (
    <BothThemes>
      {() => (
        <div className="sb-row" style={{ gap: 'var(--s8)', padding: 'var(--s4) 0' }}>
          {Object.entries(shadows).map(([name, shadow]) => (
            <div key={name} className="sb-stack" style={{ alignItems: 'center', gap: 'var(--s2)' }}>
              <span className="fd-box" style={{ boxShadow: `var(--shadow-${name})`, borderRadius: 'var(--radius-md)', border: 'none' }} />
              <code>--shadow-{name}</code>
              <span style={{ color: 'var(--text-secondary)', fontSize: 'var(--fs-xs)' }}>
                y {shadow.offsetY} · blur {shadow.blur}
              </span>
            </div>
          ))}
        </div>
      )}
    </BothThemes>
  );
}

const Z_USE: Record<keyof typeof zIndex, string> = {
  raised: 'a sticky header, a selected row above its neighbours',
  dropdown: 'menus, popovers, the command palette list',
  overlay: 'a dialog or drawer and its scrim',
  'overlay-raised': 'a confirm opened from a dialog',
  toast: 'notifications, above any dialog',
  tooltip: 'tooltips, above everything',
};

export function ZIndexScale(): ReactElement {
  const entries = Object.entries(zIndex) as [keyof typeof zIndex, number][];
  return (
    <>
      <table className="fd-table">
        <tbody>
          {entries.map(([name, z]) => (
            <tr key={name}>
              <td>
                <code>--z-{name}</code>
              </td>
              <td>{z}</td>
              <td style={{ color: 'var(--text-secondary)' }}>{Z_USE[name]}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="fd-stack-demo" aria-hidden="true">
        {entries.map(([name], index) => (
          <div key={name} className="fd-stack-demo__layer" style={{ zIndex: `var(--z-${name})`, left: index * 44, top: index * 28 }}>
            --z-{name}
          </div>
        ))}
      </div>
    </>
  );
}

export function ControlHeights(): ReactElement {
  const sizes = Object.keys(controlHeight.comfortable) as (keyof typeof controlHeight.comfortable)[];
  return (
    <table className="fd-table">
      <thead>
        <tr>
          <th>Token</th>
          <th>Comfortable</th>
          <th>Compact</th>
        </tr>
      </thead>
      <tbody>
        {sizes.map((size) => (
          <tr key={size}>
            <td>
              <code>{size === 'md' ? '--control-h' : `--control-h-${size}`}</code>
            </td>
            <td>{controlHeight.comfortable[size]}px</td>
            <td>{controlHeight.compact[size]}px</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function DensityDemo(): ReactElement {
  return (
    <div className="fd-themes">
      {(['comfortable', 'compact'] as const).map((density) => (
        <div key={density} className="fd-panel" data-density={density === 'compact' ? 'compact' : undefined}>
          <div className="fd-panel__label">{density}</div>
          <div className="sb-row">
            <Button variant="primary">Approve</Button>
            <Button>Request changes</Button>
            <input className="input" aria-label={`Search (${density})`} placeholder="Search" style={{ width: 140 }} />
          </div>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ motion */

export function MotionTokens(): ReactElement {
  const durations: [string, number][] = [
    ['--duration-fast', duration.fast],
    ['--duration', duration.base],
    ['--duration-slow', duration.slow],
    ['--duration-shimmer', duration.shimmer],
    ['--duration-pulse', duration.pulse],
  ];
  const easings: [string, string, string][] = [
    ['--ease', easing.standard, 'most transitions'],
    ['--ease-out', easing.enter, 'something arriving: a dialog, a toast'],
    ['--ease-in', easing.exit, 'something leaving'],
  ];
  return (
    <>
      <table className="fd-table">
        <tbody>
          {durations.map(([token, ms]) => (
            <tr key={token}>
              <td>
                <code>{token}</code>
              </td>
              <td>{ms}ms</td>
              <td>
                <MotionSample duration={`var(${token})`} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <table className="fd-table">
        <tbody>
          {easings.map(([token, curve, use]) => (
            <tr key={token}>
              <td>
                <code>{token}</code>
              </td>
              <td>
                <code>{curve}</code>
              </td>
              <td style={{ color: 'var(--text-secondary)' }}>{use}</td>
              <td>
                <MotionSample duration="var(--duration-slow)" ease={`var(${token})`} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

/** Hover or focus the track to play the move. */
function MotionSample({ duration: d, ease = 'var(--ease)' }: { duration: string; ease?: string }): ReactElement {
  return (
    <button type="button" className="fd-motion-track" aria-label="Play the move (hover or focus)">
      <div className="fd-motion" style={{ transition: `transform ${d} ${ease}` }} />
    </button>
  );
}

/* -------------------------------------------------------------- focus ring */

export function FocusRingDemo(): ReactElement {
  return (
    <>
      <table className="fd-table">
        <tbody>
          <tr>
            <td>
              <code>--focus-ring</code>
            </td>
            <td>the colour, ≥ 3:1 on every surface</td>
          </tr>
          <tr>
            <td>
              <code>--focus-ring-width</code>
            </td>
            <td>{focusRing.width}px</td>
          </tr>
          <tr>
            <td>
              <code>--focus-ring-offset</code>
            </td>
            <td>{focusRing.offset}px</td>
          </tr>
        </tbody>
      </table>
      <BothThemes>
        {() => (
          <div className="sb-stack">
            <div className="sb-row" style={{ gap: 'var(--s5)' }}>
              {(['canvas', 'surface', 'surface-raised', 'surface-sunken'] as const).map((surface) => (
                <div key={surface} className="sb-stack" style={{ alignItems: 'center', gap: 'var(--s2)', padding: 'var(--s3)', background: `var(--${surface})`, borderRadius: 'var(--radius-md)' }}>
                  <span className="fd-box fd-box--focus" />
                  <code style={{ fontSize: 'var(--fs-micro)' }}>--{surface}</code>
                </div>
              ))}
            </div>
            <div className="sb-row">
              <Button>Tab to me</Button>
              <Button variant="primary">And me</Button>
              <input className="input" aria-label="A field" placeholder="And this field" style={{ width: 160 }} />
            </div>
          </div>
        )}
      </BothThemes>
    </>
  );
}

/* ------------------------------------------------------------------- icons */

export function IconGrid(): ReactElement {
  const [query, setQuery] = useState('');
  const names = (Object.keys(ICON_PATHS) as IconName[]).filter((name) => name.toLowerCase().includes(query.trim().toLowerCase()));
  return (
    <>
      <input
        className="input fd-icons-search"
        type="search"
        aria-label="Search the icons"
        placeholder={`Search ${Object.keys(ICON_PATHS).length} icons`}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <div className="fd-icons" role="list" aria-label="Icons">
        {names.map((name) => (
          <div key={name} className="fd-icon" role="listitem">
            <Icon name={name} size={20} />
            <code>{name}</code>
          </div>
        ))}
      </div>
      {names.length === 0 ? <p style={{ color: 'var(--text-secondary)' }}>No icon matches “{query}”.</p> : null}
    </>
  );
}

/* -------------------------------------------------------------------- logo */

export function LogoVariants(): ReactElement {
  return (
    <BothThemes>
      {() => (
        <div className="sb-stack">
          <div className="sb-row" style={{ gap: 'var(--s5)', alignItems: 'flex-end' }}>
            {[16, 22, 32, 48, 72].map((size) => (
              <div key={size} className="sb-stack" style={{ alignItems: 'center', gap: 'var(--s1)' }}>
                <Logo size={size} />
                <span style={{ color: 'var(--text-secondary)', fontSize: 'var(--fs-xs)' }}>{size}px</span>
              </div>
            ))}
          </div>
          <div className="sb-row" style={{ gap: 'var(--s5)' }}>
            <span className="sb-row" style={{ fontWeight: 650, fontSize: 'var(--fs-md)' }}>
              <Logo size={22} /> Tandemise
            </span>
            <span className="sb-row" style={{ color: 'var(--text-tertiary)' }}>
              <Logo size={22} muted /> muted: nothing to connect to
            </span>
          </div>
        </div>
      )}
    </BothThemes>
  );
}

/** The emitted SVG assets, as an app or a website loads them. */
export function LogoAssets(): ReactElement {
  const assets: [string, ThemeName | undefined][] = [
    ['logo-mark.svg', undefined],
    ['logo-mark-on-dark.svg', 'dark'],
    ['logo-mark-on-light.svg', 'light'],
    ['logo-mark-template.svg', 'light'],
    ['app-icon.svg', undefined],
  ];
  return (
    <div className="fd-grid">
      {assets.map(([file, theme]) => (
        <div key={file} className="fd-logo-tile" data-theme={theme} style={{ background: 'var(--canvas)' }}>
          <img src={`./brand/${file}`} width={64} height={64} alt={file} />
          <code>{file}</code>
        </div>
      ))}
    </div>
  );
}
