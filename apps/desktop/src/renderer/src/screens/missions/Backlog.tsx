import { useCallback, useEffect } from 'react';
import { Link, useLocation } from 'wouter';
import { useQueryClient } from '@tanstack/react-query';
import type { MissionPriority } from '@tandemise/domain';
import type { BacklogItemView, BacklogView, UpdateMissionRequest } from '@tandemise/api-contract';
import { Icon } from '../../components/Icon.js';
import { Empty, ErrorState, Segmented, SkeletonList } from '../../components/primitives.js';
import { keys, useBacklog, useDaemonMutation } from '../../lib/queries.js';
import { useWorkspaceId } from '../../lib/workspace.js';
import { isTypingTarget, useListCursor } from '../../lib/keyboard.js';
import { MISSION_PRIORITIES, priorityLabel } from '../../lib/domain.js';
import { showFlash } from '../../lib/notices.js';
import { pluralize } from '../../lib/format.js';

/** The limits one click away; any other value set elsewhere is shown too. */
const LIMIT_OPTIONS = ['off', '1', '2', '3', '5'] as const;

/**
 * The backlog (P7): every draft, in the order Tandemise plans the queued ones.
 *
 * The daemon owns the order and the pull; this screen only says what it will
 * do next and lets the person change the inputs - priority, place, queue, and
 * how many missions may be in progress at once. Every reorder is a button and
 * a key, so the order can be changed without a mouse.
 */
export function Backlog(): JSX.Element {
  const [, navigate] = useLocation();
  const workspaceId = useWorkspaceId();
  const queryClient = useQueryClient();
  const backlog = useBacklog();
  const items = backlog.data?.items ?? [];

  const update = useDaemonMutation(
    (daemon, args: { id: string; body: UpdateMissionRequest }) => daemon.updateMission(args.id, args.body),
    ['missions'],
  );
  const setLimit = useDaemonMutation(
    (daemon, limit: number | null) => daemon.updateWorkspace(workspaceId ?? '', { maxActiveMissions: limit }),
    ['workspaces', 'missions'],
  );

  const open = useCallback((index: number) => {
    const target = items[index];
    if (target) navigate(`/missions/${target.summary.mission.id}`);
  }, [items, navigate]);
  const [cursor, setCursor] = useListCursor(items.length, open);

  // The answer is the new backlog: shown at once, so the row (and the cursor) never jumps back.
  const applied = (view: BacklogView): void => {
    queryClient.setQueryData(keys.backlog(workspaceId), view);
  };

  const move = useCallback((index: number, direction: 'up' | 'down') => {
    const item = items[index];
    const neighbour = items[direction === 'up' ? index - 1 : index + 1];
    if (!item || !neighbour || update.isPending) return;
    update.mutate({ id: item.summary.mission.id, body: { move: direction } }, {
      onSuccess: (view) => {
        applied(view);
        const next = view.items.findIndex((i) => i.summary.mission.id === item.summary.mission.id);
        if (next >= 0) setCursor(next);
        const now = view.items[next];
        // Passing a mission of another priority takes its priority: say so, never change it silently.
        if (now && now.priority !== item.priority) {
          showFlash(`Now ${priorityLabel(now.priority)} priority, ${direction === 'up' ? 'above' : 'below'} “${neighbour.summary.mission.title}”.`);
        }
      },
    });
  }, [items, update, setCursor]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!event.altKey || event.metaKey || event.ctrlKey || isTypingTarget(event.target)) return;
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
      event.preventDefault();
      move(cursor, event.key === 'ArrowUp' ? 'up' : 'down');
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [cursor, move]);

  const change = (item: BacklogItemView, body: UpdateMissionRequest): void => {
    update.mutate({ id: item.summary.mission.id, body }, { onSuccess: applied });
  };

  if (backlog.isError) return <ErrorState error={backlog.error} onRetry={() => void backlog.refetch()} />;
  if (backlog.isPending || backlog.data === undefined) return <SkeletonList rows={4} />;
  const view = backlog.data;
  const limitValue = view.limit === null ? 'off' : String(view.limit);
  const limitOptions = [...new Set<string>([...LIMIT_OPTIONS, limitValue])]
    .sort((a, b) => (a === 'off' ? -1 : b === 'off' ? 1 : Number(a) - Number(b)))
    .map((value) => ({ value, label: value === 'off' ? 'Off' : value }));

  return (
    <div className="stack" style={{ gap: 'var(--s4)' }}>
      <section aria-label="Work in progress" className="card">
        <div className="row row--wrap" style={{ justifyContent: 'space-between', gap: 'var(--s4)' }}>
          <div style={{ minWidth: 0 }}>
            <div className="list__title">{view.headline}</div>
            <p className="dim" style={{ fontSize: 'var(--fs-sm)', marginTop: 'var(--s1)' }}>{view.hint}</p>
          </div>
          <div className="row" style={{ gap: 'var(--s2)' }}>
            <span className="muted" style={{ fontSize: 'var(--fs-sm)' }}>Work on at most</span>
            <Segmented
              value={limitValue}
              options={limitOptions}
              onChange={(next) => setLimit.mutate(next === 'off' ? null : Number(next))}
            />
          </div>
        </div>
        {setLimit.isError ? <ErrorState error={setLimit.error} /> : null}
      </section>

      {update.isError ? <ErrorState error={update.error} /> : null}

      {items.length === 0 ? (
        <div className="card">
          <Empty
            icon="flag"
            title="The backlog is empty"
            body="Drafts wait here until they are planned. Use “Add to backlog” on a new mission to queue it; with a limit set, Tandemise plans the next queued mission that is ready whenever there is room."
            action={
              <Link href="/missions/new" className="btn btn--primary">
                <Icon name="plus" size={14} />
                New mission
              </Link>
            }
          />
        </div>
      ) : (
        <>
          <section aria-label="Backlog" className="list">
            {items.map((item, index) => (
              <BacklogRow
                key={item.summary.mission.id}
                item={item}
                queued={view.queued}
                active={index === cursor}
                first={index === 0}
                last={index === items.length - 1}
                busy={update.isPending}
                onSelect={() => setCursor(index)}
                onMove={(direction) => move(index, direction)}
                onChange={(body) => change(item, body)}
              />
            ))}
          </section>
          <p className="dim" style={{ fontSize: 'var(--fs-xs)' }}>
            {pluralize(items.length, 'draft')} · <kbd>j</kbd> <kbd>k</kbd> to select, <kbd>⌥↑</kbd> <kbd>⌥↓</kbd> to move, <kbd>↵</kbd> to open
          </p>
        </>
      )}
    </div>
  );
}

