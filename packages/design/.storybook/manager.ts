import { addons } from 'storybook/manager-api';
import { tandemiseTheme } from './theme';

/**
 * The manager (sidebar, toolbar, addon panel) follows the operating system's
 * scheme when it loads; the toolbar's Theme switch changes the components and
 * the docs pages, not this chrome. The accessibility panel opens first, so a
 * violation is in view the moment a story renders.
 */
const dark = typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches;

addons.setConfig({
  theme: tandemiseTheme(dark ? 'dark' : 'light'),
  selectedPanel: 'storybook/a11y/panel',
  sidebar: { showRoots: true },
});
