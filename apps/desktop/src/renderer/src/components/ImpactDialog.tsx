import { useId, useState, type ReactNode } from 'react';
import type { DownstreamImpactView, TaskView } from '@tandemise/api-contract';
import type { TaskStatus } from '@tandemise/domain';
import { Modal } from './Modal.js';
import { ErrorState } from './primitives.js';
import { behalfOf } from './ActorChip.js';
import { useDaemonMutation } from '../lib/queries.js';
import { useDaemon } from '../lib/connection.js';
import { useActors } from '../lib/team.js';
import { titleCase } from '../lib/format.js';
import { openImpact, showFlash, useImpactRequest } from '../lib/notices.js';
import { describeError } from '../lib/daemon.js';

/** Where a dependent is, in the feed's words: "done", not SUCCEEDED. */
export const STATUS_WORDS: Readonly<Record<TaskStatus, string>> = {
  PENDING: 'planned',
  READY: 'queued',
  RUNNING: 'running',
  AWAITING_INPUT: 'asking a question',
  AWAITING_HUMAN: 'person step',
  AWAITING_EXTERNAL: 'waiting',
  AWAITING_APPROVAL: 'in review',
  BLOCKED: 'blocked',
  SUCCEEDED: 'done',
  FAILED: 'failed',
  SKIPPED: 'skipped',
  CANCELLED: 'cancelled',
};

/**
 * "Build (done), Review (running) used Design v2": the one question a new round
 * of finished work has to ask (spec §3). Redo is the default while any of them
 * still runs, because letting it finish on a version being replaced wastes the
 * run; the daemon decides that default and this only shows it.
 *
 * Never mounted without dependents: with nothing downstream there is no choice
 * to make, and the round starts straight away.
 */
