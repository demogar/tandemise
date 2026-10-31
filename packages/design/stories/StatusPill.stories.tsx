import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect } from 'storybook/test';
import { Icon, StatusPill } from '../src/react/index.js';
import { TONES } from './tones.js';

const meta = {
  title: 'Components/StatusPill',
  component: StatusPill,
  args: { tone: 'running', label: 'Running', live: false },
  argTypes: {
    tone: { control: 'select', options: TONES },
    label: { control: 'text' },
    icon: { control: false },
  },
  parameters: {
    docs: {
      description: {
        component:
          'A status: a dot (or an icon) and words, in the tone’s colour. The words carry the meaning; the dot is `aria-hidden`. `live` pulses the dot for work happening now.',
      },
    },
  },
} satisfies Meta<typeof StatusPill>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

export const AllTones: Story = {
  render: () => (
    <div className="sb-row">
      {TONES.map((tone) => (
        <StatusPill key={tone} tone={tone} label={tone} />
      ))}
    </div>
  ),
};

export const Live: Story = {
  args: { tone: 'running', label: 'Building', live: true },
  play: async ({ canvasElement }) => {
    const dot = canvasElement.querySelector('.dot');
    await expect(dot).toHaveClass('dot--pulse');
    await expect(dot).toHaveAttribute('aria-hidden', 'true');
  },
};

export const WithIcon: Story = {
  args: { tone: 'succeeded', label: 'Merged', icon: <Icon name="check" size={12} /> },
};

export const Blocked: Story = {
  args: { tone: 'blocked', label: 'Needs your review', icon: <Icon name="alert" size={12} /> },
};

export const Failed: Story = {
  args: { tone: 'failed', label: 'Checks failed', icon: <Icon name="x" size={12} /> },
};
