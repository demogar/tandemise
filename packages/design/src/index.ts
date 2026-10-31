/**
 * @tandemise/design - the Tandemise design system: tokens, theme, brand mark
 * and icons, framework-free. See README.md.
 *
 * Every module here is pure data or pure functions with no imports outside the
 * package, so a browser bundle, a Node script and the Electron main process can
 * all load it.
 */
export * from './tokens.js';
export { resolveColor, resolveTheme } from './resolve.js';
export { contrast, composite, luminance, pairContrast, CONTRAST_PAIRS, type ContrastPair } from './contrast.js';
export { cssVariables, roleCss, tokensCss } from './css.js';
export { tailwindPreset, tailwindColorName, tailwindThemeCss } from './tailwind.js';
export { LOGO, LOGO_COLORS, logoSvg } from './logo.js';
export { ICON_PATHS, ICON_STROKE_WIDTH, ICON_VIEWBOX, type IconName } from './icons.js';
