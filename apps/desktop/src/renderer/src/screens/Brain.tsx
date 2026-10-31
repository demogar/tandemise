import { useState } from 'react';
import { Link } from 'wouter';
import type { BrainEntryView, BrainProposalView } from '@tandemise/api-contract';
import { PageHeader } from '../components/PageHeader.js';
import { Icon } from '../components/Icon.js';
import { Empty, ErrorState, SkeletonList } from '../components/primitives.js';
import { useBrain, useBrainEntries, useBrainFactory, useBrainProposals, useDaemonMutation } from '../lib/queries.js';
import { useWorkspaceId } from '../lib/workspace.js';
import { dateTime } from '../lib/format.js';
import { showFlash } from '../lib/notices.js';
import { Factory } from './project/Factory.js';
import { Merge } from './project/Merge.js';
import './Brain.css';
import { Badge, Button, Card, Field, Tab, Tabs } from '@tandemise/design/react';

export type BrainTab = 'sync' | 'lessons' | 'proposals' | 'factory';
const TABS: readonly { tab: BrainTab; label: string }[] = [
  { tab: 'sync', label: 'Sync' },
  { tab: 'lessons', label: 'Lessons' },
  { tab: 'proposals', label: 'Proposals' },
  { tab: 'factory', label: 'Factory' },
];

export function normalizeBrainTab(tab: string | undefined): BrainTab {
  return TABS.some((t) => t.tab === tab) ? (tab as BrainTab) : 'sync';
}

/**
 * The project's brain (#51 spec §11): how it syncs, what it has learned, the
 * rules lessons are becoming, and the factory it defines. Every sentence here
 * is the daemon's; the screen only lays it out.
 */
export function Brain({ tab }: { tab: BrainTab }): JSX.Element {
  const brain = useBrain();
  const view = brain.data;
  return (
    <>
      <PageHeader title="Brain" subtitle="What this project has learned, and how its factory works. Shared with git, one repository per project." />
      <Tabs label="Brain sections">
        {TABS.map((t) => (
          <Tab key={t.tab} as={Link} href={`/brain/${t.tab}`} selected={t.tab === tab}>{t.label}</Tab>
        ))}
      </Tabs>
      <div className="page">
        <div className="page__inner">
          {brain.isPending ? <SkeletonList rows={3} /> : brain.isError ? <ErrorState error={brain.error} /> : !view?.linked ? (
            <Empty icon="book" title="This project has no brain yet" body="Link one in Project settings: create one, use a teammate's, or keep it on this machine." action={<Link href="/project" className="btn btn--primary">Open Project settings</Link>} />
          ) : tab === 'sync' ? <SyncTab /> : tab === 'lessons' ? <LessonsTab /> : tab === 'proposals' ? <ProposalsTab /> : <FactoryTab />}
        </div>
      </div>
    </>
  );
}

function SyncTab(): JSX.Element {
  const workspaceId = useWorkspaceId() ?? '';
  const view = useBrain().data!;
  const sync = useDaemonMutation((daemon) => daemon.syncBrain(workspaceId), ['workspaces', 'missions']);
  return (
    <section className="section" aria-label="Brain sync">
      <Card className="stack">
        <p aria-label="Brain status line" data-status={view.status} style={{ margin: 0 }}>{view.statusLine}</p>
        <dl className="brain__facts">
          <dt>Repository</dt><dd>{view.remoteUrl ? <a href={view.remoteUrl} target="_blank" rel="noreferrer">{view.remote}</a> : (view.remote ?? 'Only on this machine')}</dd>
          <dt>Last pulled</dt><dd className="mono">{view.lastPulledSha?.slice(0, 7) ?? 'never'}</dd>
          <dt>Last pushed</dt><dd className="mono">{view.lastPushedSha?.slice(0, 7) ?? 'never'}</dd>
          <dt>Last synced</dt><dd>{view.lastSyncAt === null ? 'never' : dateTime(view.lastSyncAt)}</dd>
          <dt>You write as</dt><dd className="mono">{view.writerId}</dd>
        </dl>
        {view.problems.map((p) => <div key={p} className="banner banner--warn">{p}</div>)}
        <div className="row">
          <Button disabled={sync.isPending} onClick={() => sync.mutate(undefined, { onSuccess: (v) => showFlash(v.statusLine) })}>
            <Icon name="refresh" size={13} />
            {sync.isPending ? 'Syncing…' : 'Sync now'}
          </Button>
        </div>
        {sync.isError ? <ErrorState error={sync.error} /> : null}
      </Card>
    </section>
  );
}

