import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect } from 'storybook/test';
import { Logo } from '../src/react/index.js';

const meta = {
  title: 'Components/Logo',
  component: Logo,
  args: { size: 40, muted: false, title: 'Tandemise' },
  argTypes: {
    size: { control: { type: 'range', min: 16, max: 160, step: 2 } },
    title: { control: 'text' },
  },
  parameters: {
    docs: {
      description: {
        component:
          'The product mark: two wheels on one axle, a tandem. Drawn in the `--logo-*` roles, so it is the palette in miniature in either theme. `muted` means "nothing to connect to" (a daemon that is down), never decoration. The minimum size is 16px. Every variant is on the Foundations › Logo page.',
      },
    },
  },
} satisfies Meta<typeof Logo>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

export const Sizes: Story = {
  args: { title: undefined },
  render: (args) => (
    <div className="sb-row">
      {[16, 22, 32, 48, 72].map((size) => (
        <Logo key={size} {...args} size={size} />
      ))}
    </div>
  ),
};

export const Muted: Story = { args: { muted: true, title: 'Tandemise (offline)' } };

/** Beside the product name the mark is decorative. */
export const WithName: Story = {
  args: { size: 22, title: undefined },
  render: (args) => (
    <span className="sb-row" style={{ fontWeight: 650, fontSize: 'var(--fs-md)' }}>
      <Logo {...args} />
      Tandemise
    </span>
  ),
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  },
};
