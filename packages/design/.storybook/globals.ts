import { useSyncExternalStore } from 'react';
import { SET_GLOBALS, UPDATE_GLOBALS } from 'storybook/internal/core-events';
import { addons } from 'storybook/preview-api';

/**
 * The toolbar's Theme and Density, applied the way an app applies them: as
 * `data-theme` and `data-density` on <html>. Document attributes rather than a
 * wrapper element, because a dialog or a tooltip drawn outside the story's
 * root must follow them too.
 *
 *   theme    light | dark | system (no data-theme: the OS decides)
 *   density  comfortable | compact
 *
 * Applied from the preview's channel as well as from the story decorator: an
 * MDX page with no stories runs no decorators, and its swatches and prose must
 * switch too. Which events matter is subtle. A docs page that shows an example
 * in its own frame (`docs.story.inline: false`, the Dialog examples) hosts a
 * second preview whose channel posts to this one, and that preview announces
 * its own default globals. So the page takes its starting globals from the
 * first SET_GLOBALS only (its own, sent before any example frame exists) and
 * changes from UPDATE_GLOBALS, which only the toolbar sends. An example frame,
 * in turn, takes its theme and density from the docs page around it.
 */
export type ThemeChoice = 'light' | 'dark' | 'system';
export type DensityChoice = 'comfortable' | 'compact';

export const initialGlobals: { theme: ThemeChoice; density: DensityChoice } = { theme: 'light', density: 'comfortable' };

type Globals = Record<string, unknown>;

const listeners = new Set<() => void>();
let theme: ThemeChoice = 'light';

/** The docs page this preview is an example frame of, if it is one. */
function docsPageAround(): Document | undefined {
  if (typeof window === 'undefined' || window.parent === window) return undefined;
  try {
    const parent = window.parent.document;
    return parent.getElementById('storybook-docs') ? parent : undefined;
  } catch {
    return undefined; // a cross-origin parent: an embed, not a docs page
  }
}

function setAttributes(nextTheme: ThemeChoice, density: DensityChoice): void {
  const root = document.documentElement;
  if (nextTheme === 'system') delete root.dataset.theme;
  else root.dataset.theme = nextTheme;
  if (density === 'compact') root.dataset.density = 'compact';
  else delete root.dataset.density;
  if (nextTheme !== theme) {
    theme = nextTheme;
    for (const listener of listeners) listener();
  }
}

/** Mirrors the docs page's attributes into this example frame. */
function followDocsPage(page: Document): void {
  const { theme: pageTheme, density } = page.documentElement.dataset;
  setAttributes(pageTheme === 'dark' || pageTheme === 'light' ? pageTheme : 'system', density === 'compact' ? 'compact' : 'comfortable');
}

export function applyGlobals(globals: Globals | undefined): void {
  if (!globals || typeof document === 'undefined') return;
  const page = docsPageAround();
  if (page) {
    followDocsPage(page);
    return;
  }
  // UPDATE_GLOBALS carries only what changed, so merge into what is showing.
  current = { ...current, ...globals };
  const nextTheme: ThemeChoice = current.theme === 'dark' || current.theme === 'system' ? current.theme : 'light';
  setAttributes(nextTheme, current.density === 'compact' ? 'compact' : 'comfortable');
}

let current: Globals = { ...initialGlobals };

if (typeof window !== 'undefined') {
  const page = docsPageAround();
  if (page) {
    followDocsPage(page);
    new MutationObserver(() => followDocsPage(page)).observe(page.documentElement, { attributeFilter: ['data-theme', 'data-density'] });
  } else {
    void addons.ready().then((channel) => {
      const onGlobals = ({ globals }: { globals?: Globals }) => applyGlobals(globals);
      channel.once(SET_GLOBALS, onGlobals);
      channel.on(UPDATE_GLOBALS, onGlobals);
    });
  }
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener('change', () => {
    for (const listener of listeners) listener();
  });
}

/** The theme a docs page should be drawn in: the toolbar's, or the OS's under "system". */
export function useResolvedTheme(): 'light' | 'dark' {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => (theme === 'system' ? (window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : theme),
    () => 'light',
  );
}
