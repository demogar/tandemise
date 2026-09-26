import { useState } from 'react';
import { Link } from 'wouter';
import type { RoutineView } from '@tandemise/api-contract';
import { Icon } from '../../components/Icon.js';
import { ConfirmDialog } from '../../components/Modal.js';
import { Empty, ErrorState, SkeletonList, Switch } from '../../components/primitives.js';
import { useDaemonMutation, useRoutines } from '../../lib/queries.js';
import { priorityLabel } from '../../lib/domain.js';
import { pluralize } from '../../lib/format.js';
import { RoutineDialog } from './RoutineDialog.js';

/**
 * Routines (P11): standing work that adds itself to the backlog on a schedule.
 *
 * Every word about time on this screen is the daemon's ("Next: Mon 09:00",
 * "Skipped: previous run still active"), so the window never re-computes a
 * schedule and can never disagree with what will happen.
 */
export function Routines(): JSX.Element {
  const routines = useRoutines();
  const [dialog, setDialog] = useState<{ editing: RoutineView | null } | null>(null);
  const [deleting, setDeleting] = useState<RoutineView | null>(null);

  const toggle = useDaemonMutation((daemon, args: { id: string; enabled: boolean }) => daemon.updateRoutine(args.id, { enabled: args.enabled }), ['missions']);
  const runNow = useDaemonMutation((daemon, id: string) => daemon.runRoutineNow(id), ['missions']);
  const remove = useDaemonMutation((daemon, id: string) => daemon.deleteRoutine(id), ['missions']);

  if (routines.isError) return <ErrorState error={routines.error} onRetry={() => void routines.refetch()} />;
  if (routines.isPending || routines.data === undefined) return <SkeletonList rows={3} />;
  const items = routines.data;

  return (
    <div className="stack" style={{ gap: 'var(--s4)' }}>
      <section aria-label="About routines" className="card">
        <div className="row row--wrap" style={{ justifyContent: 'space-between', gap: 'var(--s4)' }}>
          <p className="muted" style={{ fontSize: 'var(--fs-sm)', flex: 1, minWidth: 260 }}>
            A routine adds the same mission to your backlog on a schedule, with its Done-when lines, priority and limits, so it is
            ready to plan. It never plans or runs anything itself: your work-in-progress limit and your spending limits still decide.
          </p>
          <button type="button" className="btn" onClick={() => setDialog({ editing: null })}>
            <Icon name="plus" size={14} />
            New routine
          </button>
        </div>
      </section>

      {runNow.isError ? <ErrorState error={runNow.error} /> : null}
      {toggle.isError ? <ErrorState error={toggle.error} /> : null}

      {items.length === 0 ? (
        <div className="card">
          <Empty
            icon="clock"
            title="No routines yet"
            body="Weekly dependency updates, a nightly look at failing checks, a Friday status report: set it up once and it joins the backlog on its own."
            action={
              <button type="button" className="btn" onClick={() => setDialog({ editing: null })}>
                <Icon name="plus" size={14} />
                New routine
              </button>
            }
          />
        </div>
      ) : (
        <>
          <section aria-label="Routine list" className="list">
            {items.map((view) => (
              <RoutineRow
                key={view.routine.id}
                view={view}
                busy={toggle.isPending || runNow.isPending}
                onToggle={(enabled) => toggle.mutate({ id: view.routine.id, enabled })}
                onRunNow={() => runNow.mutate(view.routine.id)}
                onEdit={() => setDialog({ editing: view })}
                onDelete={() => setDeleting(view)}
              />
            ))}
          </section>
          <p className="dim" style={{ fontSize: 'var(--fs-xs)' }}>{pluralize(items.length, 'routine')} · times are the daemon’s local time</p>
        </>
      )}

      {dialog !== null ? <RoutineDialog editing={dialog.editing} onClose={() => setDialog(null)} /> : null}
      {deleting !== null ? (
        <ConfirmDialog
          title={`Delete “${deleting.routine.name}”?`}
          body="It stops adding missions. The missions it already added stay in your backlog and history."
          confirmLabel="Delete routine"
          destructive
          busy={remove.isPending}
          onCancel={() => setDeleting(null)}
          onConfirm={() => remove.mutate(deleting.routine.id, { onSuccess: () => setDeleting(null) })}
        />
      ) : null}
    </div>
  );
}

function RoutineRow({
  view, busy, onToggle, onRunNow, onEdit, onDelete,
}: {
  view: RoutineView;
  busy: boolean;
  onToggle: (enabled: boolean) => void;
  onRunNow: () => void;
  onEdit: () => void;
  onDelete: () => void;
}): JSX.Element {
  const { routine } = view;
  // The newest run first; older ones stay visible so a skip or a catch-up is never silent.
  const older = view.recent.slice(1, 3);
  return (
    <div className="list__row" aria-label={`Routine: ${routine.name}`} style={{ alignItems: 'flex-start' }}>
      <Icon name="clock" size={16} className="dim" />
      <div className="list__main">
        <div className="list__title truncate">{routine.name}</div>
        <div className="list__subtitle">
          {view.scheduleLabel} · <span className={routine.enabled ? 'muted' : 'dim'}>{view.nextRunLabel}</span>
        </div>
        <div className="list__subtitle">
          {view.lastLabel === null ? <span className="dim">Has not run yet.</span> : <LastOutcome view={view} />}
        </div>
        {older.map((run) => (
          <div key={run.id} className="list__subtitle dim truncate" style={{ fontSize: 'var(--fs-xs)' }}>
            Earlier: {run.label}
          </div>
        ))}
      </div>
      <div className="list__aside">
        <span className="chip chip--muted">{routine.kind === 'mission' ? `${priorityLabel(routine.priority)} mission` : 'Status report'}</span>
        <span className="row" style={{ gap: 'var(--s2)' }}>
          <span className="dim" style={{ fontSize: 'var(--fs-xs)' }}>{routine.enabled ? 'On' : 'Off'}</span>
          <Switch checked={routine.enabled} label="Enabled" onChange={onToggle} />
        </span>
        <button type="button" className="btn btn--ghost" disabled={busy} onClick={onRunNow}>Run now</button>
        <button type="button" className="btn btn--ghost" onClick={onEdit}>Edit</button>
        <button type="button" className="btn btn--ghost btn--icon" aria-label="Delete" title="Delete routine" onClick={onDelete}>
          <Icon name="trash" size={14} />
        </button>
      </div>
    </div>
  );
}

/** The last outcome, linked to what it made: the mission, or the report. */
function LastOutcome({ view }: { view: RoutineView }): JSX.Element {
  const { routine } = view;
  const label = view.lastLabel ?? '';
  const tone = routine.lastOutcome === 'failed' ? 'failed' : routine.lastOutcome === 'skipped_active' || routine.lastOutcome === 'skipped_limit' ? 'blocked' : null;
  if (routine.lastOutcome === 'created' && routine.lastMissionId !== null) {
    return <>Last: <Link href={`/missions/${routine.lastMissionId}`}>{label}</Link></>;
  }
  if (routine.lastOutcome === 'reported' && routine.lastArtifactId !== null) {
    return <>Last: <Link href={`/artifacts/${routine.lastArtifactId}`}>{label}</Link></>;
  }
  return <span className={tone === null ? undefined : `badge badge--${tone}`}>{tone === null ? `Last: ${label}` : label}</span>;
}