export function ImpactDialog({
  impact,
  missionId,
  recordFor,
  onClose,
}: {
  impact: DownstreamImpactView;
  missionId: string;
  recordFor: string | null;
  onClose: () => void;
}): JSX.Element {
  const actors = useActors();
  const [choice, setChoice] = useState<'redo' | 'keep'>(impact.defaultChoice);
  const [picked, setPicked] = useState<readonly string[]>(impact.dependents.map((d) => d.taskId));
  const start = useDaemonMutation(
    (daemon) =>
      daemon.startRound(impact.taskId, {
        feedbackIds: [...impact.feedbackIds],
        downstream: choice,
        ...(choice === 'redo' ? { redoTaskIds: [...picked] } : {}),
        ...behalfOf(actors, recordFor),
      }),
    ['tasks', 'missions', 'approvals', 'artifacts'],
    missionId,
  );
  // Keys, not titles, in the sentence: "Build (done) used Design v2" is the line the spec asks for, and full titles make it a paragraph.
  // Grouped by the version each used: dependents can stand on different versions (one kept an older one), and one number would misstate the rest.
  const byVersion = new Map<number, string[]>();
  for (const d of impact.dependents) {
    byVersion.set(d.usedVersion, [...(byVersion.get(d.usedVersion) ?? []), `${titleCase(d.key)} (${d.running ? 'running' : STATUS_WORDS[d.status]})`]);
  }
  const used = [...byVersion.entries()]
    .sort(([a], [b]) => a - b)
    .map(([version, names]) => `${names.join(', ')} used ${titleCase(impact.taskKey)} v${version}`)
    .join('; ');

  return (
    <Modal
      title={`Round ${impact.nextRound} of ${impact.taskTitle}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Not now
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={start.isPending || (choice === 'redo' && picked.length === 0)}
            onClick={() =>
              start.mutate(undefined, {
                onSuccess: (task) => {
                  showFlash(roundStartedLine(task.round, carried(task)));
                  onClose();
                },
              })
            }
          >
            {start.isPending ? 'Starting…' : `Start round ${impact.nextRound}`}
          </button>
        </>
      }
    >
      <div className="impact">
        <p className="impact__used">
          {used}.
        </p>
        <DownstreamChoice
          choice={choice}
          onChoice={setChoice}
          redoDetail={
            <ul className="impact__list">
              {impact.dependents.map((d) => (
                <li key={d.taskId}>
                  <label className="impact__dependent">
                    <input
                      type="checkbox"
                      checked={picked.includes(d.taskId)}
                      onChange={(e) => setPicked(e.target.checked ? [...picked, d.taskId] : picked.filter((id) => id !== d.taskId))}
                    />
                    <span className="truncate">{d.title}</span>
                  </label>
                </li>
              ))}
            </ul>
          }
        />
        {start.isError ? <ErrorState error={start.error} /> : null}
      </div>
    </Modal>
  );
}

/**
 * P2's one choice about work that used a version being replaced: redo it after
 * the new one, or keep it and flag it. Shared by the round dialog and the
 * hand-back (spec A4), so both ask it in the same words.
 */
export function DownstreamChoice({
  choice,
  onChoice,
  redoDetail,
}: {
  choice: 'redo' | 'keep';
  onChoice: (choice: 'redo' | 'keep') => void;
  /** Shown under "Redo" while it is chosen: which of the dependents to redo, where the caller can pick. */
  redoDetail?: ReactNode;
}): JSX.Element {
  // One radio group per mounted dialog: two open at once (a round over a hand-back) must not share a name.
  const name = useId();
  return (
    <>
      <label className="impact__choice">
        <input type="radio" name={name} checked={choice === 'redo'} onChange={() => onChoice('redo')} />
        <span>Redo them after the new version</span>
      </label>
      {choice === 'redo' ? redoDetail : null}
      <label className="impact__choice">
        <input type="radio" name={name} checked={choice === 'keep'} onChange={() => onChoice('keep')} />
        <span>
          Keep their work <span className="impact__hint">They are flagged when the new version lands.</span>
        </span>
      </label>
    </>
  );
}

/**
 * "Start round" for notes that wait on one: the dialog when finished work used
 * the output, the round itself when nothing did.
 *
 * The thread is read when the button is clicked, not when it mounts: a feed
 * holds many cards, and a read per card on every refresh bought nothing. A
 * fresh read also decides the choice honestly; "none" is sent only when
 * nothing used the output, and if something did by the time the round is
 * sent, the daemon refuses and the question is asked after all.
 */
export function StartRoundButton({ taskId, missionId, className = 'btn' }: { taskId: string; missionId: string; className?: string }): JSX.Element {
  const daemon = useDaemon();
  const [reading, setReading] = useState(false);
  const start = useDaemonMutation(
    (client, pending: DownstreamImpactView) => client.startRound(taskId, { feedbackIds: [...pending.feedbackIds], downstream: 'none' }),
    ['tasks', 'missions', 'approvals', 'artifacts'],
    missionId,
  );
  /** Opens the question when work used the output; false when nothing did. */
  const askIfUsed = (impact: DownstreamImpactView | null): boolean => {
    if (impact === null || impact.dependents.length === 0) return false;
    openImpact({ impact, missionId, recordFor: null });
    return true;
  };
  const click = async (): Promise<void> => {
    setReading(true);
    try {
      const impact = (await daemon.taskFeedback(taskId)).pendingImpact;
      // Nothing pending by the time the click's own read lands is not nothing
      // happening: something already claimed these notes (another round, or
      // another click), and staying silent would read as a button that does nothing.
      if (impact === null) {
        showFlash('Nothing to start: these notes already joined a round.');
        return;
      }
      if (askIfUsed(impact)) return;
      start.mutate(impact, {
        onSuccess: (task) => showFlash(roundStartedLine(task.round, carried(task))),
        // A button on a card has no room for an error box; the refusal is said the way success is.
        onError: (error) => {
          void daemon.taskFeedback(taskId)
            .then((thread) => askIfUsed(thread.pendingImpact) || showFlash(describeError(error).detail))
            .catch(() => showFlash(describeError(error).detail));
        },
      });
    } catch (error) {
      showFlash(describeError(error).detail);
    } finally {
      setReading(false);
    }
  };
  return (
    <button type="button" className={className} disabled={reading || start.isPending} onClick={() => void click()}>
      {reading || start.isPending ? 'Starting…' : 'Start round'}
    </button>
  );
}

/** "Round 2 started", and how many notes it took when more than the one in hand joined it. */
export function roundStartedLine(round: number | null, notes: number): string {
  return `Round ${round ?? ''} started${notes > 1 ? ` with ${notes} notes` : ''}`;
}

/** The notes a task's current round carries. */
function carried(task: TaskView): number {
  return task.feedback.filter((item) => item.status === 'in_round' && item.round === task.round).length;
}

/** Mounted once in the shell: shows the impact question whichever control asked it. */
export function ImpactHost(): JSX.Element | null {
  const request = useImpactRequest();
  if (request === null) return null;
  return (
    <ImpactDialog
      key={`${request.impact.taskId}-${request.impact.nextRound}-${request.impact.feedbackIds.join(',')}`}
      impact={request.impact}
      missionId={request.missionId}
      recordFor={request.recordFor}
      onClose={() => openImpact(null)}
    />
  );
}
