import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import { IdChip } from '../src/react/index.js';

const meta = {
  title: 'Components/IdChip',
  component: IdChip,
  args: { id: 'msn_01m69emew2mr3md4pmae', interactive: true, copy: fn(() => Promise.resolve()), onCopied: fn() },
  argTypes: { id: { control: 'text' }, prefix: { control: 'text' }, interactive: { control: 'boolean' }, copy: { control: false }, onCopied: { control: false } },
  decorators: [(Story) => <div style={{ padding: 'var(--s8) var(--s4)' }}>{Story()}</div>],
  parameters: {
    docs: {
      description: {
        component:
          'A record\'s identifier, shown so a person can point at exactly this record and copied whole on click, Enter or Space. A `<button>` named by the id itself, with a tooltip saying what it does; the result ("Copied …" or "Could not copy …") is announced in a polite live region, and the chip reads "copied" for a moment. Inside a link or a button, pass `interactive={false}`: a control inside a control is invalid, so the chip becomes plain text that still copies on click, and the id must be copyable by keyboard on its record\'s own page.',
      },
    },
  },
} satisfies Meta<typeof IdChip>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};
export const WithPrefix: Story = { args: { id: 'run_01m69emmn095v6yj5ce1', prefix: 'run' } };

/** Inside a row that is itself a link: plain text, still copies on click, not a second tab stop. */
export const InsideALink: Story = {
  args: { interactive: false },
  render: (args) => (
    <a href="#mission" className="sb-row" style={{ gap: 'var(--s2)', color: 'var(--text)' }}>
      Export reports as CSV <IdChip {...args} />
    </a>
  ),
  play: async ({ canvas }) => {
    await expect(canvas.queryByRole('button')).not.toBeInTheDocument();
    await expect(canvas.getByRole('link')).toHaveTextContent('msn_01m69emew2mr3md4pmae');
  },
};

/** Keyboard: Tab reaches it, the tooltip says what it does, Enter copies and the result is announced. */
export const CopyAndAnnounce: Story = {
  play: async ({ args, canvasElement, step }) => {
    const canvas = within(canvasElement);
    const chip = canvas.getByRole('button', { name: 'msn_01m69emew2mr3md4pmae' });
    await step('Tab reaches it and shows what it does', async () => {
      await userEvent.tab();
      await expect(chip).toHaveFocus();
      await expect(await canvas.findByRole('tooltip')).toHaveTextContent('Copy to the clipboard');
      await expect(chip).toHaveAccessibleDescription('Copy to the clipboard');
    });
    await step('Enter copies the whole id and the result is announced', async () => {
      await userEvent.keyboard('{Enter}');
      await waitFor(() => expect(args.copy).toHaveBeenCalledWith('msn_01m69emew2mr3md4pmae'));
      await waitFor(() => expect(canvas.getByRole('status')).toHaveTextContent('Copied msn_01m69emew2mr3md4pmae'));
      await expect(chip).toHaveTextContent('copied');
      await expect(args.onCopied).toHaveBeenCalledWith(true);
    });
  },
};

/** When the clipboard refuses, that is announced too. */
export const CopyFails: Story = {
  args: { copy: fn(() => Promise.reject(new Error('denied'))) },
  play: async ({ args, canvas }) => {
    await userEvent.click(canvas.getByRole('button', { name: 'msn_01m69emew2mr3md4pmae' }));
    await waitFor(() => expect(canvas.getByRole('status')).toHaveTextContent('Could not copy msn_01m69emew2mr3md4pmae'));
    await expect(args.onCopied).toHaveBeenCalledWith(false);
  },
};
