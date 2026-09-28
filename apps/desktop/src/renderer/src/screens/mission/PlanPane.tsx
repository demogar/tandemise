import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { MissionDetail, TaskView } from '@tandemise/api-contract';
import type { Approval } from '@tandemise/domain';
import { TaskPeople } from '../../components/ActorChip.js';
import { useActors, type Actors } from '../../lib/team.js';
import { Icon } from '../../components/Icon.js';
import { Empty, IdChip } from '../../components/primitives.js';
import { TaskDetail } from './TaskDetail.js';
import { duration, pluralize, taskBadge, taskTone } from '../../lib/format.js';

interface Edge {
  readonly id: string;
  readonly path: string;
  readonly active: boolean;
}

/**
 * The plan, laid out as columns by `TaskView.level`.
 *
 * The daemon already ran `planLevels`, so the UI does no graph work beyond
 * drawing the edges - and it draws them from measured DOM positions rather than
 * a layout library, which keeps the card markup plain and the dependency lines
 * honest about where the cards actually ended up.
 */
export function PlanPane({ detail }: { detail: MissionDetail }): JSX.Element {
  const [selected, setSelected] = useState<string | null>(null);
  const [showPlanId, setShowPlanId] = useState(false);
  const canvas = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const cards = useRef(new Map<string, HTMLElement>());
  const [edges, setEdges] = useState<readonly Edge[]>([]);
  const actors = useActors();
  const approvalsById = useMemo(() => new Map(detail.approvals.map((a) => [a.id as string, a])), [detail.approvals]);
  // A plan wider than the window is normal; without an edge fade the only hint
  // is a scrollbar pinned to the bottom of the pane, which nobody looks at.
  const [overflow, setOverflow] = useState({ start: false, end: false });

  const syncOverflow = useCallback(() => {
    const element = scroller.current;
    if (!element) return;
    const remaining = element.scrollWidth - element.clientWidth - element.scrollLeft;
    setOverflow({ start: element.scrollLeft > 1, end: remaining > 1 });
  }, []);

  const columns = useMemo(() => groupByLevel(detail.tasks), [detail.tasks]);
  const idByKey = useMemo(() => new Map(detail.tasks.map((task) => [task.key, task.id as string])), [detail.tasks]);

  const measure = useCallback(() => {
    const root = canvas.current;
    if (!root) return;
    const origin = root.getBoundingClientRect();
    const next: Edge[] = [];

    for (const task of detail.tasks) {
      const target = cards.current.get(task.id);
      if (!target) continue;
      const targetBox = target.getBoundingClientRect();
      for (const dependency of task.dependsOn) {
        const sourceId = idByKey.get(dependency);
        const source = sourceId ? cards.current.get(sourceId) : undefined;
        if (!source) continue;
        const sourceBox = source.getBoundingClientRect();

        const x1 = sourceBox.right - origin.left;
        const y1 = sourceBox.top + sourceBox.height / 2 - origin.top;
        const x2 = targetBox.left - origin.left;
        const y2 = targetBox.top + targetBox.height / 2 - origin.top;
        const bend = Math.max(24, (x2 - x1) / 2);

        next.push({
          id: `${dependency}->${task.key}`,
          path: `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`,
          active: task.status === 'RUNNING' || task.status === 'READY',
        });
      }
    }
    setEdges(next);
  }, [detail.tasks, idByKey]);

  useLayoutEffect(measure, [measure]);

  useEffect(() => {
    const root = canvas.current;
    const element = scroller.current;
    if (!root || !element) return;
    const observer = new ResizeObserver(() => {
      measure();
      syncOverflow();
    });
    observer.observe(root);
    observer.observe(element);
    return () => observer.disconnect();
  }, [measure, syncOverflow]);

  if (detail.tasks.length === 0) {
    return (
      <div className="page">
        <div className="page__inner">
          <div className="card">
            {detail.planIssues.length > 0 ? (
              <>
                <Empty
                  icon="alert"
                  title="The proposed plan did not validate"
                  body="A plan that fails validation is never partially executed. Re-plan once the issues below are addressed."
                />
                <div className="list" style={{ marginTop: 'var(--s4)' }}>
                  {detail.planIssues.map((issue, index) => (
                    <div key={index} className="list__row">
                      <span className={`dot dot--${issue.severity === 'error' ? 'failed' : 'blocked'}`} />
                      <div className="list__main">
                        <div className="list__title">{issue.message}</div>
                        {issue.taskKey ? <div className="list__subtitle">{issue.taskKey}</div> : null}
                      </div>
                    </div>
                  ))}
                </div>
              </>
            ) : detail.mission.status === 'PLANNING' ? (
              <Empty
                icon="sparkle"
                title="Planning…"
                body="The planner is reading the repositories and shaping a task graph for this goal. It usually takes a minute or two, longer if a runtime is busy; the timeline shows what it is doing. Nothing runs until you have approved the plan."
              />
            ) : (
              <Empty
                icon="sparkle"
                title="No plan yet"
                body="Press Plan in the header and the planning role will propose a task graph. Nothing runs until you have seen it."
              />
            )}
          </div>
        </div>
      </div>
    );
  }

  const selectedTask = detail.tasks.find((task) => task.id === selected) ?? null;
  // The plan is itself an artifact; its id names the exact version approved.
  const planArtifactId = [...detail.artifacts].reverse().find((a) => a.type === 'MissionPlan')?.id ?? null;

  return (
    <>
      {detail.plan?.summary ? (
        <div style={{ padding: 'var(--s4) var(--s7) 0' }}>
          <div className="banner">
            <Icon name="sparkle" size={15} className="dim" />
            <span className="muted">{detail.plan.summary}</span>
            {/* The approved version's id is for bug reports: behind Details, as in the reader and the task drawer. */}
            {planArtifactId ? (
              <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 'var(--s2)', alignItems: 'center' }}>
                <button type="button" className="reader__details-toggle" aria-expanded={showPlanId} onClick={() => setShowPlanId((open) => !open)}>
                  Details
                  <Icon name={showPlanId ? 'chevronUp' : 'chevronDown'} size={11} />
                </button>
                {showPlanId ? <IdChip id={planArtifactId} prefix="plan" /> : null}
              </span>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className="dag" data-overflow-start={overflow.start} data-overflow-end={overflow.end}>
        <div className="dag__scroll" ref={scroller} onScroll={syncOverflow}>
          <div className="dag__canvas" ref={canvas}>
            <svg className="dag__edges" aria-hidden="true">
              {edges.map((edge) => (
                <path key={edge.id} d={edge.path} className={`dag__edge${edge.active ? ' dag__edge--active' : ''}`} />
              ))}
            </svg>

            {columns.map(([level, tasks]) => (
              <div key={level} className="dag__col">
                <div className="dag__colhead">
                  <span>Stage {level + 1}</span>
                  <span style={{ opacity: 0.7 }}>{pluralize(tasks.length, 'task')}</span>
                </div>
                {tasks.map((task) => (
                  <TaskCard
                    key={task.id}
                    task={task}
                    actors={actors}
                    pendingApproval={task.pendingApprovalId ? approvalsById.get(task.pendingApprovalId) : undefined}
                    selected={task.id === selected}
                    onSelect={() => setSelected(task.id)}
                    register={(element) => {
                      if (element) cards.current.set(task.id, element);
                      else cards.current.delete(task.id);
                    }}
                  />
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>

      {selectedTask ? <TaskDetail task={selectedTask} detail={detail} onClose={() => setSelected(null)} /> : null}
    </>
  );
}

function TaskCard({
  task,
  actors,
  pendingApproval,
  selected,
  onSelect,
  register,
}: {
  task: TaskView;
  actors: Actors;
  pendingApproval: Approval | undefined;
  selected: boolean;
  onSelect: () => void;
  register: (element: HTMLElement | null) => void;
}): JSX.Element {
  if (task.coveredBy) {
    // A stage your upload already covers (spec A2): it never runs, so no status dot, no people, no meta; only what covers it.
    return (
      <button type="button" ref={register} className="taskcard taskcard--covered" data-status={task.status} data-selected={selected} onClick={onSelect}>
        <div className="taskcard__title">{task.title} · covered by your upload</div>
        <div className="taskcard__covered-by" title={task.coveredBy.filename}>
          <Icon name="file" size={11} />
          <span className="truncate">{task.coveredBy.filename}</span>
        </div>
      </button>
    );
  }
  const tone = taskTone(task.status);
  const elapsed =
    task.startedAt && task.finishedAt ? Date.parse(task.finishedAt) - Date.parse(task.startedAt) : null;

  return (
    <button type="button" ref={register} className="taskcard" data-status={task.status} data-selected={selected} onClick={onSelect}>
      <div className="taskcard__head">
        <span className={`dot dot--${tone}${task.status === 'RUNNING' ? ' dot--pulse' : ''}`} />
        <span className="taskcard__role">{task.roleName}</span>
        <div className="spacer" />
        <span className={`badge badge--${tone}`} style={{ height: 18 }}>
          {task.status === 'AWAITING_HUMAN' ? humanBadge(task, actors) : taskBadge(task.status)}
        </span>
      </div>

      <div className="taskcard__title">{task.title}</div>
      {/* The key is the plan's name for the task; its raw id is behind Details in the task drawer this card opens. */}
      <div className="taskcard__ids">
        <span className="dim">{task.key}</span>
      </div>

      <TaskPeople task={task} actors={actors} />

      <div className="taskcard__meta">
        {/* Only set when the task works somewhere other than the mission's own
            repository, so a single-repository mission shows nothing. */}
        {task.repositoryName ? (
          <span className="taskcard__repo">
            <Icon name="folder" size={11} /> {task.repositoryName}
          </span>
        ) : null}
        {task.runtimeName ? (
          <span>
            <Icon name="runtimes" size={11} /> {task.runtimeName}
          </span>
        ) : null}
        {task.targetName ? (
          <span>
            <Icon name="branch" size={11} /> {task.targetName}
          </span>
        ) : null}
        {task.attempts > 1 ? <span>attempt {task.attempts}</span> : null}
        {elapsed !== null ? <span>{duration(elapsed)}</span> : null}
      </div>

      {task.checks.length > 0 ? (
        <div className="taskcard__checks">
          {task.checks.map((check) => (
            <span key={check.id} className={`checkpill checkpill--${check.outcome}`} title={check.detail}>
              {check.outcome === 'PASS' ? <Icon name="check" size={10} /> : check.outcome === 'FAIL' ? <Icon name="x" size={10} /> : null}
              {check.name.replace(/^checks\./, '')}
            </span>
          ))}
        </div>
      ) : null}

      {task.status === 'READY' && task.statusReason?.startsWith('Queued') ? (
        <div className="taskcard__gate">
          <Icon name="clock" size={11} />
          <span>{task.statusReason}</span>
        </div>
      ) : null}

      {task.gate ? (
        <div className={`taskcard__gate${task.gate.passed ? '' : ' taskcard__gate--failed'}`}>
          <Icon name={task.gate.passed ? 'shield' : 'alert'} size={11} />
          <span>{task.gate.detail}</span>
        </div>
      ) : null}

      {/* A check is a look after the fact: the task is done and nothing waits on it. */}
      {task.pendingApprovalId && pendingApproval?.kind === 'check' ? (
        <div className="taskcard__note">
          <Icon name="eye" size={11} />
          <span>Check pending</span>
        </div>
      ) : task.pendingApprovalId ? (
        <div className="taskcard__gate taskcard__gate--failed">
          <Icon name="approvals" size={11} />
          <span>{waitingFor(pendingApproval, actors)}</span>
        </div>
      ) : null}

      {task.attention?.kind === 'stale_input' ? (
        // Kept on an older version: worth knowing, not a failure, so it reads like a pending check rather than in red.
        <div className="taskcard__note" title={task.attention.note}>
          <Icon name="info" size={11} />
          <span>Built on an older version of {task.attention.upstream ?? 'its input'}</span>
        </div>
      ) : task.needsAttention ? (
        <div className="taskcard__gate taskcard__gate--failed">
          <Icon name="alert" size={11} />
          <span>Changes requested after the fact</span>
        </div>
      ) : null}

      {task.outputArtifacts.length > 0 ? (
        <div className="taskcard__meta">
          <Icon name="file" size={11} />
          {pluralize(task.outputArtifacts.length, 'artifact')}
        </div>
      ) : null}
    </button>
  );
}

/** "Yours" only when it is: a task parked for Ana is Ana's, and an open pool task is anyone's. */
function humanBadge(task: TaskView, actors: Actors): string {
  const me = actors.meId;
  if (task.assignee) return task.assignee.id === me ? 'Yours' : task.assignee.name;
  if (me !== null && task.claimable.some((c) => c.id === me)) return 'Yours';
  return task.claimable.length > 0 ? 'Open' : 'Yours';
}

function waitingFor(approval: Approval | undefined, actors: Actors): string {
  const addressees = approval?.addressees ?? [];
  if (addressees.length === 0 || (actors.meId !== null && addressees.includes(actors.meId))) return 'Waiting for your approval';
  return `Waiting for ${actors.name(addressees[addressees.length - 1])}`;
}

function groupByLevel(tasks: readonly TaskView[]): readonly (readonly [number, readonly TaskView[]])[] {
  const byLevel = new Map<number, TaskView[]>();
  for (const task of tasks) {
    const bucket = byLevel.get(task.level);
    if (bucket) bucket.push(task);
    else byLevel.set(task.level, [task]);
  }
  return [...byLevel.entries()]
    .sort(([a], [b]) => a - b)
    .map(([level, group]) => [level, [...group].sort((a, b) => a.orderHint - b.orderHint)] as const);
}
