#!/usr/bin/env node
// Writes gallery/index.html: every token and every React component of the
// package, side by side in light and dark - the visual reference for the
// design system. The page is static (react-dom/server) and links the package's
// own stylesheets, so it shows exactly what an app importing them gets.
//
//   npm run -w @tandemise/design build && npm run -w @tandemise/design gallery
//   node packages/design/scripts/gallery.mjs --check   fails if the page is stale (check:design runs it)
//
// Reads the compiled modules in dist/, so build first. Open the file in a
// browser straight from disk; it needs no server.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const pkg = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = (file) => pathToFileURL(join(pkg, 'dist', file)).href;
if (!existsSync(join(pkg, 'dist/react/index.js'))) {
  console.error('@tandemise/design: dist/ is missing - run `npm run build` first');
  process.exit(1);
}
const React = (await import('react')).default;
const { renderToStaticMarkup } = await import('react-dom/server');
const tokens = await import(dist('index.js'));
const ui = await import(dist('react/index.js'));
const h = React.createElement;

const { palette, colorRoles, radius, space, fontSize, shadows, duration, easing, zIndex, controlHeight, ICON_PATHS, GENERATED_NOTE } = {
  ...tokens,
  GENERATED_NOTE: (await import(dist('css.js'))).GENERATED_NOTE,
};

/* ------------------------------------------------------------------ pieces */

const Section = ({ id, title, children, note }) =>
  h('section', { className: 'g-section', id }, h('h2', { className: 'g-h2' }, title), note ? h('p', { className: 'g-note' }, note) : null, children);

/** The same content in a light and a dark panel. */
const Themes = ({ children, component }) =>
  h(
    'div',
    { className: 'g-themes', 'data-component': component },
    ['light', 'dark'].map((theme) =>
      h('div', { key: theme, className: 'g-panel', 'data-theme': theme }, h('div', { className: 'g-panel__label' }, theme), children),
    ),
  );

const Row = ({ children }) => h('div', { className: 'g-row' }, children);

const Swatch = ({ name, value, sub }) =>
  h(
    'div',
    { className: 'g-swatch' },
    h('div', { className: 'g-swatch__chip', style: { background: value } }),
    h('code', { className: 'g-swatch__name' }, name),
    sub ? h('span', { className: 'g-swatch__sub' }, sub) : null,
  );

/* ------------------------------------------------------------------- tokens */

const paletteSection = h(
  Section,
  { id: 'palette', title: 'Palette', note: 'Hues. Only the roles read these; apps read roles.' },
  h('div', { className: 'g-grid' }, Object.entries(palette).map(([name, hex]) => h(Swatch, { key: name, name: `--${name}`, value: `var(--${name})`, sub: hex }))),
);

const rolesSection = h(
  Section,
  { id: 'roles', title: 'Colour roles', note: 'What a colour is for, written once for both themes.' },
  h(Themes, { component: 'roles' }, h('div', { className: 'g-grid' }, Object.keys(colorRoles).map((name) => h(Swatch, { key: name, name: `--${name}`, value: `var(--${name})` })))),
);

const scaleTable = (rows) =>
  h('table', { className: 'g-table' }, h('tbody', null, rows.map(([token, value, sample]) => h('tr', { key: token }, h('td', null, h('code', null, token)), h('td', null, value), h('td', null, sample ?? null)))));

