import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { Truncate } from '../src/react/index.js';

const LONG = 'Let people download any report as a CSV file they can open in a spreadsheet, one row per task, with the column order the board uses.';

const meta = {
  title: 'Components/Truncate',
  component: Truncate,
  args: { children: LONG, as: 'div' },
  argTypes: { children: { control: 'text' }, as: { control: 'inline-radio', options: ['span', 'div', 'p'] } },
  decorators: [(Story) => <div style={{ width: 320, padding: 'var(--s10) 0 var(--s4)' }}>{Story()}</div>],
  parameters: {
    docs: {
      description: {
        component:
          'One line of text that ends in an ellipsis when it does not fit, and can still be read whole. Only while it is cut off, its full text shows in a tooltip on hover and on keyboard focus: on its own it joins the tab order; inside a link or a button it does not (a control inside a control is invalid) and shows when that control has keyboard focus. A screen reader already reads the whole text, so the tooltip is not added as a description. Text that fits is plain text: no tab stop, no tooltip.',
      },
    },
  },
} satisfies Meta<typeof Truncate>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

export const Fits: Story = {
  args: { children: 'Export reports as CSV' },
  play: async ({ canvas }) => {
    const text = canvas.getByText('Export reports as CSV');
    await expect(text).not.toHaveAttribute('tabindex');
    await userEvent.hover(text);
    await new Promise((resolve) => setTimeout(resolve, 600));
    await expect(canvas.queryByRole('tooltip')).not.toBeInTheDocument();
  },
};

/** Cut off: Tab reaches it and shows the whole text; Escape hides it. */
export const KeyboardReadsTheRest: Story = {
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    const text = canvas.getByText(LONG, { selector: '.truncate' });
    await step('it is cut off, so it is in the tab order', async () => {
      await waitFor(() => expect(text).toHaveAttribute('tabindex', '0'));
      await userEvent.tab();
      await expect(text).toHaveFocus();
    });
    await step('focus shows the whole text', async () => {
      await expect(await canvas.findByRole('tooltip')).toHaveTextContent(LONG);
      await expect(text).not.toHaveAttribute('aria-describedby');
    });
    await step('Escape hides it, focus stays', async () => {
      await userEvent.keyboard('{Escape}');
      await waitFor(() => expect(canvas.queryByRole('tooltip')).not.toBeInTheDocument());
      await expect(text).toHaveFocus();
    });
  },
};

/** Inside a link: not a second tab stop; focusing the link shows the whole text. */
export const InsideALink: Story = {
  render: (args) => (
    <a href="#mission" style={{ display: 'block', color: 'var(--text)' }}>
      <Truncate {...args} />
    </a>
  ),
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    const text = canvas.getByText(LONG, { selector: '.truncate' });
    await step('the text is not focusable itself', async () => {
      await waitFor(() => expect(text).toHaveAttribute('data-clipped', 'true'));
      await expect(text).not.toHaveAttribute('tabindex');
    });
    await step('keyboard focus on the link shows the whole text', async () => {
      await userEvent.tab();
      await expect(canvas.getByRole('link')).toHaveFocus();
      await expect(await canvas.findByRole('tooltip')).toHaveTextContent(LONG);
    });
    await step('leaving the link hides it', async () => {
      await userEvent.tab();
      await waitFor(() => expect(canvas.queryByRole('tooltip')).not.toBeInTheDocument());
    });
  },
};
