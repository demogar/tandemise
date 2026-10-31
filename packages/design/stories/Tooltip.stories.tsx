import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { Button, Icon, Tooltip } from '../src/react/index.js';

const meta = {
  title: 'Components/Tooltip',
  component: Tooltip,
  args: {
    content: 'Copy the mission id',
    placement: 'top',
    delay: 400,
    children: (trigger) => (
      <Button iconOnly variant="ghost" aria-label="Copy" {...trigger}>
        <Icon name="file" size={14} />
      </Button>
    ),
  },
  argTypes: {
    content: { control: 'text' },
    placement: { control: 'inline-radio', options: ['top', 'bottom'] },
    delay: { control: { type: 'number', min: 0, step: 100 } },
    children: { control: false },
  },
  decorators: [(Story) => <div style={{ padding: 'var(--s12) var(--s8)' }}>{Story()}</div>],
  parameters: {
    docs: {
      description: {
        component:
          'A short hint shown on hover (after `delay`) and at once on keyboard focus, tied to its trigger with `aria-describedby`, hidden by Escape, blur or leaving. Never the only place something is said: touch has no hover. The trigger is a render prop: spread its props onto a focusable element.',
      },
    },
  },
} satisfies Meta<typeof Tooltip>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

export const Bottom: Story = { args: { placement: 'bottom', content: 'Opens in your browser' } };

export const OnAButtonWithText: Story = {
  args: {
    content: 'Runs every check again on the current branch',
    children: (trigger) => (
      <Button {...trigger}>
        <Icon name="refresh" size={14} />
        Re-run
      </Button>
    ),
  },
};

/** Focus shows it at once and describes the trigger; Escape hides it. */
export const KeyboardFocus: Story = {
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    const trigger = canvas.getByRole('button', { name: 'Copy' });
    await step('focus shows the tooltip and ties it to the trigger', async () => {
      await userEvent.tab();
      await expect(trigger).toHaveFocus();
      const tip = await canvas.findByRole('tooltip');
      await expect(tip).toHaveTextContent('Copy the mission id');
      await expect(trigger).toHaveAccessibleDescription('Copy the mission id');
    });
    await step('Escape hides it', async () => {
      await userEvent.keyboard('{Escape}');
      await waitFor(() => expect(canvas.queryByRole('tooltip')).not.toBeInTheDocument());
    });
  },
};

/** Hover waits for `delay` before it shows. */
export const Hover: Story = {
  args: { delay: 200 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.hover(canvas.getByRole('button', { name: 'Copy' }));
    await expect(await canvas.findByRole('tooltip')).toBeVisible();
    await userEvent.unhover(canvas.getByRole('button', { name: 'Copy' }));
    await waitFor(() => expect(canvas.queryByRole('tooltip')).not.toBeInTheDocument());
  },
};
