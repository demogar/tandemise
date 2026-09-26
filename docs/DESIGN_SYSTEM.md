# Design System

The contract for how the Tandemise desktop app looks and behaves. If the code
disagrees with this document, one of them is wrong. `npm run check:design`
enforces the parts a machine can check, and CI runs it on every pull request.

## Principles

- **Colour is a role, never a hue at the call site.** A screen asks for
  `--status-failed` or `--accent`, never for "red" or `#f47c6b`. That is what
  lets a theme change in one file and keeps light mode from turning into a pile
  of overrides.
- **Dark and light are peers.** Every role is defined for both schemes in the
  same declaration, so neither can fall behind the other.
- **Quiet chrome, loud decisions.** Surfaces are near-neutral. Saturated colour
  is reserved for what needs a human: status, risk, and the one primary action
  on a screen.
- **The brand shows up in miniature.** The five palette anchors run through the
  neutrals, the accent, the logo and the identity tints. None of them takes over
  a screen.

## Layers

```
palette.css   hues        --brand-mint, --ink-900, --signal-red-bright …
     │          only theme.css may read these
     ▼
theme.css     roles       --canvas, --text, --accent, --status-failed …
     │          everything else reads only these
     ▼
components    shell.css, controls.css, surfaces.css, features.css, *.tsx
```

All of them live in `apps/desktop/src/renderer/src/styles/`, and `main.tsx`
imports them in that order.

## Palette

### Brand anchors

| Token | Hex | Name | Role in the system |
|---|---|---|---|
| `--brand-mint` | `#C4F1BE` | Mint | Dark-theme accent, logo lead wheel on dark, text on indigo |
| `--brand-sage` | `#A2C3A4` | Sage | Logo trailing wheel on dark, source of the light neutrals |
| `--brand-lichen` | `#869D96` | Lichen | Tertiary text on dark, logo axle, pending state |
| `--brand-slate` | `#525B76` | Slate | Secondary text on light, logo trailing wheel on light |
| `--brand-indigo` | `#201E50` | Indigo | Light-theme accent and text, app icon tile, source of the dark neutrals |

### Derived ramps

Every ramp is derived from the anchors in OKLCH, so the steps look even and the
neutrals keep the brand's hue instead of turning flat grey.

- **`--ink-*`** (1000 → 700): indigo, desaturated and darkened. These are the
  dark-theme surfaces and borders.
- **`--paper-*`** (0 → 300): sage, almost white. These are the light-theme
  surfaces and borders.
- **Anchor tints and shades** (`--mint-50/100/700`, `--sage-700`,
  `--lichen-300/700/750`, `--slate-300`, `--indigo-300/500/600/900`) cover the
  spots where an anchor fails contrast, such as mint text on white.
- **`--signal-*-bright` / `--signal-*-deep`**: status hues (blue, green, amber,
  red, violet), pulled toward the brand. `-bright` is for ink surfaces and
  `-deep` is for paper surfaces.

Palette values are 6-digit hex only. Add a colour here only when no existing
step can do the job, and give it a role in `theme.css` in the same change.

## Semantic roles

Each colour role is written once as `light-dark(<light>, <dark>)`.

| Group | Roles | Light | Dark |
|---|---|---|---|
| Surfaces | `--canvas` `--surface` `--surface-raised` `--surface-sunken` `--surface-hover` `--surface-active` | paper | ink |
| Borders | `--border` `--border-strong` `--border-focus` | paper 150/300, indigo-500 focus | ink 800/700, mint focus |
| Text | `--text` `--text-secondary` `--text-tertiary` `--text-inverse` | indigo / slate / lichen-750 | mint-50 / lichen-300 / lichen |
| Accent | `--accent` `--accent-hover` `--accent-text` `--accent-soft` `--accent-line` | **indigo** fill, mint text | **mint** fill, indigo text |
| Status | `--status-{running,blocked,failed,succeeded,pending}` and `-soft` | signal deep | signal bright |
| Risk | `--risk-{read,write,external,destructive,release}` | aliases of status, plus violet for release | |
| Brand | `--logo-lead` `--logo-trail` `--logo-axle` | indigo / slate / lichen | mint / sage / lichen |
| Identity | `--tint-1` … `--tint-5` | shades of the anchors | the anchors |
| Elevation | `--shadow-sm` `--shadow-md` `--shadow-lg` | indigo at 8–18% | ink-1000 at 45–62% |

**Contrast.** Body text is above 10:1 in both themes. `--text-tertiary` is at
least 4.5:1 on every surface it sits on, from `--canvas` to `--surface-hover`
(6.6:1 or better in dark, 4.8:1 or better in light). Every `--status-*` colour
is at least 4.5:1 on `--surface`, so it can be used as text as well as a dot.
`--accent-text` on `--accent` is 12:1.

**Status versus accent.** In dark mode the accent (mint) and success (green)
are both green. Green is the brand. They stay apart because success is more
saturated and always comes with a dot, an icon or a label. Never show success
with the accent colour, and never style a primary action in the success colour.

### Non-colour tokens

| Group | Tokens |
|---|---|
| Spacing (4pt) | `--s1` 4 · `--s2` 8 · `--s3` 12 · `--s4` 16 · `--s5` 20 · `--s6` 24 · `--s7` 28 · `--s8` 32 · `--s10` 40 · `--s12` 48 · `--s16` 64 |
| Radius | `--radius-xs` 4 · `--radius-sm` 6 · `--radius-md` 9 · `--radius-lg` 13 · `--radius-full` |
| Type | `--font-sans` (system UI) · `--font-mono` · `--fs-micro` 10.5 · `--fs-xs` 11.5 · `--fs-sm` 12.5 · `--fs-base` 13.5 · `--fs-md` 15 · `--fs-lg` 18 · `--fs-xl` 23 · `--fs-2xl` 30 |
| Motion | `--duration-fast` 120ms · `--duration` 160ms · `--ease`. `prefers-reduced-motion` turns all motion off. |
| Layout | `--sidebar-width` 232 |

