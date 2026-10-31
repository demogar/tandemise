import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect } from 'storybook/test';
import { ICON_PATHS, ICON_STROKE_WIDTH } from '../src/icons.js';
import { Icon, type IconName } from '../src/react/index.js';

const NAMES = Object.keys(ICON_PATHS) as IconName[];

const meta = {
  title: 'Components/Icon',
  component: Icon,
  args: { name: 'sparkle', size: 24, strokeWidth: ICON_STROKE_WIDTH },
  argTypes: {
    name: { control: 'select', options: NAMES },
    size: { control: { type: 'range', min: 12, max: 64, step: 2 } },
    strokeWidth: { control: { type: 'range', min: 1, max: 3, step: 0.1 } },
    label: { control: 'text' },
  },
  parameters: {
    docs: {
      description: {
        component:
          'A stroke icon in `currentColor` on a 24px grid, so it takes the colour of the text it sits in. Decorative (`aria-hidden`) unless `label` names it. Every glyph is on the Foundations › Icons page.',
      },
    },
  },
} satisfies Meta<typeof Icon>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

export const Sizes: Story = {
  render: (args) => (
    <div className="sb-row">
      {[12, 14, 16, 20, 24, 32].map((size) => (
        <Icon key={size} {...args} size={size} />
      ))}
    </div>
  ),
};

/** It takes the colour of its text: here the status roles. */
export const InheritsColour: Story = {
  render: () => (
    <div className="sb-row">
      <span style={{ color: 'var(--status-succeeded)' }}>
        <Icon name="check" /> succeeded
      </span>
      <span style={{ color: 'var(--status-failed)' }}>
        <Icon name="x" /> failed
      </span>
      <span style={{ color: 'var(--status-blocked)' }}>
        <Icon name="alert" /> blocked
      </span>
      <span style={{ color: 'var(--accent)' }}>
        <Icon name="sparkle" /> accent
      </span>
    </div>
  ),
};

/** With a `label` the icon is an image with that name; use it only when nothing else says what it means. */
export const Labelled: Story = {
  args: { name: 'shield', label: 'Protected branch' },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole('img', { name: 'Protected branch' })).toBeInTheDocument();
  },
};
