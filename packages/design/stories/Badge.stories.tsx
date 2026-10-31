import type { Meta, StoryObj } from '@storybook/react-vite';
import { Badge } from '../src/react/index.js';
import { BADGE_TONES } from './tones.js';

const meta = {
  title: 'Components/Badge',
  component: Badge,
  args: { tone: 'pending', children: '3 open' },
  argTypes: {
    tone: { control: 'select', options: BADGE_TONES },
    children: { control: 'text' },
  },
  parameters: {
    docs: {
      description: {
        component:
          'A small label in a status colour: a count, a kind, a state. Plain text, so colour is never the only signal. `pending` is the quiet default; `accent` and `release` (the release risk) sit beside the five status tones.',
      },
    },
  },
} satisfies Meta<typeof Badge>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

export const AllTones: Story = {
  render: () => (
    <div className="sb-row">
      {BADGE_TONES.map((tone) => (
        <Badge key={tone} tone={tone}>
          {tone}
        </Badge>
      ))}
    </div>
  ),
};

export const Pending: Story = { args: { tone: 'pending', children: 'queued' } };
export const Running: Story = { args: { tone: 'running', children: 'running' } };
export const Blocked: Story = { args: { tone: 'blocked', children: 'needs you' } };
export const Failed: Story = { args: { tone: 'failed', children: '2 failing' } };
export const Succeeded: Story = { args: { tone: 'succeeded', children: 'merged' } };
export const Accent: Story = { args: { tone: 'accent', children: 'new' } };
export const Release: Story = { args: { tone: 'release', children: 'release' } };
