import type { StorybookConfig } from '@storybook/react-vite';

/**
 * The Storybook of @tandemise/design: every React component, its variants and
 * states, the components composed the way the desktop composes them, and the
 * foundations (colour, type, spacing, motion, icons, the logo) as docs pages.
 *
 *   npm run -w @tandemise/design storybook          dev server on :6006
 *   npm run -w @tandemise/design storybook:build    static site in storybook-static/
 *
 * Stories import the package's sources (src/), not dist/, so an edit to a
 * component or to tokens.ts shows up at once. None of this is published: the
 * package's `files` lists only dist, css, assets, the README and the licence.
 */
const config: StorybookConfig = {
  stories: ['../stories/**/*.mdx', '../stories/**/*.stories.@(ts|tsx)'],
  staticDirs: [{ from: '../assets', to: '/brand' }],
  addons: ['@storybook/addon-docs', '@storybook/addon-a11y'],
  framework: { name: '@storybook/react-vite', options: { strictMode: true } },
  core: { disableTelemetry: true, disableWhatsNewNotifications: true },
  // No "Get started" checklist in the sidebar: this Storybook is a reference, not a tutorial.
  features: { sidebarOnboardingChecklist: false },
  docs: { defaultName: 'Docs' },
  typescript: { reactDocgen: 'react-docgen-typescript' },
};

export default config;
