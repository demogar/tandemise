# @tandemise/design

The Tandemise design system as a package: the brand palette, the light/dark
semantic roles, type, spacing, radius and motion tokens, the logo and the icon
set. It is what the Tandemise desktop app is built from, and what any other
Tandemise surface (the website, docs, a dashboard) can share so they all read
as one product.

- **One source.** Every token is authored once, in
  [`src/tokens.ts`](src/tokens.ts). The CSS, the Tailwind theme and the logo SVGs
  are emitted from it, committed, and checked for staleness in CI.
- **Framework-free.** CSS custom properties plus plain TypeScript data. No
  React, no runtime dependency, no imports at all; React 18 and React 19 apps
  draw the same icons and logo from the same data.
- **Light and dark are peers.** Each colour role is written once as
  `light-dark(<light>, <dark>)`; `color-scheme` picks the theme.

```bash
npm install @tandemise/design
```

## What is in it

| Import | What |
|---|---|
| `@tandemise/design/tokens.css` | Every token as a CSS custom property: palette, roles (both themes), shadows, radius, spacing, type, motion, the focus ring, the z-index scale and control heights (with a `[data-density='compact']` set). |
| `@tandemise/design/base.css` | A small reset and type defaults built on the roles (body colours and font, focus ring, selection, scrollbars, reduced motion). Import after tokens.css. |
| `@tandemise/design/tailwind.css` | A Tailwind v4 theme (`@theme`) with the palette as utilities and the roles bridged to tokens.css. |
| `@tandemise/design` | The tokens as typed data (`palette`, `colorRoles`, `radius`, `space`, `fontSize`, ...), `resolveTheme()`, `contrast()`, the Tailwind v3 `tailwindPreset`, `LOGO` and `ICON_PATHS`. |
| `@tandemise/design/tokens`, `/icons`, `/logo`, `/resolve`, `/tailwind` | The same, one module at a time, for bundles that want only one. |
| `@tandemise/design/assets/*` | `app-icon.svg` / `app-icon.png` (the tile icon), `logo-mark.svg` (follows the viewer's scheme), `logo-mark-on-dark.svg`, `logo-mark-on-light.svg`, `logo-mark-template.svg` (black, for macOS template images). |

## The token rules

Two layers, and one rule that makes them a contract:

```
palette   hues      --brand-mint  --ink-900  --signal-red-bright ...
   │        only the roles read these
   ▼
roles     purpose   --canvas  --text  --accent  --status-failed ...
   │        apps read only these
   ▼
your CSS / components
```

1. **Colour is a role, never a hue at the call site.** Ask for `--status-failed`
   or `--accent`, never for "red" or a hex value. A theme then changes in one
   place, and light mode is not a pile of overrides.
2. **Raw colours live in `src/tokens.ts` only.** Everything else - this
   package's own CSS, and any app built on it - reads custom properties. The
   Tandemise repo enforces this with `npm run check:design`.
3. **No `var()` fallbacks.** Tokens are always defined, so a fallback only hides
   a typo.
4. **`light-dark()` takes colours only.** To vary a shadow or a percentage by
   theme, mix inside each branch (`--shadow-*` shows how).
5. **Contrast is measured, not remembered.** `CONTRAST_PAIRS` lists what the
   system promises (body text >= 10:1 on every surface, secondary and tertiary
   text and every status colour >= 4.5:1, accent text on accent >= 12:1, tooltip
   text >= 10:1, the focus ring >= 3:1 on every surface), and the check
   measures each pairing in both themes.

### Brand anchors

| Token | Hex | Role |
|---|---|---|
| `--brand-mint` | `#c4f1be` | Dark-theme accent, logo lead wheel on dark, text on indigo |
| `--brand-sage` | `#a2c3a4` | Logo trailing wheel on dark, source of the light neutrals |
| `--brand-lichen` | `#869d96` | Tertiary text on dark, logo axle, pending state |
| `--brand-slate` | `#525b76` | Secondary text on light, logo trailing wheel on light |
| `--brand-indigo` | `#201e50` | Light-theme accent and text, app icon tile, source of the dark neutrals |

The ramps (`--ink-*` for dark surfaces, `--paper-*` for light ones, anchor tints
and shades, `--signal-*-bright` / `-deep`) are derived from these in OKLCH.
[docs/DESIGN_SYSTEM.md](../../docs/DESIGN_SYSTEM.md) has every role, the
theming rules, the logo rules and the component vocabulary of the desktop app.

### Theming

| Root element | `color-scheme` | Result |
|---|---|---|
| no `data-theme` | `dark light` | follows the OS |
| `data-theme="light"` | `light` | light |
| `data-theme="dark"` | `dark` | dark |

`data-theme` works on any element, not only the root: the roles are redeclared
on every `[data-theme]` element, so a dark panel inside a light page is dark
even after a bundler lowers `light-dark()` for older browsers.

## Using it

### In the desktop app (Vite / Electron)

```ts
// main.tsx - order matters: tokens, then the reset, then the app's own CSS.
import '@tandemise/design/tokens.css';
import '@tandemise/design/base.css';
import './styles/shell.css';
```

```tsx
import { ICON_PATHS, ICON_STROKE_WIDTH, type IconName } from '@tandemise/design/icons';

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth={ICON_STROKE_WIDTH} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={ICON_PATHS[name]} />
    </svg>
  );
}
```

Code that cannot read CSS (a canvas, the Electron main process before the first
paint) takes resolved values:

```ts
import { resolveTheme } from '@tandemise/design/resolve';
resolveTheme('dark').canvas; // '#0d0e1e'
resolveTheme('light')['accent-soft']; // '#201e5014' (a wash keeps its alpha)
```

### In a Next.js / Tailwind v4 site

```css
/* app/globals.css */
@import 'tailwindcss';
@import '@tandemise/design/tokens.css';
@import '@tandemise/design/tailwind.css';
```

```tsx
<body className="bg-ink-1000 text-mint-50">            {/* palette: literal hues */}
<section className="bg-canvas text-text-secondary">    {/* roles: follow the theme */}
```

A dark-only site sets `<html data-theme="dark">`. Utility names: a brand anchor
drops its `brand-` prefix (`bg-mint`, `stroke-lichen`), every other hue is its
token name (`bg-ink-950`, `text-lichen-300`, `text-signal-amber-bright`), and a
role is its role name (`bg-surface-raised`, `border-border`). Loading
tokens.css also gives Tailwind's `rounded-*` and `shadow-sm/md/lg` the
Tandemise values, since they share names.

The logo, as an image or inline:

```tsx
import mark from '@tandemise/design/assets/logo-mark-on-dark.svg';
// or draw it from LOGO (`@tandemise/design/logo`) with the --logo-* roles.
```

### With Tailwind v3

```js
// tailwind.config.js
import { tailwindPreset } from '@tandemise/design/tailwind';
export default { presets: [tailwindPreset], content: ['./src/**/*.{ts,tsx}'] };
```

## Changing a token

1. Edit [`src/tokens.ts`](src/tokens.ts). A new colour goes in `palette`,
   derived from an anchor in OKLCH; give it a role in `colorRoles` in the same
   change. Name a role for its purpose (`surface-overlay`), not its look.
2. `npm run build && npm run -w @tandemise/design emit` to regenerate
   `css/tokens.css`, `css/tailwind.css` and the logo SVGs.
3. `npm run check:design` - stale files, broken contrast, stray colour
   literals and undefined tokens all fail it.

The app icon (`assets/app-icon.svg`) is hand-drawn at 1024px and may use only
palette hex values; `npm run icons` in the Tandemise repo rasterises it.

## License

Apache-2.0
