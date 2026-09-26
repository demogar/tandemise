import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'wouter';
import type { AutonomyLevel, MissionPriority, RoleTemplate, StaffingPatch } from '@tandemise/domain';
import type { StaffingPreset } from '@tandemise/domain/staffing-presets';
import { Drawer } from '../components/Modal.js';
import { RecordingFor, behalfOf } from '../components/ActorChip.js';
import type { RoleStaffingPatchRequest } from '@tandemise/api-contract';
import { useActors, type Actors } from '../lib/team.js';
import { PRESET_LABELS, STAFFING_PRESET_OPTIONS, staffingSummary, toWire } from '../lib/staffing.js';
import { StaffingEditor, applyPreset, needsPick, presetOf } from './team/StaffingEditor.js';
import { PageHeader } from '../components/PageHeader.js';
import { Icon } from '../components/Icon.js';
import { ErrorState, Field, Segmented } from '../components/primitives.js';
import { useDaemonMutation, useRoles, useStaffing, useWorkflows } from '../lib/queries.js';
import { useWorkspace } from '../lib/workspace.js';
import { useHotkey } from '../lib/keyboard.js';
import { shortenPath, titleCase } from '../lib/format.js';
import { MISSION_PRIORITIES, priorityLabel } from '../lib/domain.js';
import { showFlash } from '../lib/notices.js';

const AUTONOMY: readonly { value: AutonomyLevel; label: string; hint: string }[] = [
  { value: 'supervised', label: 'Supervised', hint: 'Approve the plan and every action that leaves this machine.' },
  { value: 'balanced', label: 'Balanced', hint: 'Local work runs freely; external writes and releases still ask.' },
  { value: 'autonomous', label: 'Autonomous', hint: 'Only releases and financial actions stop for a human.' },
];

/**
 * The product's front door (MVP.md §23.2).
 *
 * Everything except the sentence is optional and folded away, because the
 * promise is that one sentence plus ⌘↵ is enough. The disclosure exists for the
 * second mission, not the first.
 */
