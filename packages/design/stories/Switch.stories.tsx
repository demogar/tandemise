import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState, type ReactElement } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { Field, Switch } from '../src/react/index.js';

/** Holds its state, the way a settings row does. */
function Controlled({ label = 'Notify me when a mission needs me', initial = false, disabled = false }: { label?: string; initial?: boolean; disabled?: boolean }): ReactElement {
  const [on, setOn] = useState(initial);
  return <Switch label={label} checked={on} onChange={setOn} disabled={disabled} />;
}

const meta = {
  title: 'Components/Switch',
  component: Switch,
  args: { label: 'Notify me when a mission needs me', checked: false, disabled: false, onChange: () => undefined },
  argTypes: { label: { control: 'text' }, checked: { control: 'boolean' }, disabled: { control: 'boolean' }, onChange: { control: false } },
  render: (args) => <Controlled key={String(args.checked)} label={args.label} initial={args.checked} disabled={args.disabled} />,
  parameters: {
    docs: {
      description: {
        component:
          'An on/off setting that takes effect at once: a `<button role="switch">` with `aria-checked`, toggled by a click, Space or Enter. It has no visible text, so it must be named: `label`, `aria-labelledby`, or a wrapping `<label>` (a `Field`). The track is 34x20; the hit area is 24px tall. For a choice that waits for a form\'s submit, use a checkbox.',
      },
    },
  },
} satisfies Meta<typeof Switch>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};
export const On: Story = { args: { checked: true } };
export const Disabled: Story = { args: { disabled: true } };
export const DisabledOn: Story = { args: { checked: true, disabled: true } };

/** In a settings row: the row's visible title names the switch through `aria-labelledby`. */
export const InASettingsRow: Story = {
  render: () => {
    const [on, setOn] = useState(true);
    return (
      <div className="sb-row" style={{ justifyContent: 'space-between', width: 420 }}>
        <div>
          <div id="debug-title" style={{ fontWeight: 600 }}>
            Debug mode
          </div>
          <div id="debug-detail" style={{ color: 'var(--text-secondary)', fontSize: 'var(--fs-sm)' }}>
            Shows raw runtime output by default.
          </div>
        </div>
        <Switch aria-labelledby="debug-title" aria-describedby="debug-detail" checked={on} onChange={setOn} />
      </div>
    );
  },
  play: async ({ canvas }) => {
    const toggle = canvas.getByRole('switch', { name: 'Debug mode' });
    await expect(toggle).toHaveAccessibleDescription('Shows raw runtime output by default.');
    await expect(toggle).toBeChecked();
  },
};

/** Wrapped by a `Field`'s label: the `<label>` names the switch, no `label` prop needed. */
export const InAField: Story = {
  render: () => {
    const [on, setOn] = useState(false);
    return (
      <Field label="Trust its read-only labels" hint="Tools the server marks read-only run without asking.">
        <Switch checked={on} onChange={setOn} />
      </Field>
    );
  },
  play: async ({ canvas }) => {
    // The wrapping <label> names it (its hint is part of the label's text).
    await expect(canvas.getByRole('switch', { name: /^Trust its read-only labels/ })).not.toBeChecked();
  },
};

/** A keyboard walkthrough: Tab reaches it, Space and Enter toggle it, a disabled switch is skipped. */
export const Keyboard: Story = {
  render: () => (
    <div className="sb-row">
      <Controlled label="Desktop notifications" />
      <Controlled label="Sound" disabled />
      <Controlled label="Weekly digest" initial />
    </div>
  ),
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    const notifications = canvas.getByRole('switch', { name: 'Desktop notifications' });
    const digest = canvas.getByRole('switch', { name: 'Weekly digest' });
    await step('Tab reaches it, off', async () => {
      await userEvent.tab();
      await expect(notifications).toHaveFocus();
      await expect(notifications).toHaveAttribute('aria-checked', 'false');
    });
    await step('Space turns it on, Enter turns it off', async () => {
      await userEvent.keyboard(' ');
      await expect(notifications).toHaveAttribute('aria-checked', 'true');
      await userEvent.keyboard('{Enter}');
      await expect(notifications).toHaveAttribute('aria-checked', 'false');
    });
    await step('the disabled switch is skipped', async () => {
      await userEvent.tab();
      await expect(digest).toHaveFocus();
      await expect(digest).toBeChecked();
    });
    await step('its hit area is at least 24px tall', async () => {
      const box = notifications.getBoundingClientRect();
      const before = getComputedStyle(notifications, '::before');
      await expect(box.height + 2 * Math.abs(parseFloat(before.top))).toBeGreaterThanOrEqual(24);
    });
  },
};