const STATE_FILTERS: readonly { value: string; label: string }[] = [
  { value: '', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'candidate', label: 'Waiting for you' },
  { value: 'accepted', label: 'Accepted' },
];

function LessonsTab(): JSX.Element {
  const workspaceId = useWorkspaceId() ?? '';
  const [state, setState] = useState('');
  const [showHistory, setShowHistory] = useState(false);
  const entries = useBrainEntries(state === '' ? {} : { state });
  const history = useBrainEntries({ history: true }, showHistory);
  const [text, setText] = useState('');
  const remember = useDaemonMutation((daemon, body: { text: string }) => daemon.remember(workspaceId, body), ['workspaces']);
  const live = entries.data ?? [];
  const past = (history.data ?? []).filter((e) => e.invalidAt !== null || e.kind === 'history');
  return (
    <section className="section" aria-label="Lessons">
      <Card className="stack" aria-label="Remember this">
        <Field label="Remember this">
          <textarea className="input" aria-label="Remember this text" rows={2} value={text} placeholder="One short sentence the next person doing this should know." onChange={(e) => setText(e.target.value)} />
        </Field>
        <div className="row">
          <Button variant="primary" disabled={remember.isPending || text.trim() === ''} onClick={() => remember.mutate({ text: text.trim() }, { onSuccess: (v) => { setText(''); showFlash(v.message); } })}>
            {remember.isPending ? 'Saving…' : 'Remember'}
          </Button>
        </div>
        {remember.isError ? <ErrorState error={remember.error} /> : null}
      </Card>
      <div className="row" style={{ marginTop: 'var(--s3)' }}>
        <div className="segmented" role="group" aria-label="Lesson filter">
          {STATE_FILTERS.map((f) => (
            <button key={f.value} type="button" className="segmented__option" aria-pressed={state === f.value} onClick={() => setState(f.value)}>{f.label}</button>
          ))}
        </div>
      </div>
      {entries.isPending ? <SkeletonList rows={3} /> : entries.isError ? <ErrorState error={entries.error} /> : live.length === 0 ? (
        <Empty icon="book" title="No lessons yet" body="When you hold a step and fix it, ask for changes, or press Remember this, the brain keeps a short lesson here." />
      ) : (
        <ul className="brain__list" aria-label="Lesson list">
          {live.map((e) => <LessonRow key={e.id} entry={e} />)}
        </ul>
      )}
      <Button variant="ghost" style={{ marginTop: 'var(--s3)' }} onClick={() => setShowHistory((v) => !v)}>
        {showHistory ? 'Hide history' : 'Show history'}
      </Button>
      {showHistory ? (
        <ul className="brain__list" aria-label="History">
          {past.length === 0 ? <li className="muted">Nothing superseded, retired or finished yet.</li> : past.map((e) => <LessonRow key={e.id} entry={e} readOnly />)}
        </ul>
      ) : null}
    </section>
  );
}

