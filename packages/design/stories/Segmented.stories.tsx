import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState, type ReactElement } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { Field, Segmented, type SegmentedOption } from '../src/react/index.js';

const THEMES: readonly SegmentedOption<string>[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

/** Holds the choice, the way a screen does. */
function Controlled({ initial = 'system', options = THEMES, ...rest }: { initial?: string; options?: readonly SegmentedOption<string>[]; label?: string; block?: boolean }): ReactElement {
  const [value, setValue] = useState(initial);
  return (
    <div className="sb-stack">
      <Segmented label="Theme" {...rest} value={value} options={options} onChange={setValue} />
      <p style={{ color: 'var(--text-secondary)', fontSize: 'var(--fs-sm)' }}>Chosen: {value}</p>
    </div>
  );
}

const meta = {
  title: 'Components/Segmented',
  component: Segmented,
  args: { label: 'Theme', value: 'system', options: THEMES, block: false, onChange: () => undefined },
  argTypes: {
    label: { control: 'text' },
    block: { control: 'boolean' },
    value: { control: false },
    options: { control: false },
    onChange: { control: false },
  },
  render: (args) => <Controlled label={args.label} block={args.block} />,
  parameters: {
    docs: {
      description: {
        component:
          'A small set of mutually exclusive choices drawn as one control: a theme, a time window, a priority. It is a radio group (`radiogroup`, a `radio` per option with `aria-checked`), so it must be named, by `label` or by `aria-labelledby` pointing at a visible label. Only the chosen option is in the tab order; the arrow keys move the choice along the group and wrap, Home and End jump to the ends, and disabled options are skipped. For more than five options, or long labels, use a select.',
      },
    },
  },
} satisfies Meta<typeof Segmented<string>>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

/** `block`: the options share the width of their container. */
export const Block: Story = { render: () => <div style={{ width: 360 }}><Controlled block /></div> };

export const WithADisabledOption: Story = {
  render: () => (
    <Controlled
      label="Window"
      initial="7"
      options={[
        { value: '7', label: '7 days' },
        { value: '30', label: '30 days' },
        { value: '90', label: '90 days', disabled: true },
        { value: 'all', label: 'All time' },
      ]}
    />
  ),
};

/** Inside a `Field`: named by the field's visible label, described by its hint. */
export const InAField: Story = {
  render: () => {
    const [value, setValue] = useState('normal');
    return (
      <div style={{ width: 360 }}>
        <Field label="Priority" hint="Orders the backlog. Urgent work is planned first.">
          {(control, label) => (
            <Segmented
              aria-labelledby={label.id}
              aria-describedby={control['aria-describedby']}
              value={value}
              onChange={setValue}
              options={[
                { value: 'low', label: 'Low' },
                { value: 'normal', label: 'Normal' },
                { value: 'high', label: 'High' },
                { value: 'urgent', label: 'Urgent' },
              ]}
            />
          )}
        </Field>
      </div>
    );
  },
  play: async ({ canvas }) => {
    const group = canvas.getByRole('radiogroup', { name: 'Priority' });
    await expect(group).toHaveAccessibleDescription('Orders the backlog. Urgent work is planned first.');
    await expect(within(group).getByRole('radio', { name: 'Normal' })).toBeChecked();
  },
};

/** A keyboard walkthrough: Tab lands on the chosen option, arrows move the choice and wrap, Home/End jump, disabled options are skipped. */
export const KeyboardNavigation: Story = {
  render: () => (
    <Controlled
      label="Window"
      initial="30"
      options={[
        { value: '7', label: '7 days' },
        { value: '30', label: '30 days' },
        { value: '90', label: '90 days', disabled: true },
        { value: 'all', label: 'All time' },
      ]}
    />
  ),
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    const group = canvas.getByRole('radiogroup', { name: 'Window' });
    const radio = (name: string): HTMLElement => within(group).getByRole('radio', { name });
    await step('only the chosen option is in the tab order', async () => {
      await expect(within(group).getAllByRole('radio').map((r) => r.getAttribute('tabindex'))).toEqual(['-1', '0', '-1', '-1']);
      await userEvent.tab();
      await expect(radio('30 days')).toHaveFocus();
    });
    await step('ArrowRight moves the choice and skips the disabled option', async () => {
      await userEvent.keyboard('{ArrowRight}');
      await expect(radio('All time')).toHaveFocus();
      await expect(radio('All time')).toBeChecked();
      await expect(canvas.getByText('Chosen: all')).toBeInTheDocument();
    });
    await step('it wraps from the last option to the first', async () => {
      await userEvent.keyboard('{ArrowRight}');
      await expect(radio('7 days')).toBeChecked();
      await userEvent.keyboard('{ArrowLeft}');
      await expect(radio('All time')).toBeChecked();
    });
    await step('Home and End jump to the ends; Up and Down work like Left and Right', async () => {
      await userEvent.keyboard('{Home}');
      await expect(radio('7 days')).toBeChecked();
      await userEvent.keyboard('{End}');
      await expect(radio('All time')).toBeChecked();
      await userEvent.keyboard('{ArrowUp}');
      await expect(radio('30 days')).toBeChecked();
      await userEvent.keyboard('{ArrowDown}');
      await expect(radio('All time')).toBeChecked();
    });
    await step('Tab leaves the group in one step', async () => {
      await userEvent.tab();
      await expect(group).not.toContainElement(document.activeElement as HTMLElement);
    });
  },
};