const scalesSection = h(
  Section,
  { id: 'scales', title: 'Scales' },
  h('h3', { className: 'g-h3' }, 'Type'),
  scaleTable(Object.entries(fontSize).map(([n, px]) => [`--fs-${n}`, `${px}px`, h('span', { style: { fontSize: `var(--fs-${n})` } }, 'Hand the work on')])),
  h('h3', { className: 'g-h3' }, 'Spacing'),
  scaleTable(Object.entries(space).map(([n, px]) => [`--s${n}`, `${px}px`, h('span', { className: 'g-bar', style: { width: `var(--s${n})` } })])),
  h('h3', { className: 'g-h3' }, 'Radius'),
  scaleTable(Object.entries(radius).map(([n, px]) => [`--radius-${n}`, `${px}px`, h('span', { className: 'g-box', style: { borderRadius: `var(--radius-${n})` } })])),
  h('h3', { className: 'g-h3' }, 'Elevation'),
  scaleTable(Object.keys(shadows).map((n) => [`--shadow-${n}`, '', h('span', { className: 'g-box', style: { boxShadow: `var(--shadow-${n})` } })])),
  h('h3', { className: 'g-h3' }, 'Motion'),
  scaleTable([
    ['--duration-fast', `${duration.fast}ms`],
    ['--duration', `${duration.base}ms`],
    ['--duration-slow', `${duration.slow}ms`],
    ['--duration-shimmer', `${duration.shimmer}ms`],
    ['--duration-pulse', `${duration.pulse}ms`],
    ['--ease', easing.standard],
    ['--ease-out', easing.enter],
    ['--ease-in', easing.exit],
  ]),
  h('h3', { className: 'g-h3' }, 'Focus ring'),
  scaleTable([['--focus-ring-width', '2px', h('span', { className: 'g-box g-box--focus' })], ['--focus-ring-offset', '2px']]),
  h('h3', { className: 'g-h3' }, 'Stacking'),
  scaleTable(Object.entries(zIndex).map(([n, z]) => [`--z-${n}`, String(z)])),
  h('h3', { className: 'g-h3' }, 'Control heights'),
  scaleTable(
    Object.entries(controlHeight.comfortable).map(([n, px]) => [
      n === 'md' ? '--control-h' : `--control-h-${n}`,
      `${px}px · compact ${controlHeight.compact[n]}px`,
    ]),
  ),
);

/* --------------------------------------------------------------- components */

const { Button, Badge, StatusPill, StatusDot, Card, Icon, Logo, Field, Dialog, Tabs, Tab, Tooltip, EmptyState } = ui;
const noop = () => {};
const TONES = ['running', 'blocked', 'failed', 'succeeded', 'pending'];

