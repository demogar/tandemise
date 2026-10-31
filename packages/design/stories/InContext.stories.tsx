import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState, type ReactElement } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { Badge, Button, Card, Dialog, EmptyState, Field, Icon, Logo, StatusDot, StatusPill, Tab, Tabs, Tooltip, type Tone } from '../src/react/index.js';

/**
 * The components composed the way the desktop composes them. These are the
 * screens to look at when a token or a component changes: a regression shows
 * here first, in a real arrangement rather than alone on a canvas.
 */
const meta = {
  title: 'In context/Desktop',
  parameters: { layout: 'padded' },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

interface Task {
  title: string;
  tone: Tone;
  status: string;
  worker: string;
  detail: string;
}

const TASKS: Task[] = [
  { title: 'Write the settings migration', tone: 'running', status: 'Running', worker: 'Claude · backend', detail: 'Step 2 of 4 · 6m' },
  { title: 'Review the plan for the billing page', tone: 'blocked', status: 'Needs you', worker: 'You', detail: 'Waiting 12m' },
  { title: 'Fix the flaky upload test', tone: 'failed', status: 'Checks failed', worker: 'Codex · tests', detail: '2 of 31 failing' },
  { title: 'Ship the onboarding copy', tone: 'succeeded', status: 'Merged', worker: 'Gemini · docs', detail: '#214 · 1h ago' },
];

function TaskCard({ task }: { task: Task }): ReactElement {
  return (
    <Card
      title={task.title}
      actions={
        <Tooltip content="Open the task in its own window">
          {(trigger) => (
            <Button iconOnly variant="ghost" aria-label={`Open ${task.title}`} {...trigger}>
              <Icon name="externalLink" size={14} />
            </Button>
          )}
        </Tooltip>
      }
    >
      <div className="sb-stack">
        <div className="sb-row">
          <StatusPill tone={task.tone} label={task.status} live={task.tone === 'running'} />
          <Badge>{task.worker}</Badge>
          <span style={{ color: 'var(--text-secondary)', fontSize: 'var(--fs-sm)' }}>{task.detail}</span>
        </div>
        <div className="sb-row">
          {task.tone === 'blocked' ? (
            <>
              <Button variant="primary">Approve plan</Button>
              <Button>Request changes</Button>
            </>
          ) : task.tone === 'failed' ? (
            <>
              <Button>
                <Icon name="refresh" size={14} />
                Re-run checks
              </Button>
              <Button variant="ghost">See the log</Button>
            </>
          ) : task.tone === 'running' ? (
            <Button variant="ghost">
              <Icon name="terminal" size={14} />
              Watch
            </Button>
          ) : (
            <Button variant="ghost">
              <Icon name="branch" size={14} />
              Open the pull request
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}

/** A task card: title, status pill, the worker, and the actions its state allows. */
export const TaskCards: Story = {
  render: () => (
    <div className="sb-stack sb-wide">
      {TASKS.map((task) => (
        <TaskCard key={task.title} task={task} />
      ))}
    </div>
  ),
};

/** The desktop's ConfirmDialog: Cancel, then the action; the confirm shows its work while it runs. */
function ConfirmCancel(): ReactElement {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  const confirm = () => {
    setBusy(true);
    setTimeout(() => {
      setBusy(false);
      setOpen(false);
      setCancelled(true);
    }, 600);
  };
  return (
    <div className="sb-dialog-frame">
      <div className="sb-row">
        <Button variant="danger" onClick={() => setOpen(true)} disabled={cancelled}>
          Cancel mission
        </Button>
        {cancelled ? <StatusPill tone="pending" label="Cancelled" /> : <StatusPill tone="running" label="Running" live />}
      </div>
      {open ? (
        <Dialog
          title="Cancel this mission?"
          description="Running steps stop; their work so far is kept."
          onClose={() => setOpen(false)}
          closeOnScrim={!busy}
          footer={
            <>
              <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
                Keep it
              </Button>
              <Button variant="danger" data-autofocus loading={busy} loadingLabel="Cancelling…" onClick={confirm}>
                Cancel mission
              </Button>
            </>
          }
        >
          Nothing is deleted. You can start it again from the backlog.
        </Dialog>
      ) : null}
    </div>
  );
}

export const ConfirmDialog: Story = {
  render: () => <ConfirmCancel />,
  parameters: { layout: 'fullscreen', docs: { story: { inline: false, height: '360px' } } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Cancel mission' }));
    const dialog = await canvas.findByRole('dialog', { name: 'Cancel this mission?' });
    const confirm = within(dialog).getByRole('button', { name: 'Cancel mission' });
    // Focus moves into the dialog. Known gap: it lands on "Keep it", not on the
    // `data-autofocus` button, because Dialog's default `initialFocus` is one
    // selector list and querySelector returns the first match in document order.
    await waitFor(() => expect(dialog).toContainElement(document.activeElement as HTMLElement));
    await userEvent.click(confirm);
    await expect(within(dialog).getByRole('button', { name: 'Cancelling…' })).toHaveAttribute('aria-busy', 'true');
    await waitFor(() => expect(canvas.getByText('Cancelled')).toBeInTheDocument(), { timeout: 3000 });
  },
};

/** A settings section: fields with hints, one with an error, and the one primary action. */
function SettingsGroup(): ReactElement {
  const [url, setUrl] = useState('http://relay.local');
  const error = url.startsWith('https://') ? undefined : 'The relay must be served over HTTPS.';
  return (
    <Card title="Team relay" actions={<Badge tone="accent">Beta</Badge>} className="sb-wide">
      <form className="sb-stack" onSubmit={(event) => event.preventDefault()}>
        <Field label="Relay URL" required hint="Where your team's daemons meet." error={error}>
          {(control) => <input className="input" type="url" value={url} onChange={(event) => setUrl(event.target.value)} {...control} />}
        </Field>
        <Field label="Your name on the relay" hint="Shown to teammates beside what you claim.">
          {(control) => <input className="input" defaultValue="Ada" {...control} />}
        </Field>
        <Field label="When a teammate claims your task">
          <select className="select" defaultValue="notify">
            <option value="notify">Notify me</option>
            <option value="silent">Do nothing</option>
          </select>
        </Field>
        <div className="sb-row">
          <Button variant="primary" type="submit" disabled={error !== undefined}>
            Save
          </Button>
          <Button variant="ghost">Disconnect</Button>
        </div>
      </form>
    </Card>
  );
}

export const SettingsFieldGroup: Story = {
  render: () => <SettingsGroup />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const url = canvas.getByRole('textbox', { name: /Relay URL/ });
    await expect(url).toHaveAttribute('aria-invalid', 'true');
    await expect(canvas.getByRole('button', { name: 'Save' })).toBeDisabled();
    await userEvent.clear(url);
    await userEvent.type(url, 'https://relay.example.com');
    await expect(url).not.toHaveAttribute('aria-invalid');
    await expect(canvas.getByRole('button', { name: 'Save' })).toBeEnabled();
  },
};

/** A screen header with tabs over a list, and an empty tab. */
function ProjectScreen(): ReactElement {
  const [tab, setTab] = useState<'board' | 'intake'>('board');
  return (
    <div className="sb-stack sb-wide">
      <div className="sb-row" style={{ justifyContent: 'space-between' }}>
        <span className="sb-row" style={{ fontSize: 'var(--fs-lg)', fontWeight: 650 }}>
          <Logo size={22} />
          tandemise-web
        </span>
        <Button variant="primary">
          <Icon name="plus" size={14} />
          New mission
        </Button>
      </div>
      <Tabs label="Project sections">
        <Tab id="tab-board" aria-controls="project-panel" selected={tab === 'board'} count={TASKS.length} onClick={() => setTab('board')}>
          Board
        </Tab>
        <Tab id="tab-intake" aria-controls="project-panel" selected={tab === 'intake'} onClick={() => setTab('intake')}>
          Intake
        </Tab>
      </Tabs>
      <div role="tabpanel" id="project-panel" aria-labelledby={`tab-${tab}`}>
        {tab === 'board' ? (
          <Card flush>
            {TASKS.map((task) => (
              <div key={task.title} className="sb-row" style={{ padding: 'var(--s3) var(--s4)', borderBottom: '1px solid var(--border)' }}>
                <StatusDot tone={task.tone} live={task.tone === 'running'} />
                <span style={{ flex: 1 }}>{task.title}</span>
                <Badge tone={task.tone}>{task.status}</Badge>
              </div>
            ))}
          </Card>
        ) : (
          <Card flush>
            <EmptyState inline icon={<Icon name="flag" size={18} />} title="Nothing in intake" body="Issues and alerts from your connected tools land here." />
          </Card>
        )}
      </div>
    </div>
  );
}

export const ProjectBoard: Story = { render: () => <ProjectScreen /> };
