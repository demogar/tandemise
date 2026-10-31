import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState, type ReactElement } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { Button, Dialog, Icon, Tooltip, type TooltipProps, type TooltipTriggerProps } from '../src/react/index.js';

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const meta = {
  title: 'Components/Tooltip',
  component: Tooltip,
  args: {
    content: 'Copy the mission id',
    placement: 'top',
    delay: 400,
    children: ((trigger: TooltipTriggerProps) => (
      <Button iconOnly variant="ghost" aria-label="Copy" {...trigger}>
        <Icon name="file" size={14} />
      </Button>
    )) as TooltipProps['children'],
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
          'A short hint shown on hover (after `delay`) and at once on keyboard focus, tied to its trigger with `aria-describedby` (unless it only repeats the trigger\'s name, as an icon-only button\'s label does). It meets WCAG 1.4.13: Escape dismisses it (and only it, not the dialog around it), the pointer can move onto it to read it, and it stays until pointer and focus have both left. Never the only place something is said: touch has no hover. The trigger is one element child, which the tooltip wires (and makes focusable if it is plain text), or a render prop. Use it instead of a native `title`, which a keyboard user never sees; for text cut off by an ellipsis, use `Truncate`.',
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

/** One element child: the tooltip wires it, no render prop needed. */
export const ElementChild: Story = {
  args: {
    content: 'Runs every check again on the current branch',
    children: (
      <Button>
        <Icon name="refresh" size={14} />
        Re-run
      </Button>
    ),
  },
  play: async ({ canvas }) => {
    await userEvent.tab();
    await expect(canvas.getByRole('button', { name: 'Re-run' })).toHaveAccessibleDescription('Runs every check again on the current branch');
  },
};

/** An icon-only button: the tooltip shows its name to sighted users and is not read twice. */
export const IconOnlyName: Story = {
  args: {
    content: 'Move up',
    children: (
      <Button iconOnly size="sm" variant="ghost" aria-label="Move up" aria-keyshortcuts="Alt+ArrowUp">
        <Icon name="chevronUp" size={13} />
      </Button>
    ),
  },
  play: async ({ canvas }) => {
    await userEvent.tab();
    const button = canvas.getByRole('button', { name: 'Move up' });
    await expect(await canvas.findByRole('tooltip')).toHaveTextContent('Move up');
    await expect(button).not.toHaveAttribute('aria-describedby');
  },
};

/** On plain text, the trigger is made focusable, so a keyboard user can reach the hint too. */
export const OnPlainText: Story = {
  args: {
    content: 'sha256 9f2c1e0b7d4a6c3e8f1b2a5d7c9e0f1a2b3c4d5e6f708192a3b4c5d6e7f8091a',
    children: <span className="mono">9f2c1e0b7d4a</span>,
  },
  play: async ({ canvas }) => {
    const text = canvas.getByText('9f2c1e0b7d4a');
    await expect(text).toHaveAttribute('tabindex', '0');
    await userEvent.tab();
    await expect(text).toHaveFocus();
    await expect(await canvas.findByRole('tooltip')).toHaveTextContent('sha256 9f2c1e0b');
  },
};

/** WCAG 1.4.13, hoverable and persistent: the pointer can cross onto the tooltip, and it stays while hovered. */
export const HoverableAndPersistent: Story = {
  args: { delay: 0, content: 'Queue it: Tandemise plans it when it is ready and there is room under the limit.' },
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    const trigger = canvas.getByRole('button', { name: 'Copy' });
    await step('hover shows it', async () => {
      await userEvent.hover(trigger);
      await expect(await canvas.findByRole('tooltip')).toBeVisible();
    });
    await step('moving onto the tooltip keeps it', async () => {
      await userEvent.unhover(trigger);
      await userEvent.hover(canvas.getByRole('tooltip'));
      await wait(600);
      await expect(canvas.getByRole('tooltip')).toBeVisible();
    });
    await step('it does not time out while hovered', async () => {
      await wait(1500);
      await expect(canvas.getByRole('tooltip')).toBeVisible();
    });
    await step('leaving both hides it', async () => {
      await userEvent.unhover(canvas.getByRole('tooltip'));
      await waitFor(() => expect(canvas.queryByRole('tooltip')).not.toBeInTheDocument());
    });
  },
};

/** Inside a dialog, the first Escape dismisses only the tooltip; the next one closes the dialog. */
function InADialog(): ReactElement {
  const [open, setOpen] = useState(true);
  return open ? (
    <Dialog title="Delete routine" onClose={() => setOpen(false)} footer={<Button onClick={() => setOpen(false)}>Cancel</Button>}>
      <Tooltip content="Missions it already started keep running">
        <Button variant="danger" data-autofocus>
          Delete
        </Button>
      </Tooltip>
    </Dialog>
  ) : (
    <Button onClick={() => setOpen(true)}>Open again</Button>
  );
}

export const EscapeInsideADialog: Story = {
  render: () => <InADialog />,
  play: async ({ canvasElement, step }) => {
    const body = within(canvasElement.ownerDocument.body);
    await step('focus in the dialog shows the hint', async () => {
      await waitFor(() => expect(body.getByRole('button', { name: 'Delete' })).toHaveFocus());
      await expect(await body.findByRole('tooltip')).toHaveTextContent('Missions it already started keep running');
    });
    await step('Escape hides the hint and leaves the dialog open', async () => {
      await userEvent.keyboard('{Escape}');
      await waitFor(() => expect(body.queryByRole('tooltip')).not.toBeInTheDocument());
      await expect(body.getByRole('dialog', { name: 'Delete routine' })).toBeInTheDocument();
      await expect(body.getByRole('button', { name: 'Delete' })).toHaveFocus();
    });
    await step('a second Escape closes the dialog', async () => {
      await userEvent.keyboard('{Escape}');
      await waitFor(() => expect(body.queryByRole('dialog')).not.toBeInTheDocument());
    });
  },
};
