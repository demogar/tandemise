import type { Meta, StoryObj } from '@storybook/react-vite';
import { Button, Card, EmptyState, Icon } from '../src/react/index.js';

const meta = {
  title: 'Components/EmptyState',
  component: EmptyState,
  args: {
    title: 'No missions yet',
    body: 'A mission is one outcome, planned into steps your agents and you work through.',
    inline: false,
    icon: <Icon name="sparkle" size={18} />,
    action: <Button variant="primary">New mission</Button>,
  },
  argTypes: {
    title: { control: 'text' },
    body: { control: 'text' },
    icon: { control: false },
    action: { control: false },
  },
  decorators: [(Story) => <div className="sb-wide">{Story()}</div>],
  parameters: {
    docs: {
      description: {
        component: 'What a view says when there is nothing in it yet: what goes here, and the one way to start. `inline` is the smaller version for inside a card or a pane.',
      },
    },
  },
} satisfies Meta<typeof EmptyState>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

export const TitleOnly: Story = { args: { icon: undefined, body: undefined, action: undefined, title: 'Nothing to review' } };

export const Inline: Story = {
  args: { inline: true, title: 'No runs on this step', body: 'Runs appear here once a worker picks it up.', action: undefined, icon: <Icon name="clock" size={18} /> },
  render: (args) => (
    <Card title="Runs" flush>
      <EmptyState {...args} />
    </Card>
  ),
};

export const WithSecondaryAction: Story = {
  args: {
    icon: <Icon name="integrations" size={18} />,
    title: 'Connect your tools',
    body: 'Issues, alerts and designs flow into intake once a tool is connected.',
    action: (
      <div className="sb-row">
        <Button variant="primary">Connect a tool</Button>
        <Button variant="ghost">Later</Button>
      </div>
    ),
  },
};
