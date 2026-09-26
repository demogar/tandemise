import { useState } from 'react';
import type { MissionPriority, Routine, RoutineKind, RoutineSchedule, RoutineTemplate } from '@tandemise/domain';
import type { CreateRoutineRequest, RoutineView } from '@tandemise/api-contract';
import { Modal } from '../../components/Modal.js';
import { ErrorState, Field, Segmented } from '../../components/primitives.js';
import { LimitFields, limitDraft, limitsFromDraft } from '../../components/LimitFields.js';
import { useDaemonMutation, useWorkflows } from '../../lib/queries.js';
import { useWorkspaceId } from '../../lib/workspace.js';
import { MISSION_PRIORITIES, ROUTINE_HOURS, ROUTINE_TEMPLATES, WEEKDAY_OPTIONS, priorityLabel } from '../../lib/domain.js';

type Repeats = RoutineSchedule['type'];

interface Draft {
  readonly name: string;
  readonly kind: RoutineKind;
  readonly goal: string;
  readonly criteria: string;
  readonly priority: MissionPriority;
  readonly workflowPreset: string;
  readonly repeats: Repeats;
  readonly at: string;
  readonly day: number;
  readonly every: number;
}

const BLANK: Draft = {
  name: '', kind: 'mission', goal: '', criteria: '', priority: 'normal', workflowPreset: '',
  repeats: 'daily', at: '09:00', day: 1, every: 6,
};

function fromSchedule(schedule: RoutineSchedule): Pick<Draft, 'repeats' | 'at' | 'day' | 'every'> {
  switch (schedule.type) {
    case 'daily': return { repeats: 'daily', at: schedule.at, day: BLANK.day, every: BLANK.every };
    case 'weekly': return { repeats: 'weekly', at: schedule.at, day: schedule.day, every: BLANK.every };
    case 'hourly': return { repeats: 'hourly', at: BLANK.at, day: BLANK.day, every: schedule.every };
  }
}

function fromTemplate(template: RoutineTemplate): Draft {
  return {
    ...BLANK,
    name: template.name,
    kind: template.kind,
    goal: template.goal,
    criteria: template.successCriteria.join('\n'),
    priority: template.priority,
    ...fromSchedule(template.schedule),
  };
}

function fromRoutine(routine: Routine): Draft {
  return {
    name: routine.name,
    kind: routine.kind,
    goal: routine.goal,
    criteria: routine.successCriteria.join('\n'),
    priority: routine.priority,
    workflowPreset: routine.workflowPreset ?? '',
    ...fromSchedule(routine.schedule),
  };
}

function scheduleOf(draft: Draft): RoutineSchedule {
  if (draft.repeats === 'hourly') return { type: 'hourly', every: draft.every };
  if (draft.repeats === 'weekly') return { type: 'weekly', day: draft.day, at: draft.at };
  return { type: 'daily', at: draft.at };
}

const REPEATS: readonly { value: Repeats; label: string }[] = [
  { value: 'daily', label: 'Every day' },
  { value: 'weekly', label: 'Every week' },
  { value: 'hourly', label: 'Every few hours' },
];

const KINDS: readonly { value: RoutineKind; label: string }[] = [
  { value: 'mission', label: 'Adds a mission' },
  { value: 'status_report', label: 'Writes a status report' },
];

/**
 * New routine / Edit routine (P11 spec §5).
 *
 * The three starters come first because most standing work is one of them;
 * each fills every field, and everything stays editable. Schedules are presets
 * only - a day, a week, or every few hours - so nobody has to read cron.
 */