function BacklogRow({
  item, queued, active, first, last, busy, onSelect, onMove, onChange,
}: {
  item: BacklogItemView;
  queued: number;
  active: boolean;
  first: boolean;
  last: boolean;
  busy: boolean;
  onSelect: () => void;
  onMove: (direction: 'up' | 'down') => void;
  onChange: (body: UpdateMissionRequest) => void;
}): JSX.Element {
  const { mission } = item.summary;
  const readiness = item.refining ? 'Refining…' : item.ready ? mission.goal : item.readinessLabel;
  return (
    <div className="list__row" data-active={active} aria-label={mission.title} onClick={onSelect}>
      <PriorityChip priority={item.priority} />
      <div className="list__main">
        <div className="list__title truncate">
          <Link href={`/missions/${mission.id}`}>{mission.title}</Link>
        </div>
        <div className="list__subtitle truncate" title={readiness}>{readiness}</div>
      </div>
      <div className="list__aside">
        <span className={`badge badge--${item.ready ? 'succeeded' : 'blocked'}`}>
          <span className={`dot dot--${item.ready ? 'succeeded' : 'blocked'}`} />
          {item.ready ? 'Ready' : 'Needs refinement'}
        </span>
        <span className={item.queuePosition === null ? 'dim' : 'muted'} style={{ fontSize: 'var(--fs-xs)', minWidth: 80, textAlign: 'right' }}>
          {item.queuePosition === null ? 'Not queued' : `Queued · ${item.queuePosition}/${queued}`}
        </span>
        <select
          className="select"
          style={{ width: 104 }}
          aria-label={`Priority of ${mission.title}`}
          value={item.priority}
          disabled={busy}
          onChange={(event) => onChange({ priority: event.target.value as MissionPriority })}
        >
          {MISSION_PRIORITIES.map((priority) => (
            <option key={priority} value={priority}>{priorityLabel(priority)}</option>
          ))}
        </select>
        <button type="button" className="btn btn--ghost" disabled={busy} onClick={() => onChange({ queued: item.queuePosition === null })}>
          {item.queuePosition === null ? 'Add to queue' : 'Remove from queue'}
        </button>
        <button type="button" className="btn btn--ghost btn--icon" aria-label="Move up" title="Move up (⌥↑)" disabled={first || busy} onClick={() => onMove('up')}>
          <Icon name="arrowUp" size={14} />
        </button>
        <button type="button" className="btn btn--ghost btn--icon" aria-label="Move down" title="Move down (⌥↓)" disabled={last || busy} onClick={() => onMove('down')}>
          <Icon name="arrowDown" size={14} />
        </button>
      </div>
    </div>
  );
}

/** Urgent and high stand out; normal and low stay quiet. */
function PriorityChip({ priority }: { priority: MissionPriority }): JSX.Element {
  const label = priorityLabel(priority);
  if (priority === 'urgent') return <span className="badge badge--failed" style={{ minWidth: 64, justifyContent: 'center' }}>{label}</span>;
  if (priority === 'high') return <span className="badge badge--blocked" style={{ minWidth: 64, justifyContent: 'center' }}>{label}</span>;
  return <span className="chip chip--muted" style={{ minWidth: 64, justifyContent: 'center' }}>{label}</span>;
}