## Theming

The theme is chosen by `color-scheme` on `:root` and nothing else:

| Preference (`lib/theme.ts`) | Root element | `color-scheme` |
|---|---|---|
| System (default) | no `data-theme` | `dark light` (follows macOS) |
| Light | `data-theme="light"` | `light` |
| Dark | `data-theme="dark"` | `dark` |

`light-dark()` accepts only colours. To vary a percentage, a length or a shadow
by theme, mix inside each branch:
`light-dark(color-mix(… 8% …), color-mix(… 12% …))`. Chromium silently drops a
declaration that breaks this rule, and the check catches it.

The main process paints the window before any CSS loads, so
`src/shared/brand.ts` repeats the two `--canvas` values. The check fails if they
drift from `palette.css`.

## Logo

The mark is two wheels on one axle: a tandem. It also reads as two nodes on an
edge, which is what the app does, handing one piece of work from one worker to
the next. The lead wheel is larger, so the mark has a direction of travel.

There is one mark, drawn at three optical sizes:

| Drawing | File | Used for | Colour |
|---|---|---|---|
| App icon | `apps/desktop/build/icon.svg` → `icon.icns`, `icon.png` | Dock, About panel, installers | Indigo tile; mint→sage lead wheel, sage→lichen trailing wheel, lichen axle |
| In-app mark | `components/Logo.tsx` | Sidebar, onboarding, daemon-down | `--logo-lead` / `--logo-trail` / `--logo-axle` |
| Menu bar | `apps/desktop/build/tray.svg` → `resources/trayTemplate*.png` | macOS menu bar | Pure black. macOS recolours template images, so the palette does not apply here. |

Rules:

- **Change the geometry in all three drawings or in none.** The in-app mark uses
  the menu-bar geometry because both are drawn at about 20px.
- **Colour comes from the palette only.** `icon.svg` may contain only palette
  hex values, and the check rejects anything else. `Logo.tsx` uses the
  `--logo-*` roles, never `currentColor`.
- **Muted state.** `<Logo muted />` draws every part in `--text-tertiary`. It
  means "nothing to connect to" (the daemon-down screen). Do not use it for
  decoration.
- **Don'ts.** Do not make the wheels touch, because that reads as an infinity
  sign. Do not make them the same size, because that reads as spectacles. Do
  not run the axle through the wheels. Do not add a hub, which turns into a blob
  at 16px. Do not recolour the wheels outside the palette.
- **Minimum size** is 16px. **Clear space** around the mark is at least half its
  height.
- **Regenerate** the raster icons after editing either SVG with
  `npm run icons`.

## Component vocabulary

Build screens from these classes before inventing new ones. Each class uses
roles only.

| Need | Use |
|---|---|
| Actions | `.btn`, plus `--primary` (at most one per view), `--ghost`, `--danger`, `--lg`, `--icon`, `--block` |
| State | `.badge--{running,blocked,failed,succeeded,release,accent}`, `.dot--{tone}`, `.dot--pulse` for live |
| Inputs | `.field`, `.input`, `.textarea`, `.select`, `.segmented`, `.switch`, `.search` |
| Containers | `.card`, `.list` / `.list__row`, `.table`, `.banner--{accent,warn}`, `.modal`, `.overlay`, `.palette` |
| Values | `.chip`, `.idchip` (copyable id), `.mono`, `.stat`, `.meter` |
| Identity | `.monogram[data-tint=1..5]` for things with no icon of their own |
| Empty and error | `.empty`, `.errorstate`, `.skeleton` |
| Icons | `components/Icon.tsx`: stroke icons drawn in `currentColor` at 1.7 weight on a 24px grid |

Status always maps through `Tone` (`lib/format.ts`):
`running | blocked | failed | succeeded | pending`. Add a tone there and in
`theme.css` together.

## Enforced rules

`npm run check:design` (`scripts/check-design-system.mjs`) fails the build when:

1. A colour literal (hex, `rgb()`, `hsl()`, `oklch()` …) appears anywhere in the
   desktop source outside `palette.css` and `src/shared/brand.ts`. Inline
   `style={{ color: … }}` counts.
2. A palette primitive is read outside `theme.css`.
3. `var(--token)` names a token that nothing defines.
4. A `var()` has a fallback. Tokens are always defined, so a fallback only
   hides a typo.
5. `light-dark()` is given something other than colours.
6. `icon.svg` uses a colour outside the palette, or `tray.svg` uses anything
   but black.
7. `src/shared/brand.ts` drifts from the palette.

## Changing the system

- **New role:** add it to `theme.css` with both schemes, then use it. Name it
  for its purpose (`--surface-overlay`), not its look (`--dark-grey`).
- **New colour:** add the hue to `palette.css`, derived from an anchor in OKLCH,
  and check its contrast against the surfaces it will sit on.
- **New brand anchor:** update this document, `palette.css`, the logo roles and
  the identity tints in one change.
- **Verify in the real app.** Walk every screen in both themes with a real
  mission, not only the mock, and regenerate `apps/desktop/screenshots/` from
  the real app with the scripts in `scratch/docs-screenshots/` (its README has
  the steps).
