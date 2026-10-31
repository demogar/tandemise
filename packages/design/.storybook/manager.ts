import { addons } from 'storybook/manager-api';
import { BRAND_NAME, tandemiseTheme } from './theme';

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

/**
 * The browser tab. Storybook titles it "<page> ⋅ Storybook": with an HTML
 * brandTitle (the mark beside the name) it cannot use the brand. Keep the
 * page part and put the product name after it.
 */
if (typeof document !== 'undefined') {
  const retitle = (): void => {
    const suffix = ` ⋅ ${BRAND_NAME}`;
    let page = document.title.trim();
    if (page.endsWith(suffix)) page = page.slice(0, -suffix.length);
    page = page.replace(/\s+[⋅·-]\s+Storybook$/i, '').trim();
    const next = page === '' || /^storybook$/i.test(page) || page === BRAND_NAME ? BRAND_NAME : `${page}${suffix}`;
    if (document.title !== next) document.title = next;
  };
  retitle();
  const head = document.querySelector('head');
  if (head) new MutationObserver(retitle).observe(head, { subtree: true, childList: true, characterData: true });
}
