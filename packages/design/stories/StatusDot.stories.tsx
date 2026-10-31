import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect } from 'storybook/test';
import { StatusDot } from '../src/react/index.js';
import { TONES } from './tones.js';

const meta = {
  title: 'Components/StatusDot',
  component: StatusDot,
  args: { tone: 'succeeded', live: false, 'aria-label': 'Online' },
  argTypes: {
    tone: { control: 'select', options: TONES },
    'aria-label': { control: 'text' },
  },
  parameters: {
    docs: {
      description: {
        component:
          'A status as a 7px dot. Decorative (`aria-hidden`) beside words; given an `aria-label` it becomes an image with that name. Never the only signal: pair it with text.',
      },
    },
  },
} satisfies Meta<typeof StatusDot>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

export const AllTones: Story = {
  render: () => (
    <div className="sb-row">
      {TONES.map((tone) => (
        <span key={tone} className="sb-row">
          <StatusDot tone={tone} />
          {tone}
        </span>
      ))}
    </div>
  ),
};

export const Live: Story = { args: { tone: 'running', live: true, 'aria-label': 'Running now' } };

/** With an `aria-label` the dot is announced as an image. */
export const Labelled: Story = {
  args: { tone: 'failed', 'aria-label': 'Failed' },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole('img', { name: 'Failed' })).toHaveClass('dot', 'dot--failed');
  },
};

/** Without one it is decorative, and the words beside it say what it means. */
export const Decorative: Story = {
  args: { tone: 'blocked', 'aria-label': undefined },
  render: (args) => (
    <span className="sb-row">
      <StatusDot {...args} />
      Waiting on you
    </span>
  ),
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelector('.dot')).toHaveAttribute('aria-hidden', 'true');
  },
};