const demos = {
  Button: h(
    'div',
    { className: 'g-stack' },
    h(Row, null, h(Button, { variant: 'primary' }, 'Approve plan'), h(Button, null, 'Request changes'), h(Button, { variant: 'ghost' }, 'Skip'), h(Button, { variant: 'danger' }, 'Cancel mission')),
    h(Row, null, h(Button, { variant: 'primary', size: 'lg' }, h(Icon, { name: 'plus', size: 14 }), 'New mission'), h(Button, { iconOnly: true, variant: 'ghost', 'aria-label': 'Close' }, h(Icon, { name: 'x', size: 14 })), h(Button, { disabled: true }, 'Disabled')),
    h(Row, null, h(Button, { loading: true }, 'Saving'), h(Button, { variant: 'primary', loading: true, loadingLabel: 'Working…' }, 'Confirm')),
    h('div', { 'data-density': 'compact' }, h(Row, null, h(Button, null, 'Compact density'), h(Button, { variant: 'primary' }, 'Compact primary'))),
  ),
  Badge: h(Row, null, ...TONES.map((tone) => h(Badge, { key: tone, tone }, tone)), h(Badge, { tone: 'accent' }, 'accent'), h(Badge, { tone: 'release' }, 'release')),
  StatusPill: h(Row, null, ...TONES.map((tone) => h(StatusPill, { key: tone, tone, label: tone, live: tone === 'running' })), h(StatusPill, { tone: 'succeeded', label: 'Merged', icon: h(Icon, { name: 'check', size: 12 }) })),
  StatusDot: h(Row, null, ...TONES.map((tone) => h(StatusDot, { key: tone, tone, 'aria-label': tone })), h(StatusDot, { tone: 'running', live: true })),
  Card: h(
    'div',
    { className: 'g-stack' },
    h(Card, null, 'A plain card groups one thing.'),
    h(Card, { title: 'Checks', actions: h(Button, { variant: 'ghost' }, 'Re-run') }, 'Tests passed on the last round.'),
  ),
  Icon: h('div', { className: 'g-icons' }, Object.keys(ICON_PATHS).map((name) => h('span', { key: name, className: 'g-icon', title: name }, h(Icon, { name, size: 16 }), h('code', null, name)))),
  Logo: h(Row, null, h(Logo, { size: 16 }), h(Logo, { size: 22 }), h(Logo, { size: 40, title: 'Tandemise' }), h(Logo, { size: 40, muted: true })),
  Field: h(
    'div',
    { className: 'g-stack g-narrow' },
    h(Field, { label: 'Mission title', hint: 'What outcome do you want?' }, h('input', { className: 'input', defaultValue: 'Ship the settings page' })),
    h(Field, { label: 'Done when', required: true, error: 'Say what done means.' }, (control) => h('input', { className: 'input', ...control })),
    h(Field, { label: 'Repository' }, h('select', { className: 'select', defaultValue: 'web' }, h('option', { value: 'web' }, 'tandemise-web'))),
    h(Field, { label: 'Note' }, h('textarea', { className: 'textarea', defaultValue: 'The next round works from exactly what you write.' })),
  ),
  Dialog: h(
    'div',
    { className: 'g-dialog-frame' },
    h(
      Dialog,
      {
        title: 'Cancel this mission?',
        description: 'Running steps stop; their work so far is kept.',
        onClose: noop,
        footer: [h(Button, { key: 'c', variant: 'ghost' }, 'Keep it'), h(Button, { key: 'd', variant: 'danger', 'data-autofocus': true }, 'Cancel mission')],
      },
      'Nothing is deleted. You can start it again from the backlog.',
    ),
  ),
  Tabs: h(Tabs, { label: 'Team sections' }, h(Tab, { selected: true, count: 8 }, 'You & agents'), h(Tab, { selected: false }, 'Staffing'), h(Tab, { selected: false }, 'Roles')),
  Tab: h(Tabs, { label: 'Board sections' }, h(Tab, { as: 'a', href: '#tab', selected: false, count: 12 }, 'Board'), h(Tab, { as: 'a', href: '#tab', selected: true, count: 3 }, 'Intake')),
  Tooltip: h(
    Row,
    null,
    h(Tooltip, { content: 'Copied to the clipboard' }, (trigger) => h(Button, { ...trigger }, 'Hover or focus me')),
    h('span', { role: 'tooltip', className: 'tooltip g-static-tooltip' }, 'A tooltip, drawn in place'),
  ),
  EmptyState: h(
    Card,
    { flush: true },
    h(EmptyState, { icon: h(Icon, { name: 'sparkle', size: 18 }), title: 'No missions yet', body: 'A mission is one outcome, planned into steps your agents and you work through.', action: h(Button, { variant: 'primary' }, 'New mission') }),
  ),
};

const missing = ui.COMPONENTS.filter((name) => !(name in demos));
if (missing.length) {
  console.error(`gallery: no demo for ${missing.join(', ')} - add one to scripts/gallery.mjs`);
  process.exit(1);
}

const componentsSection = h(
  Section,
  { id: 'components', title: 'Components', note: 'From @tandemise/design/react, over @tandemise/design/components.css.' },
  ui.COMPONENTS.map((name) =>
    h('div', { key: name, className: 'g-component', id: `component-${name}` }, h('h3', { className: 'g-h3' }, h('code', null, `<${name}>`)), h(Themes, { component: name }, demos[name])),
  ),
);

/* --------------------------------------------------------------------- page */

const body = renderToStaticMarkup(
  h(
    'main',
    { className: 'g-page' },
    h('header', { className: 'g-header' }, h(Logo, { size: 32 }), h('div', null, h('h1', { className: 'g-h1' }, 'Tandemise design system'), h('p', { className: 'g-note' }, 'Every token and component of @tandemise/design, in light and dark.'))),
    h('nav', { className: 'g-nav' }, ['palette', 'roles', 'scales', 'components'].map((id) => h('a', { key: id, href: `#${id}` }, id))),
    paletteSection,
    rolesSection,
    scalesSection,
    componentsSection,
  ),
);

