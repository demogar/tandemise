import type { FeedbackView, MissionDetail, TaskView } from '@tandemise/api-contract';
import type { StaffingPatch } from '@tandemise/domain';
import { useQuery } from '@tanstack/react-query';
import { Icon } from '../../components/Icon.js';
import { Modal } from '../../components/Modal.js';
import { ErrorState, IdChip, StatusBadge } from '../../components/primitives.js';
import { ActorChip, RecordingFor, TaskPeople, behalfOf, defaultRecordFor, eligibleFor, escalatedPastAssignee } from '../../components/ActorChip.js';
import { useState } from 'react';
import { useDaemon } from '../../lib/connection.js';
import { useDaemonMutation, useRoles } from '../../lib/queries.js';
import { actorLabel, useActors, type Actors } from '../../lib/team.js';
import { toWire } from '../../lib/staffing.js';
import { StaffingEditor } from '../team/StaffingEditor.js';
import { dateTime, duration, taskTone, titleCase } from '../../lib/format.js';
import { modelLabel, modelPolicyLabel, quietFor } from '../../lib/domain.js';
import { ApprovalCard } from '../approvals/ApprovalCard.js';
import { RequestChangesButton } from '../../components/RequestChanges.js';
import { StartRoundButton } from '../../components/ImpactDialog.js';

