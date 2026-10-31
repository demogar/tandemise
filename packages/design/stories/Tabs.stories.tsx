import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState, type ReactElement } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { Tab, Tabs } from '../src/react/index.js';

const SECTIONS = [
  { id: 'agents', label: 'You & agents', count: 8 },
  { id: 'staffing', label: 'Staffing', count: undefined },
  { id: 'roles', label: 'Roles', count: 3 },
  { id: 'limits', label: 'Limits', count: undefined },
];

/** Tabs that switch a panel, the way the desktop's Team screen does. */
function Switcher({ label = 'Team sections', withCounts = true }: { label?: string; withCounts?: boolean }): ReactElement {
  const [current, setCurrent] = useState(SECTIONS[0]!.id);
  return (
    <div className="sb-stack">
      <Tabs label={label}>
        {SECTIONS.map((section) => (
          <Tab
            key={section.id}
            id={`tab-${section.id}`}
            aria-controls="panel"
            selected={current === section.id}
            count={withCounts ? section.count : undefined}
            onClick={() => setCurrent(section.id)}
          >
            {section.label}
          </Tab>
        ))}
      </Tabs>
      <div role="tabpanel" id="panel" aria-labelledby={`tab-${current}`} tabIndex={0}>
        Showing {SECTIONS.find((section) => section.id === current)?.label}.
      </div>
    </div>
  );
}

const meta = {
  title: 'Components/Tabs',
  component: Tabs,
  subcomponents: { Tab },
  args: { label: 'Team sections', children: null },
  argTypes: { label: { control: 'text' }, children: { control: false } },
  render: (args) => <Switcher label={args.label} />,
  parameters: {
    docs: {
      description: {
        component:
          '`Tabs` is the `tablist`; each `Tab` is a `tab` with `aria-selected`. Only the selected tab is in the tab order (roving `tabIndex`); Left/Right wrap, Home/End jump to the ends, and Enter or a click activates, so a `Tab` can be a router link (`as`) as well as a button.',
      },
    },
  },
} satisfies Meta<typeof Tabs>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

export const WithoutCounts: Story = { render: (args) => <Switcher label={args.label} withCounts={false} /> };

/** `as="a"`: a tab that is a link, as the desktop's router links are. */
export const AsLinks: Story = {
  render: () => (
    <Tabs label="Board sections">
      <Tab as="a" href="#board" selected={false} count={12}>
        Board
      </Tab>
      <Tab as="a" href="#intake" selected count={3}>
        Intake
      </Tab>
      <Tab as="a" href="#done" selected={false}>
        Done
      </Tab>
    </Tabs>
  ),
  play: async ({ canvas }) => {
    const intake = canvas.getByRole('tab', { name: /Intake/ });
    await expect(intake.tagName).toBe('A');
    await expect(intake).toHaveAttribute('aria-selected', 'true');
    await expect(intake).toHaveAttribute('tabindex', '0');
  },
};

/** Arrow keys move focus between tabs and wrap; Home and End go to the ends; Enter activates. */
export const KeyboardNavigation: Story = {
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    const tabs = canvas.getAllByRole('tab');
    await step('only the selected tab is in the tab order', async () => {
      await expect(tabs.map((tab) => tab.getAttribute('tabindex'))).toEqual(['0', '-1', '-1', '-1']);
      await userEvent.tab();
      await expect(tabs[0]).toHaveFocus();
    });
    await step('ArrowRight moves on, and wraps from the last', async () => {
      await userEvent.keyboard('{ArrowRight}');
      await expect(tabs[1]).toHaveFocus();
      await userEvent.keyboard('{End}');
      await expect(tabs[3]).toHaveFocus();
      await userEvent.keyboard('{ArrowRight}');
      await expect(tabs[0]).toHaveFocus();
    });
    await step('ArrowLeft wraps from the first; Home goes back', async () => {
      await userEvent.keyboard('{ArrowLeft}');
      await expect(tabs[3]).toHaveFocus();
      await userEvent.keyboard('{Home}');
      await expect(tabs[0]).toHaveFocus();
    });
    await step('Enter activates the focused tab', async () => {
      await userEvent.keyboard('{ArrowRight}{ArrowRight}{Enter}');
      await expect(tabs[2]).toHaveAttribute('aria-selected', 'true');
      await expect(canvas.getByRole('tabpanel')).toHaveTextContent('Showing Roles.');
    });
  },
};
