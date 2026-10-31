import '../css/tokens.css';
import '../css/base.css';
import '../css/components.css';
import './preview.css';

import { DocsContainer, type DocsContainerProps } from '@storybook/addon-docs/blocks';
import type { Decorator, Preview } from '@storybook/react-vite';
import { useEffect, type PropsWithChildren } from 'react';
import { applyGlobals, initialGlobals, useResolvedTheme } from './globals';
import { tandemiseTheme } from './theme';

const light = tandemiseTheme('light');
const dark = tandemiseTheme('dark');

/** Docs pages (prose, args tables, code) follow the toolbar's theme. */
function ThemedDocsContainer(props: PropsWithChildren<DocsContainerProps>) {
  const theme = useResolvedTheme();
  return <DocsContainer {...props} theme={theme === 'dark' ? dark : light} />;
}

/** Every story renders with the toolbar's theme and density on <html> (see globals.ts). */
const withThemeAndDensity: Decorator = (Story, context) => {
  const { theme, density } = context.globals;
  useEffect(() => applyGlobals({ theme, density }), [theme, density]);
  return <Story />;
};

const preview: Preview = {
  tags: ['autodocs'],
  decorators: [withThemeAndDensity],
  initialGlobals,
  globalTypes: {
    theme: {
      description: 'Colour theme (data-theme on <html>)',
      toolbar: {
        title: 'Theme',
        icon: 'contrast',
        items: [
          { value: 'light', title: 'Light', icon: 'sun' },
          { value: 'dark', title: 'Dark', icon: 'moon' },
          { value: 'system', title: 'System (no data-theme)', icon: 'browser' },
        ],
        dynamicTitle: true,
      },
    },
    density: {
      description: 'Control density (data-density on <html>)',
      toolbar: {
        title: 'Density',
        icon: 'component',
        items: [
          { value: 'comfortable', title: 'Comfortable' },
          { value: 'compact', title: 'Compact' },
        ],
        dynamicTitle: true,
      },
    },
  },
  parameters: {
    layout: 'padded',
    // The canvas is the system's own --canvas, set by base.css; Storybook's
    // backgrounds would paint over it and hide a theme bug.
    backgrounds: { disable: true },
    controls: { expanded: true, sort: 'requiredFirst' },
    docs: { container: ThemedDocsContainer, toc: { headingSelector: 'h2, h3' } },
    // Axe runs on every story; the panel lists violations, passes and incomplete checks.
    a11y: { test: 'error' },
    options: {
      storySort: {
        order: [
          'Introduction',
          'Foundations',
          ['Colour', 'Typography', 'Spacing', 'Radius', 'Elevation', 'Z-index', 'Motion', 'Focus ring', 'Icons', 'Logo'],
          'Components',
          'In context',
        ],
      },
    },
  },
};

export default preview;