export function RoutineDialog({ editing, onClose }: { editing: RoutineView | null; onClose: () => void }): JSX.Element {
  const workspaceId = useWorkspaceId();
  const workflows = useWorkflows();
  const [draft, setDraft] = useState<Draft>(() => (editing === null ? BLANK : fromRoutine(editing.routine)));
  const [limits, setLimits] = useState(() => limitDraft(editing?.routine.limits ?? []));
  const [problem, setProblem] = useState<string | null>(null);
  const set = (patch: Partial<Draft>): void => setDraft((current) => ({ ...current, ...patch }));

  const save = useDaemonMutation(
    (daemon, body: CreateRoutineRequest) => (editing === null
      ? daemon.createRoutine(workspaceId ?? '', body)
      : daemon.updateRoutine(editing.routine.id, body)),
    ['missions'],
  );

  const submit = (): void => {
    const lines = draft.criteria.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
    if (draft.name.trim().length === 0) return setProblem('Give the routine a name.');
    if (draft.kind === 'mission' && draft.goal.trim().length < 3) return setProblem('Say what each mission should do.');
    if (draft.kind === 'mission' && lines.length === 0) {
      return setProblem('Add at least one Done-when line, so every mission this routine adds is ready to plan.');
    }
    const parsed = limitsFromDraft(limits);
    if (parsed.error !== null) return setProblem(parsed.error);
    setProblem(null);
    save.mutate({
      name: draft.name.trim(),
      kind: draft.kind,
      goal: draft.goal.trim(),
      successCriteria: lines,
      priority: draft.priority,
      limits: parsed.limits.length === 0 ? null : parsed.limits,
      workflowPreset: draft.workflowPreset === '' ? null : draft.workflowPreset,
      schedule: scheduleOf(draft),
    }, { onSuccess: onClose });
  };

  const title = editing === null ? 'New routine' : 'Edit routine';
  return (
    <Modal
      title={title}
      wide
      onClose={onClose}
      footer={
        <>
          <span className="dim" style={{ flex: 1, fontSize: 'var(--fs-xs)' }}>
            {draft.kind === 'mission'
              ? 'Each run adds a queued mission to the backlog. It is planned when there is room under your work-in-progress limit.'
              : 'Each run writes the next version of the project’s status report.'}
          </span>
          <button type="button" className="btn btn--ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn--primary" disabled={save.isPending} onClick={submit}>
            {save.isPending ? 'Saving…' : editing === null ? 'Create routine' : 'Save routine'}
          </button>
        </>
      }
    >
      <div className="stack" style={{ gap: 'var(--s4)' }}>
        {editing === null ? (
          <section aria-label="Starter templates" className="stack" style={{ gap: 'var(--s2)' }}>
            <span className="field__label">Start from</span>
            <div className="grid grid--3">
              {ROUTINE_TEMPLATES.map((template) => (
                <button
                  key={template.key}
                  type="button"
                  className="btn"
                  aria-pressed={draft.name === template.name}
                  title={template.description}
                  onClick={() => { setDraft(fromTemplate(template)); setLimits(limitDraft([])); setProblem(null); }}
                >
                  {template.name}
                </button>
              ))}
            </div>
          </section>
        ) : null}

        <div className="grid grid--2">
          <Field label="Name" hint="Each mission it adds is called this, with the day of the run.">
            <input className="input" value={draft.name} data-autofocus onChange={(event) => set({ name: event.target.value })} />
          </Field>
          <Field label="What it does">
            <Segmented value={draft.kind} options={KINDS} onChange={(kind) => set({ kind })} />
          </Field>
        </div>

        {draft.kind === 'mission' ? (
          <>
            <Field label="Goal" hint="What each mission should do. {date} becomes the day of the run.">
              <textarea className="textarea" rows={3} value={draft.goal} onChange={(event) => set({ goal: event.target.value })} />
            </Field>
            <Field
              label="Done when (one per line)"
              hint="At least one line. Each becomes U1, U2… on every mission, so it is ready to plan without refinement."
            >
              <textarea className="textarea" rows={4} value={draft.criteria} onChange={(event) => set({ criteria: event.target.value })} />
            </Field>
          </>
        ) : (
          <p className="muted" style={{ fontSize: 'var(--fs-sm)' }}>
            Writes the project’s status report from facts, the same one as Home’s “Status report” button: every mission in
            progress with its criteria verified, open decisions, and this month’s usage against the limit. No agent runs, so it
            is written even when the monthly limit is reached.
          </p>
        )}

        <Field label="Repeats" hint="The daemon’s local time.">
          <div className="row row--wrap" style={{ gap: 'var(--s3)' }}>
            <Segmented value={draft.repeats} options={REPEATS} onChange={(repeats) => set({ repeats })} />
            {draft.repeats === 'weekly' ? (
              <select className="select" style={{ width: 140 }} aria-label="Day" value={draft.day} onChange={(event) => set({ day: Number(event.target.value) })}>
                {WEEKDAY_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            ) : null}
            {draft.repeats === 'hourly' ? (
              <select className="select" style={{ width: 140 }} aria-label="Every" value={draft.every} onChange={(event) => set({ every: Number(event.target.value) })}>
                {ROUTINE_HOURS.map((hours) => <option key={hours} value={hours}>{hours === 1 ? 'Every hour' : `Every ${hours} hours`}</option>)}
              </select>
            ) : (
              <input className="input" type="time" style={{ width: 120 }} aria-label="Time" value={draft.at} onChange={(event) => set({ at: event.target.value })} />
            )}
          </div>
        </Field>

        {draft.kind === 'mission' ? (
          <>
            <div className="grid grid--2">
              <Field label="Priority" hint="Where each mission lands in the backlog.">
                <Segmented
                  value={draft.priority}
                  options={MISSION_PRIORITIES.map((value) => ({ value, label: priorityLabel(value) }))}
                  onChange={(priority) => set({ priority })}
                />
              </Field>
              <Field label="Workflow" hint="How each mission is broken into tasks.">
                <select className="select" value={draft.workflowPreset} onChange={(event) => set({ workflowPreset: event.target.value })}>
                  <option value="">Default workflow</option>
                  {(workflows.data ?? []).map((option) => (
                    <option key={option.id} value={option.id}>{option.name}{option.path === null ? '' : '  ·  yours'}</option>
                  ))}
                </select>
              </Field>
            </div>
            <LimitFields draft={limits} onChange={setLimits} suffix="for each mission" />
            <p className="dim" style={{ fontSize: 'var(--fs-xs)', marginTop: 'calc(var(--s2) * -1)' }}>
              Blank limits use the project’s default mission limits. A run is skipped while the project is at its monthly limit.
            </p>
          </>
        ) : null}

        {problem !== null ? <div className="banner banner--warn" role="alert">{problem}</div> : null}
        {save.isError ? <ErrorState error={save.error} /> : null}
      </div>
    </Modal>
  );
}
