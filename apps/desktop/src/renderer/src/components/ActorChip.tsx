import type { ActorRef, TaskView } from '@tandemise/api-contract';
import { Icon } from './Icon.js';
import { actorLabel, actorsLine, type Actors } from '../lib/team.js';

/**
 * Who, in one glance: a name with a hint of what kind of actor it is.
 *
 * People get no icon - a name already reads as a person - so the icon only
 * appears where it tells you something: that a model or the system did it.
 */
export function ActorChip({ actor, meId, prefix }: { actor: ActorRef | null; meId: string | null; prefix?: string }): JSX.Element | null {
  if (!actor) return null;
  return (
    <span className="actor" data-kind={actor.kind} title={actor.kind === 'agent' ? `${actor.name} (agent)` : actor.name}>
      {prefix ? <span className="actor__prefix">{prefix}</span> : null}
      {actor.kind === 'agent' ? <Icon name="sparkle" size={11} /> : actor.kind === 'system' ? <Icon name="runtimes" size={11} /> : null}
      <span className="actor__name">{actorLabel(actor, meId)}</span>
    </span>
  );
}

/**
 * "by X · responsible Y · recorded by Z", saying only what is new: the
 * responsible person is left out when they did the work themselves, and the
 * recorder only appears when someone entered it for someone else.
 */
export function Attribution({
  by,
  responsible,
  recordedBy,
  meId,
}: {
  by: ActorRef | null;
  responsible: ActorRef | null;
  recordedBy?: ActorRef | null;
  meId: string | null;
}): JSX.Element | null {
  const showResponsible = responsible !== null && responsible.id !== by?.id;
  const showRecorder = recordedBy !== null && recordedBy !== undefined && recordedBy.id !== by?.id && recordedBy.kind === 'person';
  if (!by && !showResponsible) return null;
  return (
    <span className="attribution">
      {by ? <ActorChip actor={by} meId={meId} prefix="by" /> : null}
      {showResponsible ? (
        <>
          {by ? <span className="sep">·</span> : null}
          <ActorChip actor={responsible} meId={meId} prefix="responsible" />
        </>
      ) : null}
      {showRecorder ? (
        <>
          <span className="sep">·</span>
          <ActorChip actor={recordedBy} meId={meId} prefix="recorded by" />
        </>
      ) : null}
    </span>
  );
}

/**
 * Whose name a decision goes on. Only rendered when there is someone else it
 * could be: a solo workspace never sees it, and "me" is always the default.
 */
export function RecordingFor({
  actors,
  value,
  onChange,
  label = 'Recording for',
  eligible,
}: {
  actors: Actors;
  value: string | null;
  onChange: (memberId: string) => void;
  label?: string;
  /** Who this may be recorded for. Absent: anyone on the team. */
  eligible?: readonly string[];
}): JSX.Element | null {
  if (actors.solo || actors.meId === null) return null;
  const people = eligible === undefined ? actors.people : actors.people.filter((p) => eligible.includes(p.id));
  const meEligible = people.some((p) => p.id === actors.meId);
  return (
    <label className="recordfor">
      <span className="recordfor__label">{label}</span>
      <select
        className="select recordfor__select"
        value={value ?? (meEligible ? actors.meId : people[0]?.id ?? '')}
        onChange={(event) => onChange(event.target.value)}
      >
        {people.map((person) => (
          <option key={person.id} value={person.id}>
            {person.id === actors.meId ? `${person.name} (you)` : person.name}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * Who a human task can be claimed or completed for: its assignee, or while
 * nobody has it, whoever may claim it. Null for a task staffing never named
 * anyone (resolved before staffing existed), which anyone may take.
 */
export function eligibleFor(task: Pick<TaskView, 'assignee' | 'claimable' | 'escalatedTo'>): readonly string[] | null {
  if (task.assignee) {
    if (task.assignee.kind !== 'person') return null;
    // An unanswered pool was opened to more people: they may take it from its assignee, as the daemon allows.
    return [task.assignee.id, ...task.escalatedTo.map((a) => a.id).filter((id) => id !== task.assignee?.id)];
  }
  return task.claimable.length > 0 ? task.claimable.map((c) => c.id) : null;
}

/** An assigned task whose pool escalated, so the people it was opened to may take it from its assignee. */
export function escalatedPastAssignee(task: Pick<TaskView, 'assignee' | 'escalatedTo'>): boolean {
  return task.assignee !== null && task.escalatedTo.some((a) => a.id !== task.assignee?.id);
}

/**
 * Me when I am eligible, otherwise the first eligible person the select shows.
 * Never an id that is not offered, and nothing at all without a principal:
 * the picker is hidden then, and a hidden default must not become an
 * `onBehalfOf` nobody chose.
 */
export function defaultRecordFor(actors: Actors, eligible: readonly string[] | null): string | null {
  if (actors.meId === null) return null;
  if (eligible === null || eligible.includes(actors.meId)) return actors.meId;
  return actors.people.find((p) => eligible.includes(p.id))?.id ?? null;
}

/** The `onBehalfOf` to send: nothing when recording for yourself. */
export function behalfOf(actors: Actors, value: string | null): { onBehalfOf?: string } {
  return value !== null && value !== actors.meId ? { onBehalfOf: value } : {};
}

/**
 * "Done by X · Responsible Y" in one line. The responsible person is left out
 * when they are doing the work themselves, since the line would repeat them.
 */
export function TaskPeople({ task, actors }: { task: TaskView; actors: Actors }): JSX.Element | null {
  // Not decided yet: who is lined up, said more quietly than a decided answer.
  if (task.wouldBe && !task.assignee) {
    const would = task.wouldBe;
    const pool = would.assignee === null && would.claimable.length > 0;
    return (
      <div className="taskcard__people taskcard__people--would">
        {pool ? (
          <span className="actor">
            <span className="actor__prefix">Would go to</span>
            <span className="actor__name">{actorsLine(would.claimable, actors.meId, { you: 'You' })}</span>
          </span>
        ) : would.assignee ? (
          <ActorChip actor={would.assignee} meId={actors.meId} prefix="Would go to" />
        ) : (
          <span className="actor">
            <span className="actor__prefix">Would go to any runtime</span>
          </span>
        )}
        {would.responsible.id !== would.assignee?.id ? (
          <>
            <span className="sep">·</span>
            <ActorChip actor={would.responsible} meId={actors.meId} prefix="Responsible" />
          </>
        ) : null}
      </div>
    );
  }
  const by = task.assignee ?? (task.runtimeName ? { id: 'system:runtime', name: task.runtimeName, kind: 'system' as const } : null);
  const pool = task.assignee === null && task.claimable.length > 0 && task.status === 'AWAITING_HUMAN';
  if (!by && !task.responsible && !pool) return null;
  return (
    <div className="taskcard__people">
      {pool ? (
        <span className="actor">
          <span className="actor__prefix">Up for grabs</span>
        </span>
      ) : by ? (
        <ActorChip actor={by} meId={actors.meId} prefix="Done by" />
      ) : null}
      {task.responsible && task.responsible.id !== by?.id ? (
        <>
          <span className="sep">·</span>
          <ActorChip actor={task.responsible} meId={actors.meId} prefix="Responsible" />
        </>
      ) : null}
    </div>
  );
}