export function LessonRow({ entry, readOnly = false, taskId }: { entry: BrainEntryView; readOnly?: boolean; taskId?: string }): JSX.Element {
  const vote = useDaemonMutation((daemon, v: 'helpful' | 'harmful') => daemon.voteEntry(entry.id, { vote: v, ...(taskId ? { taskId } : {}) }), ['workspaces']);
  const accept = useDaemonMutation((daemon) => daemon.acceptEntry(entry.id), ['workspaces']);
  const reject = useDaemonMutation((daemon) => daemon.rejectEntry(entry.id), ['workspaces']);
  const retire = useDaemonMutation((daemon) => daemon.retireEntry(entry.id), ['workspaces']);
  const promote = useDaemonMutation((daemon) => daemon.promoteEntry(entry.id), ['workspaces']);
  const busy = vote.isPending || accept.isPending || reject.isPending || retire.isPending || promote.isPending;
  const error = vote.error ?? accept.error ?? reject.error ?? retire.error ?? promote.error;
  return (
    <li className="brain__row" aria-label={`Lesson: ${entry.text}`} data-state={entry.state}>
      <div className="brain__text">{entry.text}</div>
      <div className="brain__meta">
        <span className="chip">{entry.scopeLabel}</span>
        <span>From {entry.sourceLabel}{entry.sourceMission && entry.sourceLabel !== 'you' ? ` · ${entry.sourceMission}` : ''}</span>
        <span aria-label="Counters">+{entry.helpful} / −{entry.harmful}</span>
        {entry.state === 'candidate' ? <Badge tone="pending">Waiting for you</Badge> : null}
        {entry.promoted ? <Badge tone="running">Proposed as a rule</Badge> : null}
        {entry.retired ? <Badge>Retired: {entry.retired.reason}</Badge> : null}
        {entry.supersededBy ? <Badge>Replaced by a newer lesson</Badge> : null}
        {entry.notes.map((n) => <span key={n} className="muted">{n}</span>)}
        {entry.runLink ? <Link href={`/missions/${entry.runLink.missionId}`} className="muted">Open the run</Link> : null}
      </div>
      {readOnly ? null : (
        <div className="row brain__actions">
          <Button variant="ghost" className="btn--sm" aria-label="Helpful" disabled={busy} onClick={() => vote.mutate('helpful')}>Helpful</Button>
          <Button variant="ghost" className="btn--sm" aria-label="Not helpful" disabled={busy} onClick={() => vote.mutate('harmful')}>Not helpful</Button>
          {entry.state === 'candidate' ? (
            <>
              <Button className="btn--sm" disabled={busy} onClick={() => accept.mutate(undefined)}>Accept</Button>
              <Button variant="ghost" className="btn--sm" disabled={busy} onClick={() => reject.mutate(undefined)}>Reject</Button>
            </>
          ) : null}
          {entry.kind === 'lesson' && entry.promoted === null && entry.state !== 'candidate' ? (
            <Button className="btn--sm" disabled={busy} onClick={() => promote.mutate(undefined, { onSuccess: () => showFlash('Proposed as a rule. See Proposals.') })}>Make this a rule</Button>
          ) : null}
          {entry.flags.harmful ? <Button variant="ghost" className="btn--sm" disabled={busy} onClick={() => vote.mutate('helpful')}>Keep</Button> : null}
          <Button variant="ghost" className="btn--sm" disabled={busy} onClick={() => retire.mutate(undefined)}>Retire</Button>
        </div>
      )}
      {error ? <ErrorState error={error} /> : null}
    </li>
  );
}

function ProposalsTab(): JSX.Element {
  const proposals = useBrainProposals();
  const list = proposals.data ?? [];
  if (proposals.isPending) return <SkeletonList rows={2} />;
  if (proposals.isError) return <ErrorState error={proposals.error} />;
  return (
    <section className="section" aria-label="Proposals">
      {list.length === 0 ? (
        <Empty icon="book" title="No proposals yet" body="When a lesson keeps proving useful, the brain proposes it as a rule, with its evidence and an eval scorecard." />
      ) : (
        <ul className="brain__list" aria-label="Proposal list">{list.map((p) => <ProposalRow key={p.id} proposal={p} />)}</ul>
      )}
    </section>
  );
}