export function NewMission(): JSX.Element {
  const [, navigate] = useLocation();
  const workspace = useWorkspace().current;
  const workflows = useWorkflows();

  const [goal, setGoal] = useState('');
  const [repositoryId, setRepositoryId] = useState<string>('');
  const [preset, setPreset] = useState('feature-delivery');
  const [workflowInputs, setWorkflowInputs] = useState<Record<string, string>>({});

  const chosen = (workflows.data ?? []).find((w) => w.id === preset) ?? null;
  const missingInput = (chosen?.inputs ?? []).find(
    (input) => input.required && (workflowInputs[input.name] ?? '').trim() === '',
  );
  const [autonomy, setAutonomy] = useState<AutonomyLevel>('balanced');
  const [constraints, setConstraints] = useState('');
  const [criteria, setCriteria] = useState('');
  const [title, setTitle] = useState('');
  const [baseBranch, setBaseBranch] = useState('');
  const [priority, setPriority] = useState<MissionPriority>('normal');
  const [showMore, setShowMore] = useState(false);
  const [showStaffing, setShowStaffing] = useState(false);
  const [staffing, setStaffing] = useState<Record<string, StaffingPatch>>({});
  const actors = useActors();
  const [createdFor, setCreatedFor] = useState<string | null>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    textarea.current?.focus();
  }, []);

  useEffect(() => {
    if (!repositoryId && workspace) {
      setRepositoryId(workspace.workspace.defaultRepositoryId ?? workspace.repositories[0]?.id ?? '');
    }
  }, [workspace, repositoryId]);

  // Staffing travels in the create request: the daemon stores it with the
  // mission before planning starts, so no task can become ready without it.
  const create = useDaemonMutation(
    (daemon, args: Parameters<typeof daemon.createMission>[0]) => daemon.createMission(args),
    ['missions'],
  );

  // A workflow that declares a required input cannot start without it, and
  // the button says so rather than failing after the click.
  const ready = goal.trim().length >= 3 && Boolean(workspace) && missingInput === undefined;
  // A request is planned only once it says what done means. Without a line it
  // is created as a draft and opened on "Get it ready", where the product
  // agent proposes criteria and asks what it needs (P6).
  const hasCriteria = splitLines(criteria).length > 0;

  // "Add to backlog" queues the mission instead of planning it: it is planned,
  // in priority order, once it is ready and the project has room (P7).
  const submit = (mode: 'now' | 'backlog' = 'now'): void => {
    if (!ready || !workspace || create.isPending) return;
    const toBacklog = mode === 'backlog';
    create.mutate(
      {
        workspaceId: workspace.workspace.id,
        repositoryId: repositoryId || null,
        goal: goal.trim(),
        ...(title.trim() ? { title: title.trim() } : {}),
        constraints: splitLines(constraints),
        successCriteria: splitLines(criteria),
        autonomy,
        workflowPreset: preset,
        workflowInputs,
        baseBranch: baseBranch.trim() || null,
        planNow: hasCriteria && !toBacklog,
        ...(toBacklog ? { queued: true } : {}),
        ...(priority === 'normal' ? {} : { priority }),
        ...behalfOf(actors, createdFor),
        ...(Object.keys(staffing).length > 0
          ? { staffing: Object.fromEntries(Object.entries(staffing).map(([role, patch]) => [role, toWire(patch)])) as RoleStaffingPatchRequest }
          : {}),
      },
      {
        onSuccess: (detail) => {
          if (toBacklog) showFlash('Added to the backlog.');
          navigate(`/missions/${detail.mission.id}`);
        },
      },
    );
  };

  useHotkey('mod+enter', () => submit(), { whileTyping: true });
  useHotkey('escape', () => navigate('/missions'), { whileTyping: true });

  return (
    <>
      <PageHeader
        narrow
        title="New mission"
        crumbs={[{ label: 'Missions', href: '/missions' }, { label: 'New' }]}
        subtitle="Describe the outcome. Tandemise proposes the plan before anything runs."
        actions={
          <>
            <button type="button" className="btn btn--ghost" onClick={() => navigate('/missions')}>
              Cancel
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => submit('backlog')}
              disabled={!ready || create.isPending}
              title="Queue it: Tandemise plans it when it is ready and there is room under the project's limit."
            >
              Add to backlog
            </button>
            <button type="button" className="btn btn--primary" onClick={() => submit()} disabled={!ready || create.isPending}>
              {create.isPending ? (hasCriteria ? 'Planning…' : 'Creating…') : hasCriteria ? 'Plan mission' : 'Create and refine'}
              <kbd style={{ marginLeft: 2 }}>⌘↵</kbd>
            </button>
          </>
        }
      />

      <div className="page">
        <div className="page__inner page__inner--narrow">
          <div className="stack" style={{ gap: 'var(--s5)' }}>
            <Field
              label="What outcome do you want?"
              hint="One sentence is enough. Be concrete about the result, not the steps — the planner decides those."
            >
              <textarea
                ref={textarea}
                className="textarea textarea--hero"
                placeholder="Add passkey sign-in to the web app, keeping the existing password flow working for anyone who has not enrolled."
                value={goal}
                onChange={(event) => setGoal(event.target.value)}
              />
            </Field>

            <div className="grid grid--2">
              <Field label="Repository" hint={selectedRepositoryPath(workspace ?? undefined, repositoryId)}>
                <select className="select" value={repositoryId} onChange={(event) => setRepositoryId(event.target.value)}>
                  <option value="">No repository (research only)</option>
                  {(workspace?.repositories ?? []).map((repository) => (
                    <option key={repository.id} value={repository.id}>
                      {repository.name}
                    </option>
                  ))}
                </select>
              </Field>

              <Field
                label="Workflow"
                hint={chosen?.description ?? (workflows.isPending ? 'Loading…' : 'How this mission will be broken into tasks.')}
              >
                <select className="select" value={preset} onChange={(event) => setPreset(event.target.value)}>
                  {(workflows.data ?? []).map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.name}
                      {option.path === null ? '' : '  ·  yours'}
                    </option>
                  ))}
                </select>
              </Field>
            </div>

            {chosen !== null && chosen.issues.length > 0 ? (
              <div className="banner banner--warn">
                <Icon name="alert" size={14} />
                <span>
                  This workflow cannot run yet — {chosen.issues[0]?.path}: {chosen.issues[0]?.message}
                  {chosen.path ? ` (${chosen.path})` : ''}
                </span>
              </div>
            ) : null}

            {/* A workflow the team wrote can declare what it needs — an issue
                number, a ticket id. Collected here rather than parsed out of the
                sentence, so the workflow author decides what it takes. */}
            {(chosen?.inputs ?? []).map((input) => (
              <Field
                key={input.name}
                label={titleCase(input.name)}
                hint={input.description ?? (input.required ? 'Required by this workflow.' : 'Optional.')}
              >
                <input
                  className="input"
                  value={workflowInputs[input.name] ?? ''}
                  onChange={(event) =>
                    setWorkflowInputs((current) => ({ ...current, [input.name]: event.target.value }))
                  }
                  placeholder={input.name === 'issue' ? '42' : ''}
                />
              </Field>
            ))}

            {/* What this will actually do, before it does it. A step someone has
                to carry out themselves is called out, because that is the part a
                person needs to know is coming. */}
            {chosen !== null && chosen.steps.length > 0 ? (
              <Field label="Steps">
                <div className="row row--wrap" style={{ gap: 4 }}>
                  {chosen.steps.map((step) => (
                    <span key={step.key} className={step.executor === 'human' ? 'chip chip--you' : 'chip chip--muted'}>
                      {step.executor === 'human' ? <Icon name="workforce" size={10} /> : null}
                      {step.executor === 'wait' ? <Icon name="clock" size={10} /> : null}
                      {step.title}
                    </span>
                  ))}
                </div>
              </Field>
            ) : null}

            {/* Out in the open, not under "More options": these lines are the
                contract the spec must cover and QA must verify before the
                mission can ship, so they are part of saying what you want. */}
            <Field
              label="Done when (one per line)"
              hint={
                hasCriteria
                  ? 'Each line becomes a numbered criterion (U1, U2, …). The spec must cover every one and QA must verify it before the mission can ship.'
                  : 'Not sure yet? Leave it empty: the product agent will propose criteria and ask what it needs, and you decide before anything is planned.'
              }
            >
              <textarea
                className="textarea"
                value={criteria}
                onChange={(event) => setCriteria(event.target.value)}
                placeholder={'Existing password sign-in still works\nEnrolment is covered by an end-to-end test'}
              />
            </Field>

            <Field label="Autonomy" hint={AUTONOMY.find((option) => option.value === autonomy)?.hint}>
              <Segmented
                block
                value={autonomy}
                onChange={setAutonomy}
                options={AUTONOMY.map((option) => ({ value: option.value, label: option.label }))}
              />
            </Field>

            <div className="disclosure">
              <button
                type="button"
                className="disclosure__toggle"
                aria-expanded={showMore}
                onClick={() => setShowMore((open) => !open)}
              >
                <Icon name="chevronRight" size={13} className="disclosure__chevron" />
                More options
              </button>

              {showMore ? (
                <div className="disclosure__panel">
                  <Field label="Title" hint="Leave blank and the planner names the mission from your sentence.">
                    <input className="input" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Passkey sign-in" />
                  </Field>
                  <Field label="Priority" hint="Orders the backlog and who gets the next free agent. Urgent work is planned first.">
                    <Segmented
                      value={priority}
                      onChange={setPriority}
                      options={MISSION_PRIORITIES.map((value) => ({ value, label: priorityLabel(value) }))}
                    />
                  </Field>
                  <Field label="Constraints" hint="One per line. These become hard rules every role must respect.">
                    <textarea
                      className="textarea"
                      value={constraints}
                      onChange={(event) => setConstraints(event.target.value)}
                      placeholder={'Do not change the public API\nNo new runtime dependencies'}
                    />
                  </Field>
                  {actors.solo ? null : (
                    <Field label="Created for" hint="Plan approvals go to this person.">
                      <div>
                        <RecordingFor actors={actors} value={createdFor} onChange={setCreatedFor} label="" />
                      </div>
                    </Field>
                  )}
                  <Field label="Base branch" hint="Task branches are cut from here. Defaults to the repository's default branch.">
                    <input className="input" value={baseBranch} onChange={(event) => setBaseBranch(event.target.value)} placeholder="main" />
                  </Field>
                </div>
              ) : null}
            </div>

            <div className="disclosure">
              <button
                type="button"
                className="disclosure__toggle"
                aria-expanded={showStaffing}
                onClick={() => setShowStaffing((open) => !open)}
              >
                <Icon name="chevronRight" size={13} className="disclosure__chevron" />
                Staffing for this mission
                {Object.keys(staffing).length > 0 ? <span className="badge badge--accent">{Object.keys(staffing).length} changed</span> : null}
              </button>
              {showStaffing ? (
                <div className="disclosure__panel">
                  <MissionStaffing value={staffing} onChange={setStaffing} actors={actors} />
                </div>
              ) : null}
            </div>

            {!workspace ? (
              <div className="banner banner--warn">
                <Icon name="alert" size={14} />
                No project selected. Create one from the project menu at the top of the sidebar.
              </div>
            ) : null}

            {create.isError ? <ErrorState error={create.error} /> : null}
          </div>
        </div>
      </div>
    </>
  );
}