// Gallery layout only. Roles and scales, like everything else in the package.
const GALLERY_CSS = `
body { overflow: auto; }
.g-page { max-width: 1240px; margin: 0 auto; padding: var(--s8) var(--s6) var(--s16); }
.g-header { display: flex; align-items: center; gap: var(--s4); margin-bottom: var(--s4); }
.g-h1 { font-size: var(--fs-xl); font-weight: 650; letter-spacing: -0.02em; }
.g-h2 { font-size: var(--fs-lg); font-weight: 620; margin-bottom: var(--s2); }
.g-h3 { font-size: var(--fs-sm); font-weight: 600; color: var(--text-secondary); margin: var(--s5) 0 var(--s2); }
.g-note { color: var(--text-secondary); font-size: var(--fs-sm); margin-bottom: var(--s3); }
.g-nav { display: flex; gap: var(--s4); margin-bottom: var(--s8); font-size: var(--fs-sm); text-transform: capitalize; }
.g-section { margin-bottom: var(--s12); }
.g-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: var(--s3); }
.g-swatch { display: flex; flex-direction: column; gap: 4px; font-size: var(--fs-xs); }
.g-swatch__chip { height: 40px; border-radius: var(--radius-sm); border: 1px solid var(--border); }
.g-swatch__name { color: var(--text); word-break: break-all; }
.g-swatch__sub { color: var(--text-tertiary); font-family: var(--font-mono); }
.g-themes { display: grid; grid-template-columns: 1fr 1fr; gap: var(--s3); }
.g-panel { position: relative; background: var(--canvas); color: var(--text); border: 1px solid var(--border); border-radius: var(--radius-lg); padding: var(--s8) var(--s5) var(--s5); min-width: 0; }
.g-panel__label { position: absolute; top: var(--s2); left: var(--s3); font-size: var(--fs-micro); text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-tertiary); }
.g-row { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s2); }
.g-stack { display: flex; flex-direction: column; gap: var(--s3); }
.g-narrow { max-width: 360px; }
.g-table { border-collapse: collapse; font-size: var(--fs-sm); }
.g-table td { padding: var(--s1) var(--s4) var(--s1) 0; border-bottom: 1px solid var(--border); vertical-align: middle; }
.g-bar { display: inline-block; height: 8px; background: var(--accent); border-radius: var(--radius-xs); }
.g-box { display: inline-block; width: 40px; height: 28px; background: var(--surface-raised); border: 1px solid var(--border-strong); }
.g-box--focus { outline: var(--focus-ring-width) solid var(--focus-ring); outline-offset: var(--focus-ring-offset); border-radius: var(--radius-xs); }
.g-icons { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: var(--s2); }
.g-icon { display: flex; align-items: center; gap: var(--s2); font-size: var(--fs-xs); color: var(--text-secondary); }
.g-dialog-frame { position: relative; height: 260px; overflow: hidden; border-radius: var(--radius-md); }
.g-dialog-frame .overlay { position: absolute; animation: none; }
.g-dialog-frame .modal { animation: none; }
.g-static-tooltip { position: static; animation: none; }
`;

const html = `<!doctype html>
<!--
  @tandemise/design - the gallery: every token and component, light and dark.
  ${GENERATED_NOTE.replace('`npm run -w @tandemise/design emit`', '`npm run -w @tandemise/design gallery`')}
-->
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Tandemise design system</title>
<link rel="stylesheet" href="../css/tokens.css" />
<link rel="stylesheet" href="../css/base.css" />
<link rel="stylesheet" href="../css/components.css" />
<style>${GALLERY_CSS}</style>
</head>
<body>
${body}
</body>
</html>
`;

const target = join(pkg, 'gallery/index.html');
if (process.argv.includes('--check')) {
  const current = existsSync(target) ? readFileSync(target, 'utf8') : null;
  if (current !== html) {
    console.error(`@tandemise/design: stale - regenerate with \`npm run -w @tandemise/design gallery\`:\n  ${relative(process.cwd(), target)}`);
    process.exit(1);
  }
  console.log('design-gallery-ok');
} else {
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, html);
  console.log(`wrote ${relative(process.cwd(), target)}`);
}
