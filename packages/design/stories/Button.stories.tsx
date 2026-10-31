import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import { Button, buttonClass, Icon } from '../src/react/index.js';

const meta = {
  title: 'Components/Button',
  component: Button,
  args: {
    children: 'Request changes',
    variant: 'secondary',
    size: 'md',
    iconOnly: false,
    block: false,
    loading: false,
    disabled: false,
    onClick: fn(),
  },
  argTypes: {
    variant: { control: 'inline-radio', options: ['secondary', 'primary', 'ghost', 'danger'] },
    size: { control: 'inline-radio', options: ['sm', 'md', 'lg'] },
    loadingLabel: { control: 'text' },
    children: { control: 'text' },
  },
  parameters: {
    docs: {
      description: {
        component:
          'The weight of an action. `secondary` is the default; `primary` is the one main action of a view (at most one per view); `ghost` for low-stakes actions in dense rows; `danger` only for what destroys or cannot be undone. A router link that must look like a button takes `buttonClass()`.',
      },
    },
  },
} satisfies Meta<typeof Button>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

export const Secondary: Story = { args: { children: 'Request changes' } };
export const Primary: Story = { args: { variant: 'primary', children: 'Approve plan' } };
export const Ghost: Story = { args: { variant: 'ghost', children: 'Skip' } };
export const Danger: Story = { args: { variant: 'danger', children: 'Cancel mission' } };

/** `sm`: 28px tall (24px compact), for a row of actions on a list item. Never under 24x24, icon-only included. */
export const Small: Story = {
  args: { size: 'sm', children: undefined },
  render: (args) => (
    <div className="sb-row">
      <Button {...args}>Accept</Button>
      <Button {...args} variant="ghost">
        Reject
      </Button>
      <Button {...args} variant="ghost" iconOnly aria-label="Move up">
        <Icon name="chevronUp" size={13} />
      </Button>
    </div>
  ),
  play: async ({ canvas }) => {
    for (const button of canvas.getAllByRole('button')) {
      const box = button.getBoundingClientRect();
      await expect(box.height).toBeGreaterThanOrEqual(24);
      await expect(box.width).toBeGreaterThanOrEqual(24);
    }
    await expect(canvas.getByRole('button', { name: 'Move up' })).toHaveClass('btn--sm', 'btn--icon');
  },
};

export const Large: Story = {
  args: { variant: 'primary', size: 'lg', children: undefined },
  render: (args) => (
    <Button {...args}>
      <Icon name="plus" size={14} />
      New mission
    </Button>
  ),
};

export const WithIcon: Story = {
  render: (args) => (
    <Button {...args}>
      <Icon name="refresh" size={14} />
      Re-run checks
    </Button>
  ),
};

export const IconOnly: Story = {
  args: { iconOnly: true, variant: 'ghost', 'aria-label': 'Close', children: undefined },
  render: (args) => (
    <Button {...args}>
      <Icon name="x" size={14} />
    </Button>
  ),
};

export const Block: Story = {
  args: { block: true, variant: 'primary', children: 'Continue' },
  decorators: [(Story) => <div className="sb-narrow">{Story()}</div>],
};

export const Disabled: Story = {
  args: { disabled: true, children: 'Merge' },
  play: async ({ canvas, args }) => {
    const button = canvas.getByRole('button', { name: 'Merge' });
    await expect(button).toBeDisabled();
    await userEvent.click(button, { pointerEventsCheck: 0 });
    await expect(args.onClick).not.toHaveBeenCalled();
  },
};

/** Work in flight: announced as busy, stops presses, keeps its width with a spinner beside the label. */
export const Loading: Story = {
  args: { loading: true, children: 'Saving' },
  play: async ({ canvas, args }) => {
    const button = canvas.getByRole('button', { name: /Saving/ });
    await expect(button).toHaveAttribute('aria-busy', 'true');
    await expect(button).toHaveAttribute('data-loading', 'true');
    await userEvent.click(button, { pointerEventsCheck: 0 });
    await expect(args.onClick).not.toHaveBeenCalled();
  },
};

/** A verb in progress replaces the label; no spinner is drawn. */
export const LoadingLabel: Story = {
  args: { loading: true, variant: 'primary', loadingLabel: 'Working…', children: 'Confirm' },
};

export const AllVariants: Story = {
  render: () => (
    <div className="sb-stack">
      <div className="sb-row">
        <Button variant="primary">Approve plan</Button>
        <Button>Request changes</Button>
        <Button variant="ghost">Skip</Button>
        <Button variant="danger">Cancel mission</Button>
      </div>
      <div className="sb-row">
        <Button variant="primary" disabled>
          Approve plan
        </Button>
        <Button disabled>Request changes</Button>
        <Button variant="ghost" disabled>
          Skip
        </Button>
        <Button variant="danger" disabled>
          Cancel mission
        </Button>
      </div>
      <div className="sb-row">
        <Button variant="primary" loading>
          Approve plan
        </Button>
        <Button loading>Request changes</Button>
        <Button variant="ghost" loading>
          Skip
        </Button>
        <Button variant="danger" loading loadingLabel="Cancelling…">
          Cancel mission
        </Button>
      </div>
      <div className="sb-row">
        <Button variant="primary" size="lg">
          <Icon name="plus" size={14} />
          New mission
        </Button>
        <Button size="lg">Import</Button>
        <Button iconOnly variant="ghost" aria-label="Close">
          <Icon name="x" size={14} />
        </Button>
        <Button iconOnly aria-label="Refresh">
          <Icon name="refresh" size={14} />
        </Button>
      </div>
    </div>
  ),
};

/** `buttonClass()` gives a link the look of a button without making it one. */
export const LinkAsButton: Story = {
  render: () => (
    <div className="sb-row">
      <a className={buttonClass({ variant: 'primary' })} href="#open">
        Open the pull request
      </a>
      <a className={buttonClass({ variant: 'ghost' })} href="#docs">
        Read the docs
      </a>
    </div>
  ),
  play: async ({ canvasElement }) => {
    const link = within(canvasElement).getByRole('link', { name: 'Open the pull request' });
    await expect(link).toHaveClass('btn', 'btn--primary');
  },
};
