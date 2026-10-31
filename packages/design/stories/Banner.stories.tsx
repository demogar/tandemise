import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState, type ReactElement } from 'react';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import { Banner, Button, Icon } from '../src/react/index.js';

const meta = {
  title: 'Components/Banner',
  component: Banner,
  args: {
    tone: 'warn',
    children: 'Monthly limit at 84%: only urgent and high work will be pulled.',
    icon: <Icon name="alert" size={15} />,
  },
  argTypes: {
    tone: { control: 'inline-radio', options: ['neutral', 'accent', 'warn', 'danger'] },
    live: { control: 'inline-radio', options: [undefined, 'polite', 'assertive'] },
    children: { control: 'text' },
    icon: { control: false },
    action: { control: false },
    as: { control: false },
  },
  parameters: {
    docs: {
      description: {
        component:
          'A message across a section: a warning, an offer, a state worth knowing. Words first; the tone only reinforces them. A banner that is there when the page loads needs no role. One that appears while the person is on the page is a live region: `live="polite"` (`role="status"`) for news, `live="assertive"` (`role="alert"`) for a failure that blocks them. `onDismiss` adds a named close button; `action` puts a control at the end; `as` makes the whole banner a link.',
      },
    },
  },
} satisfies Meta<typeof Banner>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};
export const Neutral: Story = { args: { tone: 'neutral', icon: <Icon name="info" size={15} />, children: 'Too large to compare line by line. Switch between v2 and v3 above to read both.' } };
export const Accent: Story = { args: { tone: 'accent', icon: <Icon name="sparkle" size={15} />, children: 'Use this repository as the tracker for new missions?' } };
export const Warn: Story = {};
export const Danger: Story = { args: { tone: 'danger', icon: <Icon name="alertCircle" size={15} />, children: 'The daemon refused the change: the routine name is taken.' } };

export const WithAction: Story = {
  args: { action: <Button size="sm">See limit</Button> },
};

/** A banner that goes somewhere: the whole of it is one link. */
export const AsALink: Story = {
  args: { as: 'a', href: '#backlog', tone: 'warn', children: 'Working on 3 of 3: 3 queued missions wait for a free slot.', style: { color: 'inherit', textDecoration: 'none' } },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole('link')).toHaveTextContent('Working on 3 of 3');
  },
};

/** Appears while the person is here: announced politely, and dismissable by a named button. */
function Arrives(): ReactElement {
  const [shown, setShown] = useState(false);
  const dismiss = fn(() => setShown(false));
  return (
    <div className="sb-stack">
      <Button onClick={() => setShown(true)}>Save</Button>
      <div>
        {shown ? (
          <Banner tone="accent" live="polite" icon={<Icon name="check" size={15} />} onDismiss={dismiss} dismissLabel="Dismiss the saved message">
            Saved. Agents pick up the change on their next step.
          </Banner>
        ) : null}
      </div>
    </div>
  );
}

export const LiveAndDismissable: Story = {
  render: () => <Arrives />,
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    await step('it arrives as a status message', async () => {
      await userEvent.click(canvas.getByRole('button', { name: 'Save' }));
      await expect(canvas.getByRole('status')).toHaveTextContent('Saved.');
    });
    await step('the close button is named and removes it', async () => {
      await userEvent.click(canvas.getByRole('button', { name: 'Dismiss the saved message' }));
      await waitFor(() => expect(canvas.queryByRole('status')).not.toBeInTheDocument());
    });
  },
};

/** A failure that blocks the person: `role="alert"`, read at once. */
export const Assertive: Story = {
  args: { tone: 'danger', live: 'assertive', icon: <Icon name="alertCircle" size={15} />, children: 'Could not reach the daemon. Your change was not saved.' },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole('alert')).toHaveTextContent('Could not reach the daemon.');
  },
};