export function TaskDetail({ task, detail, onClose }: { task: TaskView; detail: MissionDetail; onClose: () => void }): JSX.Element {
  // A note turns the retry into the next round, framed as a request rather than as the failure it follows.
  const [retryNote, setRetryNote] = useState('');
  const [showIds, setShowIds] = useState(false);
  const retry = useDaemonMutation(
    (daemon) => daemon.retryTask(task.id, retryNote.trim() === '' ? undefined : { note: retryNote.trim() }),
    ['tasks', 'missions', 'approvals'],
    detail.mission.id,
  );
  const canRetry = task.status === 'FAILED' || task.status === 'BLOCKED';
  // A wait step reads nothing, so there is nobody to send a note to; a cancelled mission takes no more rounds.
  const canRequestChanges = task.executor !== 'wait' && detail.mission.status !== 'CANCELLED';

  // What the role allows that this task was not planned with. A worker that
  // stops because its grants are too narrow is asking for exactly this.
  const role = useRoles().data?.find((r) => r.id === task.roleId);
  const missing = (role?.defaultCapabilities ?? []).filter((c) => !task.executionPolicy.capabilities.includes(c));
  const [extra, setExtra] = useState<readonly string[]>([]);
  const widen = useDaemonMutation(
    (daemon) => daemon.retryTask(task.id, { addCapabilities: extra }),
    ['tasks', 'missions', 'approvals'],
    detail.mission.id,
  );
  const canWiden = missing.length > 0 && ['FAILED', 'BLOCKED', 'AWAITING_INPUT', 'SUCCEEDED', 'CANCELLED'].includes(task.status);

  // A task waiting on a person is the one case where the mission is not stuck
  // and not running - it is waiting for you, and this is where you clear it.
  const waitingOnYou = task.status === 'AWAITING_HUMAN';
  const actors = useActors();
  const unclaimed = waitingOnYou && task.assignee === null && task.claimable.length > 0;
  // Only the people the task is for can be picked - anyone else is a CONFLICT
  // at the daemon. The pick defaults to me when I am one of them, and to the
  // first of them otherwise; it follows the task when a claim changes who that is.
  const eligible = eligibleFor(task);
  const [picked, setRecordFor] = useState<string | null>(null);
  const recordFor = picked !== null && (eligible === null || eligible.includes(picked)) ? picked : defaultRecordFor(actors, eligible);
  // A one-person pool that escalated is still its person's; anyone else the escalation reached takes it first.
  const takeOver = waitingOnYou && task.assignee !== null && escalatedPastAssignee(task) && recordFor !== null && recordFor !== task.assignee.id;
  const [result, setResult] = useState('');
  const complete = useDaemonMutation(
    (daemon) => daemon.completeTask(task.id, { result: result.trim(), ...behalfOf(actors, recordFor) }),
    ['tasks', 'missions', 'artifacts'],
    detail.mission.id,
  );
  const claim = useDaemonMutation(
    (daemon) => daemon.claimTask(task.id, behalfOf(actors, recordFor)),
    ['tasks', 'missions'],
    detail.mission.id,
  );
  const evaluation = detail.evaluations.find((candidate) => candidate.taskId === task.id);

  // A worker blocked on a question is answered here, where you are already
  // looking at the task, rather than by sending you to another screen for it.
  const question = task.status === 'AWAITING_INPUT'
    ? detail.approvals.find((a) => a.taskId === task.id && a.kind === 'choice' && a.status === 'PENDING')
    : undefined;

  return (
    <Modal
      title={task.title}
      wide
      onClose={onClose}
      footer={
        <>
          {/* Record-keeping ids wait behind "Details", as in the reader: nobody scans a footer for them. */}
          <span className="dim" style={{ marginRight: 'auto', fontSize: 'var(--fs-xs)', display: 'inline-flex', gap: 8, alignItems: 'center' }}>
            <button type="button" className="reader__details-toggle" style={{ marginLeft: 0 }} aria-expanded={showIds} onClick={() => setShowIds((open) => !open)}>
              Details
              <Icon name={showIds ? 'chevronUp' : 'chevronDown'} size={11} />
            </button>
            {showIds ? (
              <>
                <IdChip id={task.id} />
                {task.key}
                {task.latestRun ? <IdChip id={task.latestRun.id} prefix="run" /> : null}
              </>
            ) : null}
          </span>
          {waitingOnYou ? <RecordingFor actors={actors} value={recordFor} onChange={setRecordFor} label={unclaimed || takeOver ? 'Claim for' : 'Done by'} eligible={eligible ?? undefined} /> : null}
          {unclaimed || takeOver ? (
            <button type="button" className="btn" disabled={claim.isPending} onClick={() => claim.mutate(undefined)}>
              <Icon name="plus" size={13} />
              {claim.isPending ? 'Claiming…' : 'Claim'}
            </button>
          ) : null}
          {waitingOnYou ? (
            <button
              type="button"
              className="btn btn--primary"
              disabled={result.trim() === '' || complete.isPending}
              onClick={() => complete.mutate(undefined, { onSuccess: onClose })}
            >
              <Icon name="check" size={13} />
              {complete.isPending ? 'Saving…' : 'Mark done'}
            </button>
          ) : null}
          {canRequestChanges ? (
            <RequestChangesButton
              taskId={task.id}
              taskTitle={task.title}
              missionId={detail.mission.id}
              outputs={liveOutputs(task)}
            />
          ) : null}
          <button type="button" className="btn btn--primary" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      <div className="stack" style={{ gap: 'var(--s4)', color: 'var(--text)' }}>
        {question !== undefined ? (
          <ApprovalCard
            compact
            view={{
              approval: question, missionTitle: null, taskTitle: null, roleName: task.roleName, revisable: false,
              addressees: [], decidedByRef: null, recordedByRef: null, escalationLevel: question.escalationLevel ?? 0, headline: null,
            }}
          />
        ) : null}

        {canWiden ? (
          <details className="card">
            <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Retry with more access</summary>
            <div className="stack" style={{ gap: 'var(--s2)', marginTop: 'var(--s3)' }}>
              <p className="muted" style={{ margin: 0 }}>
                What the {task.roleName} role may do that this task was not planned with. Anything that leaves this
                machine still follows your autonomy setting.
              </p>
              {missing.map((capability) => (
                <label key={capability} className="row" style={{ gap: 'var(--s2)' }}>
                  <input
                    type="checkbox"
                    checked={extra.includes(capability)}
                    onChange={(e) => setExtra(e.target.checked ? [...extra, capability] : extra.filter((c) => c !== capability))}
                  />
                  <span className="mono">{capability}</span>
                </label>
              ))}
              <div>
                <button type="button" className="btn" disabled={extra.length === 0 || widen.isPending} onClick={() => widen.mutate(undefined, { onSuccess: onClose })}>
                  <Icon name="refresh" size={13} />
                  {widen.isPending ? 'Retrying…' : `Retry with ${extra.length || ''} more`.trim()}
                </button>
              </div>
              {widen.isError ? <ErrorState error={widen.error} /> : null}
            </div>
          </details>
        ) : null}

        {waitingOnYou ? (
          <div className="card" style={{ borderColor: 'var(--accent-line)' }}>
            <div className="stack" style={{ gap: 'var(--s3)' }}>
              <div style={{ fontWeight: 600 }}>
                {unclaimed
                  ? `Up for grabs: ${task.claimable.map((c) => actorLabel(c, actors.meId)).join(', ')} can claim it`
                  : task.assignee && task.assignee.id !== actors.meId ? `This one is for ${task.assignee.name}` : 'This one is yours'}
              </div>
              <p className="muted" style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{task.objective}</p>
              {/* Said where the work is written, not squeezed into the footer next to the picker. */}
              {!actors.solo && eligible !== null && actors.meId !== null && !eligible.includes(actors.meId) ? (
                <p className="dim" style={{ margin: 0, fontSize: 'var(--fs-sm)' }}>You're recording this for them.</p>
              ) : null}
              <textarea
                className="input"
                rows={4}
                value={result}
                onChange={(event) => setResult(event.target.value)}
                placeholder={
                  task.expectedOutputs.length > 0
                    ? `Paste what you produced — it is saved as the ${task.expectedOutputs.join(', ')} the next task reads.`
                    : 'Describe what you did.'
                }
              />
              {complete.isError ? <ErrorState error={complete.error} /> : null}
              {claim.isError ? <ErrorState error={claim.error} /> : null}
            </div>
          </div>
        ) : null}

        <div className="row row--wrap">
          <StatusBadge status={task.status} tone={taskTone(task.status)} />
          <span className="chip">{task.roleName}</span>
          {task.runtimeName ? <span className="chip">{task.runtimeName}</span> : null}
          {/* Which model the latest run was given, and why (P12). */}
          {task.latestRun ? <span className="chip" aria-label="Model">{modelLabel(task.latestRun)}</span> : null}
          {task.targetName ? <span className="chip">{task.targetName}</span> : null}
          <span className="chip chip--muted">{task.executionPolicy.isolation} isolation</span>
        </div>
        {modelPolicyLabel(task.modelPolicy) ? (
          <p className="muted" aria-label="Step models" style={{ margin: 0, fontSize: 'var(--fs-sm)' }}>{modelPolicyLabel(task.modelPolicy)}</p>
        ) : null}

        {/* How long the running agent has been quiet (P9). Tandemise never stops it for that; the Inbox asks at the silent threshold. */}
        {task.watch ? (
          <div className="row" aria-label="Activity">
            <span className="muted" style={{ fontSize: 'var(--fs-sm)' }}>Last activity {quietFor(task.watch.quietForMs)} ago</span>
            {task.watch.level === 'active' ? null : (
              <span className="badge badge--blocked" title={`No output for ${quietFor(task.watch.quietForMs)}; quiet after ${quietFor(task.watch.quietAfterMs)}, asked about after ${quietFor(task.watch.silentAfterMs)}.`}>
                <span className="dot dot--blocked" />
                Quiet
              </span>
            )}
          </div>
        ) : null}

        <StaffingBlock task={task} detail={detail} actors={actors} />

        {task.statusReason ? (
          // A round queued or waiting is the plan working, not a problem: it reads plainly, and only a real stop warns.
          // The person-step reason is shown as the current principal sees it: named to them, it reads "Waiting for you."
          (() => {
            const reason = personStepReason(task, actors) ?? task.statusReason;
            const plain = isWaitReason(task, reason);
            return (
              <div className={plain ? 'banner' : 'banner banner--warn'}>
                <Icon name={plain ? 'info' : 'alert'} size={14} className={plain ? 'dim' : undefined} />
                <span>{reason}</span>
              </div>
            );
          })()
        ) : null}

        {/* Under the reason it stopped, so the note can answer it. */}
        {canRetry ? (
          <div className="card retry-note">
            <textarea
              className="textarea"
              rows={2}
              value={retryNote}
              onChange={(event) => setRetryNote(event.target.value)}
              placeholder="Add a note for the next attempt (optional). With a note, it runs as the next round."
              aria-label="Note for the retry"
            />
            {retryNote.trim().length > 4000 ? <span className="field__error">At most 4000 characters.</span> : null}
            <div className="retry-note__row">
              {retry.isError ? <ErrorState error={retry.error} /> : null}
              <button type="button" className="btn" disabled={retry.isPending || retryNote.trim().length > 4000} onClick={() => retry.mutate(undefined, { onSuccess: () => setRetryNote('') })}>
                <Icon name="refresh" size={13} />
                {retry.isPending ? 'Retrying…' : retryNote.trim() === '' ? 'Retry task' : 'Retry with this note'}
              </button>
            </div>
          </div>
        ) : null}

        <Block label="Objective">{task.objective}</Block>

        <div className="grid grid--2">
          <Block label="Started">{dateTime(task.startedAt)}</Block>
          <Block label="Finished">
            {task.finishedAt
              ? `${dateTime(task.finishedAt)} · ${duration(
                  task.startedAt ? Date.parse(task.finishedAt) - Date.parse(task.startedAt) : null,
                )}`
              : '—'}
          </Block>
        </div>

        {task.requiredCapabilities.length > 0 ? (
          <Block label="Capabilities requested">
            <div className="row row--wrap">
              {task.requiredCapabilities.map((capability) => (
                <span key={capability} className="chip">
                  {capability}
                </span>
              ))}
            </div>
          </Block>
        ) : null}

        {task.checks.length > 0 ? (
          <Block label="Checks">
            <div className="list">
              {task.checks.map((check) => (
                <div key={check.id} className="list__row">
                  <span className={`dot dot--${check.outcome === 'PASS' ? 'succeeded' : check.outcome === 'FAIL' ? 'failed' : 'pending'}`} />
                  <div className="list__main">
                    <div className="list__title mono">{check.name}</div>
                    <div className="list__subtitle">{check.detail}</div>
                  </div>
                  <div className="list__aside dim" style={{ fontSize: 'var(--fs-xs)' }}>
                    {duration(check.durationMs)}
                  </div>
                </div>
              ))}
            </div>
          </Block>
        ) : null}

        {task.gate ? (
          <Block label="Completion gate">
            <div className={`taskcard__gate${task.gate.passed ? '' : ' taskcard__gate--failed'}`} style={{ marginBottom: 'var(--s2)' }}>
              <Icon name={task.gate.passed ? 'shield' : 'alert'} size={12} />
              <span>{task.gate.detail}</span>
            </div>
            <code className="mono dim" style={{ display: 'block', fontSize: 'var(--fs-xs)' }}>
              {task.gate.expression}
            </code>
          </Block>
        ) : null}

        {evaluation ? (
          <Block label={`Evaluation — ${titleCase(evaluation.verdict)}`}>
            <p style={{ marginBottom: 'var(--s2)' }}>{evaluation.summary}</p>
            {evaluation.findings.map((finding, index) => (
              <div key={index} className="finding" style={{ padding: 'var(--s2) 0' }}>
                <span className={`finding__sev finding__sev--${finding.severity}`}>{finding.severity}</span>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 550 }}>{finding.title}</div>
                  <div className="muted" style={{ fontSize: 'var(--fs-sm)' }}>{finding.detail}</div>
                  {finding.location ? <div className="mono dim" style={{ fontSize: 'var(--fs-xs)' }}>{finding.location}</div> : null}
                </div>
              </div>
            ))}
          </Block>
        ) : null}

        {task.feedback.length > 0 ? <FeedbackThread task={task} missionId={detail.mission.id} actors={actors} /> : null}

        {liveOutputs(task).length > 0 ? (
          <Block label="Artifacts produced">
            {/* The current version of each output, once; older versions are a click away in the reader's version switcher. */}
            <div className="row row--wrap">
              {liveOutputs(task).map((output) => (
                <span key={output.id} className="chip">
                  <Icon name="file" size={11} />
                  {output.title}
                  {output.version > 1 ? <span className="dim">v{output.version}</span> : null}
                </span>
              ))}
            </div>
          </Block>
        ) : null}
      </div>
    </Modal>
  );
}