/** One line per role; only the roles you change are sent, the rest follow the project. */
function MissionStaffing({
  value,
  onChange,
  actors,
}: {
  value: Record<string, StaffingPatch>;
  onChange: (next: Record<string, StaffingPatch>) => void;
  actors: Actors;
}): JSX.Element {
  const roles = useRoles();
  const project = useStaffing().data ?? {};
  const [editing, setEditing] = useState<RoleTemplate | null>(null);
  const [draft, setDraft] = useState<StaffingPatch | null>(null);
  const [startPreset, setStartPreset] = useState<'person' | 'pool' | undefined>(undefined);
  const [startCustom, setStartCustom] = useState(false);
  const set = (roleId: string, patch: StaffingPatch | null): void => {
    const next = { ...value };
    if (patch === null || Object.keys(patch).length === 0) delete next[roleId];
    else next[roleId] = patch;
    onChange(next);
  };

  return (
    <div className="card card--flush">
      {(roles.data ?? []).map((role) => {
        const patch = value[role.id];
        const preset: StaffingPreset | 'inherit' = patch ? presetOf(patch, actors).preset : 'inherit';
        return (
          <div key={role.id} className="list__row staffrow" style={{ gridTemplateColumns: 'minmax(96px, 130px) minmax(160px, 210px) 1fr' }}>
            <div className="list__title">{role.name}</div>
            <select
              className="select"
              aria-label={`${role.name} staffing`}
              value={preset}
              onChange={(event) => {
                const next = event.target.value;
                if (next === 'inherit') set(role.id, null);
                else if (next === 'custom') {
                  setStartPreset(undefined);
                  setStartCustom(true);
                  setDraft(patch ?? { ...(project[role.id] ?? {}) });
                  setEditing(role);
                } else {
                  const applied = applyPreset(next as Exclude<StaffingPreset, 'custom'>, patch ?? project[role.id] ?? {}, role.id, actors);
                  if (needsPick(next, applied)) {
                    // Nobody holds the role: pick someone before it counts.
                    setStartPreset(next);
                    setStartCustom(false);
                    setDraft(applied);
                    setEditing(role);
                  } else set(role.id, applied);
                }
              }}
            >
              <option value="inherit">Same as the project</option>
              {STAFFING_PRESET_OPTIONS.map((p) => (
                <option key={p} value={p}>
                  {PRESET_LABELS[p]}
                </option>
              ))}
            </select>
            <span className={patch ? 'muted truncate' : 'dim truncate'} style={{ fontSize: 'var(--fs-sm)' }}>
              {staffingSummary(patch ?? project[role.id] ?? {}, role.id, actors)}
            </span>
          </div>
        );
      })}
      {editing ? (
        <Drawer
          title={`${editing.name} staffing`}
          subtitle="For this mission only."
          onClose={() => setEditing(null)}
          footer={
            <>
              <button type="button" className="btn btn--ghost" onClick={() => setEditing(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => {
                  set(editing.id, draft);
                  setEditing(null);
                }}
              >
                Use this
              </button>
            </>
          }
        >
          <StaffingEditor roleId={editing.id} value={draft} onChange={setDraft} actors={actors} level="mission" inherited={project[editing.id]} startPreset={startPreset} startCustom={startCustom} />
        </Drawer>
      ) : null}
    </div>
  );
}

function splitLines(value: string): string[] {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function selectedRepositoryPath(
  workspace: { repositories: readonly { id: string; path: string }[] } | undefined,
  repositoryId: string,
): string | undefined {
  const repository = workspace?.repositories.find((candidate) => candidate.id === repositoryId);
  return repository ? shortenPath(repository.path, 3) : 'Work happens in an isolated worktree, never your checkout.';
}
