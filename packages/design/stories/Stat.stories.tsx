import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect } from 'storybook/test';
import { Stat } from '../src/react/index.js';

const meta = {
  title: 'Components/Stat',
  component: Stat,
  args: { label: 'Agents running', value: '4', note: 'of 6 allowed', muted: false },
  argTypes: { label: { control: 'text' }, value: { control: 'text' }, note: { control: 'text' }, muted: { control: 'boolean' } },
  decorators: [(Story) => <div style={{ width: 220 }}>{Story()}</div>],
  parameters: {
    docs: {
      description: {
        component:
          'One measured value under its label. A description list (`<dl>`: the label a `<dt>`, the value and note `<dd>`s), so a screen reader reads the pair together. Values arrive already formatted; an unknown one reads "not reported" and is `muted`.',
      },
    },
  },
} satisfies Meta<typeof Stat>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {
  play: async ({ canvas }) => {
    await expect(canvas.getByRole('term')).toHaveTextContent('Agents running');
    await expect(canvas.getAllByRole('definition')[0]).toHaveTextContent('4');
  },
};

export const WithoutNote: Story = { args: { label: 'Criteria verified', value: '4 of 7', note: undefined } };
export const NotReported: Story = { args: { label: 'Cost', value: 'not reported', note: 'the runtime does not report spend', muted: true } };

export const ARow: Story = {
  decorators: [(Story) => <div style={{ width: 720 }}>{Story()}</div>],
  render: () => (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 'var(--s3)' }}>
      <Stat label="Needs you" value="4" />
      <Stat label="Active" value="3" note="limit 3" />
      <Stat label="Agent minutes" value="15.2" note="of 18 this month" />
      <Stat label="Cost" value="not reported" muted />
    </div>
  ),
};