/**
 * Who is on the task, who it goes to if nobody answers, and - until it starts -
 * a way to change that for this task alone.
 */
function StaffingBlock({ task, detail, actors }: { task: TaskView; detail: MissionDetail; actors: Actors }): JSX.Element {
  const daemon = useDaemon();
  const finished = ['RUNNING', 'AWAITING_INPUT', 'SUCCEEDED', 'FAILED', 'SKIPPED', 'CANCELLED'].includes(task.status);
  // Mirrors the daemon: once the task has run at all, the person doing it is decided -
  // even while it waits again, for an output approval or after a failed run.
  const started = finished || task.startedAt !== null || task.attempts > 0;
  const preview = useQuery({
    queryKey: ['mission', detail.mission.id, 'staffing-preview', task.id, task.updatedAt],
    queryFn: () => daemon.previewStaffing(task.id),
    enabled: !finished,
    staleTime: 10_000,
  });
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<StaffingPatch | null>(task.staffingOverride ?? null);
  const save = useDaemonMutation((d) => d.patchTaskStaffing(task.id, toWire(draft)), ['tasks', 'missions'], detail.mission.id);
  const responsibleId = task.responsible?.id ?? preview.data?.resolved.responsible.id;
  const chain = (preview.data?.escalation ?? []).filter((a) => a.id !== responsibleId);

  return (
    <div className="card staffblock">
      <div className="row row--wrap" style={{ gap: 'var(--s2)', fontSize: 'var(--fs-sm)' }}>
        {task.assignee || task.responsible || task.claimable.length > 0 || task.wouldBe ? (
          <TaskPeople task={task} actors={actors} />
        ) : preview.data ? (
          // Not resolved yet: say who it would go to if it became ready now.
          <span className="attribution">
            <ActorChip
              actor={preview.data.resolved.assignee ?? preview.data.resolved.agentCandidates[0] ?? null}
              meId={actors.meId}
              prefix="Would go to"
            />
            {preview.data.resolved.assignee || preview.data.resolved.agentCandidates[0] ? <span className="sep">·</span> : null}
            <ActorChip actor={preview.data.resolved.responsible} meId={actors.meId} prefix="Responsible" />
          </span>
        ) : null}
        <div className="spacer" />
        {task.staffingOverride ? <span className="chip chip--muted">override</span> : null}
        {started ? null : (
          <button type="button" className="btn btn--ghost" aria-expanded={editing} onClick={() => setEditing((v) => !v)}>
            {editing ? 'Close' : 'Change'}
          </button>
        )}
      </div>
      {chain.length > 0 ? (
        <div className="dim" style={{ fontSize: 'var(--fs-xs)', marginTop: 'var(--s1)' }}>
          Unanswered requests escalate to {chain.map((a) => actorLabel(a, actors.meId)).join(' → ')}
        </div>
      ) : null}
      {editing && !started ? (
        <div className="stack" style={{ gap: 'var(--s3)', marginTop: 'var(--s3)' }}>
          <StaffingEditor
            roleId={task.roleId}
            value={draft}
            onChange={setDraft}
            actors={actors}
            level="task"
            inherited={task.staffingOverride ? undefined : preview.data?.staffing}
            disabled={save.isPending}
          />
          {save.isError ? <ErrorState error={save.error} /> : null}
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button type="button" className="btn" disabled={save.isPending} onClick={() => save.mutate(undefined, { onSuccess: () => setEditing(false) })}>
              {save.isPending ? 'Saving…' : 'Save for this task'}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The notes on this task, as a flat list per round with where each one stands.
 * Not a chat: nobody replies here, the next round's output is the reply.
 */
function FeedbackThread({ task, missionId, actors }: { task: TaskView; missionId: string; actors: Actors }): JSX.Element {
  const dismiss = useDaemonMutation((daemon, id: string) => daemon.dismissFeedback(id), ['tasks', 'missions'], missionId);
  const groups = feedbackGroups(task);
  return (
    <Block label="Feedback">
      <div className="feedback-thread">
        {groups.map((group) => (
          <section key={group.label} className="feedback-thread__group" aria-label={group.label}>
            <div className="feedback-thread__head">
              <span>{group.label}</span>
              {/* The thread is where a person who read the notes decides to act on them. */}
              {group.startsRound ? (
                <StartRoundButton taskId={task.id} missionId={missionId} className="btn btn--ghost feedback-thread__action" />
              ) : null}
            </div>
            <ul className="feedback-thread__list">
              {group.items.map((item) => (
                <li key={item.id} className="feedback-thread__item" data-status={item.status}>
                  <div className="feedback-thread__meta">
                    <span className="feedback-thread__author">{actorLabel(item.author, actors.meId)}</span>
                    <span className="chip chip--muted feedback-thread__status">{feedbackStatusLabel(item, task)}</span>
                    {item.status === 'open' || item.status === 'queued' ? (
                      <button
                        type="button"
                        className="btn btn--ghost feedback-thread__action"
                        disabled={dismiss.isPending}
                        onClick={() => dismiss.mutate(item.id)}
                      >
                        Dismiss
                      </button>
                    ) : null}
                  </div>
                  <p className="feedback-thread__text">{item.text}</p>
                </li>
              ))}
            </ul>
          </section>
        ))}
        {dismiss.isError ? <ErrorState error={dismiss.error} /> : null}
      </div>
    </Block>
  );
}

/**
 * Notes no round has taken come first, because they are the ones a person can
 * act on (Start round); then each round, newest first, with the notes that will
 * join it when it runs; dismissed notes last. A person's step has no rounds to
 * wait for: its notes are "For this step", answered when it is marked done.
 */
function feedbackGroups(task: TaskView): readonly { label: string; startsRound: boolean; items: readonly FeedbackView[] }[] {
  const items = task.feedback;
  const personStep = task.status === 'AWAITING_HUMAN';
  const waiting = items.filter((i) => i.status === 'open' && i.round === null);
  const forStep = personStep ? items.filter((i) => (i.status === 'open' || i.status === 'queued') && i.round !== null) : [];
  const dismissed = items.filter((i) => i.status === 'dismissed');
  const byRound = new Map<number, FeedbackView[]>();
  for (const item of items) {
    if (item.status === 'dismissed' || forStep.includes(item) || (item.status === 'open' && item.round === null)) continue;
    const round = item.round ?? 1;
    byRound.set(round, [...(byRound.get(round) ?? []), item]);
  }
  return [
    ...(waiting.length > 0 ? [{ label: 'Waiting for a round', startsRound: !personStep, items: waiting }] : []),
    ...(forStep.length > 0 ? [{ label: 'For this step', startsRound: false, items: forStep }] : []),
    ...[...byRound.entries()].sort(([a], [b]) => b - a).map(([round, notes]) => ({ label: `Round ${round}`, startsRound: false, items: notes })),
    ...(dismissed.length > 0 ? [{ label: 'Dismissed', startsRound: false, items: dismissed }] : []),
  ];
}

/**
 * A task queued or held for a round, an approved start waiting on a
 * dependency, or a person's step waiting on someone: its reason says where
 * the plan is, not what went wrong. AWAITING_HUMAN is always this - a step
 * waiting for a person is the normal shape of that state, not a problem.
 */
function isWaitReason(task: TaskView, reason: string | null): boolean {
  if (reason === null) return false;
  if (task.status === 'AWAITING_HUMAN') return true;
  return (task.status === 'READY' || task.status === 'PENDING')
    && /^(Round \d+|Redone after|Waiting for round|Waiting for '|Approved to start;)/.test(reason);
}

/**
 * The person-step reason, as the current principal sees it: "Waiting for
 * you." when they are the one it names, since the server text has no notion
 * of who is looking - renderer-side, from the member id, like other actor
 * rendering. Null when it names someone else, or nobody in particular (a
 * pool, or an inactive staffing), so the raw reason stands.
 */
function personStepReason(task: TaskView, actors: Actors): string | null {
  if (task.status !== 'AWAITING_HUMAN' || task.statusReason === null) return null;
  if (task.assignee === null && (task.staffing?.inactiveAssignees?.length ?? 0) > 0) return null;
  const named = task.assignee ?? (task.claimable.length === 1 ? task.claimable[0] : null);
  if (named == null) return null;
  return actors.name(named.id) === 'You' ? 'Waiting for you.' : null;
}

/**
 * The current version of each output, once. The task's list holds every
 * version it ever wrote, and three rows reading the same title are no choice
 * (in "About") and no information (in "Artifacts produced"); older versions are
 * in the reader's version switcher.
 */
function liveOutputs(task: TaskView): readonly { id: string; label: string; title: string; version: number }[] {
  const replaced = new Set(task.outputArtifacts.map((a) => a.supersedes).filter((id): id is NonNullable<typeof id> => id !== null));
  const byType = new Map<string, { id: string; label: string; title: string; version: number; createdAt: string }>();
  for (const artifact of task.outputArtifacts) {
    if (replaced.has(artifact.id) || (artifact.withdrawnAt ?? null) !== null) continue;
    const versions = task.outputArtifacts.filter((a) => a.type === artifact.type && (a.withdrawnAt ?? null) === null).length;
    const current = byType.get(artifact.type);
    if (current !== undefined && current.createdAt >= artifact.createdAt) continue;
    byType.set(artifact.type, {
      id: artifact.id,
      label: `${titleCase(artifact.type)}${versions > 1 ? ` v${versions}` : ''}`,
      title: artifact.title,
      version: versions,
      createdAt: artifact.createdAt,
    });
  }
  return [...byType.values()].map(({ id, label, title, version }) => ({ id, label, title, version }));
}

function feedbackStatusLabel(item: FeedbackView, task: TaskView): string {
  switch (item.status) {
    case 'open':
      // Attached to a round that has not run: it goes with that round, nothing to start.
      return item.round !== null && task.status !== 'AWAITING_HUMAN' ? 'Joins this round' : 'Open';
    case 'queued':
      return 'Queued for this pass';
    case 'in_round':
      return 'In progress';
    case 'addressed':
      return 'Addressed';
    case 'dismissed':
      return 'Dismissed';
  }
}

function Block({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div>
      <div className="qa__q" style={{ marginBottom: 4 }}>
        {label}
      </div>
      <div style={{ fontSize: 'var(--fs-base)', lineHeight: 1.6 }}>{children}</div>
    </div>
  );
}
