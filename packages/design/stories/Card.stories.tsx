import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect } from 'storybook/test';
import { Button, Card } from '../src/react/index.js';

const meta = {
  title: 'Components/Card',
  component: Card,
  args: { children: 'A plain card groups one thing.', flush: false },
  argTypes: {
    title: { control: 'text' },
    actions: { control: false },
    children: { control: 'text' },
  },
  decorators: [(Story) => <div className="sb-wide">{Story()}</div>],
  parameters: {
    docs: {
      description: {
        component:
          'A bordered surface that groups one thing. Given a `title`, it is a `<section>` labelled by its heading, with `actions` at the right of the heading row. `flush` lets a list or a table run to the edges.',
      },
    },
  },
} satisfies Meta<typeof Card>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

export const Plain: Story = {};

export const WithTitle: Story = {
  args: { title: 'Checks', children: 'Tests passed on the last round.' },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole('region', { name: 'Checks' })).toBeInTheDocument();
  },
};

export const WithActions: Story = {
  args: {
    title: 'Checks',
    actions: <Button variant="ghost">Re-run</Button>,
    children: 'Tests passed on the last round. Lint has two warnings.',
  },
};

export const Flush: Story = {
  args: {
    title: 'Recent runs',
    flush: true,
    children: (
      <table className="fd-table" style={{ margin: 0 }}>
        <tbody>
          <tr>
            <td style={{ paddingLeft: 'var(--s4)' }}>Plan the settings page</td>
            <td>2m ago</td>
          </tr>
          <tr>
            <td style={{ paddingLeft: 'var(--s4)' }}>Write the migration</td>
            <td>14m ago</td>
          </tr>
        </tbody>
      </table>
    ),
  },
};

export const FlushWithoutTitle: Story = {
  args: { flush: true, children: <div style={{ padding: 'var(--s4)' }}>The content sets its own padding.</div> },
};
