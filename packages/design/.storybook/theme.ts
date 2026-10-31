import { create, type ThemeVars } from 'storybook/theming';
import { fontFamily, palette, radius } from '../src/tokens.js';
import { LOGO_COLORS, logoSvg } from '../src/logo.js';
import { resolveTheme } from '../src/resolve.js';
import type { ThemeName } from '../src/tokens.js';

/**
 * Storybook's own chrome (sidebar, toolbar, addon panel, docs pages) in the
 * Tandemise roles. Every colour is resolved from tokens.ts by `resolveTheme()`,
 * so there is no colour literal here and the chrome cannot drift from the
 * package: change a role and the Storybook UI follows on the next build.
 */

/** The mark for one background, as an image the manager can show. */
export function logoDataUrl(on: 'onDark' | 'onLight', size = 22): string {
  const parts = LOGO_COLORS[on];
  const svg = logoSvg({ lead: palette[parts.lead], trail: palette[parts.trail], axle: palette[parts.axle] }, { size });
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/** The product name, in the sidebar and the browser tab. */
export const BRAND_NAME = 'Tandemise design system';

/** Where the brand links: the repository the package lives in. */
export const BRAND_URL = 'https://github.com/tandemise/tandemise';

/** The sidebar's brand: the mark beside the product name. Storybook renders an HTML brandTitle as is. */
function brandTitle(theme: ThemeName): string {
  const mark = logoDataUrl(theme === 'dark' ? 'onDark' : 'onLight');
  return `<span style="display:inline-flex;align-items:center;gap:10px;font-weight:650;letter-spacing:-0.01em"><img src="${mark}" width="22" height="22" alt="" /><span>${BRAND_NAME}</span></span>`;
}

export function tandemiseTheme(theme: ThemeName): ThemeVars {
  const r = resolveTheme(theme);
  return create({
    base: theme,
    brandTitle: brandTitle(theme),
    brandUrl: BRAND_URL,
    brandTarget: '_blank',

    fontBase: fontFamily.sans.join(', '),
    fontCode: fontFamily.mono.join(', '),

    colorPrimary: r.accent,
    colorSecondary: r.accent,

    appBg: r['surface-sunken'],
    appContentBg: r.canvas,
    appPreviewBg: r.canvas,
    appHoverBg: r['surface-hover'],
    appBorderColor: r.border,
    appBorderRadius: radius.md,

    textColor: r.text,
    textInverseColor: r['accent-text'],
    textMutedColor: r['text-secondary'],

    barTextColor: r['text-secondary'],
    barHoverColor: r.text,
    barSelectedColor: r.accent,
    barBg: r.surface,

    buttonBg: r['surface-raised'],
    buttonBorder: r['border-strong'],
    booleanBg: r['surface-sunken'],
    booleanSelectedBg: r['surface-raised'],

    inputBg: r['surface-raised'],
    inputBorder: r['border-strong'],
    inputTextColor: r.text,
    inputBorderRadius: radius.sm,
  });
}