function ProposalRow({ proposal }: { proposal: BrainProposalView }): JSX.Element {
  const accept = useDaemonMutation((daemon) => daemon.acceptProposal(proposal.id), ['workspaces']);
  const decline = useDaemonMutation((daemon) => daemon.declineProposal(proposal.id), ['workspaces']);
  const revert = useDaemonMutation((daemon) => daemon.revertProposal(proposal.id), ['workspaces']);
  const error = accept.error ?? decline.error ?? revert.error;
  return (
    <li className="brain__row" aria-label={`Proposal: ${proposal.lessons[0]?.text ?? proposal.id}`} data-state={proposal.state}>
      <div className="brain__text">{proposal.lessons.map((l) => l.text).join(' · ')}</div>
      <div className="brain__meta">
        <Badge>{proposal.stateLabel}</Badge>
        <span>{proposal.classificationLine}</span>
        <span>{proposal.verdictLine}</span>
        <span className="mono">{proposal.targets.join(', ')}</span>
        {proposal.prUrl ? <a href={proposal.prUrl} target="_blank" rel="noreferrer">Open the pull request</a> : null}
      </div>
      <div className="row brain__actions">
        {proposal.canAccept ? (
          <>
            <Button variant="primary" className="btn--sm" disabled={accept.isPending} onClick={() => accept.mutate(undefined)}>Accept</Button>
            <Button variant="ghost" className="btn--sm" disabled={decline.isPending} onClick={() => decline.mutate(undefined)}>Decline</Button>
          </>
        ) : null}
        {proposal.canRevert ? <Button className="btn--sm" disabled={revert.isPending} onClick={() => revert.mutate(undefined)}>Revert</Button> : null}
      </div>
      {error ? <ErrorState error={error} /> : null}
    </li>
  );
}

function FactoryTab(): JSX.Element {
  const workspaceId = useWorkspaceId() ?? '';
  const factory = useBrainFactory();
  const move = useDaemonMutation((daemon, id: string) => daemon.moveWorkflowIntoBrain(workspaceId, id), ['workspaces']);
  if (factory.isPending) return <SkeletonList rows={3} />;
  if (factory.isError) return <ErrorState error={factory.error} />;
  const view = factory.data;
  return (
    <section className="section stack" aria-label="Factory">
      {view.mcpsNeeded.length > 0 ? (
        <Card className="stack" aria-label="Connections needed">
          {view.mcpsNeeded.map((m) => (
            <div key={m.name} className="row" style={{ gap: 'var(--s2)' }}>
              <span>{m.detail}</span>
              <Link href="/integrations" className="btn btn--sm">Connect</Link>
            </div>
          ))}
        </Card>
      ) : null}
      {view.skillsMissing.length > 0 ? <div className="banner banner--warn">Missing on this machine: {view.skillsMissing.join(', ')}.</div> : null}
      <Card>
        <div className="field__label">Factory files</div>
        <ul className="mono brain__files" aria-label="Factory files">{view.files.map((f) => <li key={f}>{f}</li>)}</ul>
      </Card>
      {view.shadowed.length > 0 || view.movable.length > 0 ? (
        <Card className="stack" aria-label="Code-repository workflows">
          <div className="field__label">Workflows in your code repositories</div>
          {view.shadowed.map((w) => <p key={`s-${w.id}`} className="muted" style={{ margin: 0 }}>{w.id}: the brain's own {w.id} is used instead.</p>)}
          {view.movable.map((w) => (
            <div key={w.id} className="row" style={{ gap: 'var(--s2)' }}>
              <span className="mono">{w.id}</span>
              <Button className="btn--sm" disabled={move.isPending} onClick={() => move.mutate(w.id, { onSuccess: () => showFlash(`Moved ${w.id} into the brain.`) })}>Move into the brain</Button>
            </div>
          ))}
          {move.isError ? <ErrorState error={move.error} /> : null}
        </Card>
      ) : null}
      {/* The planner, routing and merge rules (#53): read from the brain's factory/, edited here as a commit to it. */}
      <Factory workspaceId={workspaceId} />
      <Merge workspaceId={workspaceId} />
    </section>
  );
}
