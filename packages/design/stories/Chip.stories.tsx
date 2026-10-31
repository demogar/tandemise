import type { Meta, StoryObj } from '@storybook/react-vite';
import { Chip, Icon } from '../src/react/index.js';

const meta = {
  title: 'Components/Chip',
  component: Chip,
  args: { children: 'feature/csv-export', muted: false },
  argTypes: { children: { control: 'text' }, muted: { control: 'boolean' }, icon: { control: false } },
  parameters: {
    docs: {
      description: {
        component:
          'A short value in a box, set in the mono face: a kind, a version, a branch, a count. Plain text, not a control; for an identifier a person copies, use `IdChip`. `muted` for a value that matters less than the ones beside it.',
      },
    },
  },
} satisfies Meta<typeof Chip>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};
export const Muted: Story = { args: { muted: true, children: 'built-in' } };
export const WithIcon: Story = { args: { icon: <Icon name="branch" size={11} />, children: 'main' } };

export const InARow: Story = {
  render: () => (
    <div className="sb-row">
      <Chip>Plan</Chip>
      <Chip>v3 · older</Chip>
      <Chip muted icon={<Icon name="link" size={10} />}>
        PR #128
      </Chip>
      <Chip muted>2 of 3 verified</Chip>
    </div>
  ),
};
