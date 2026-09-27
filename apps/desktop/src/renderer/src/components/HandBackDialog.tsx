import { useState } from 'react';
import type { ArtifactType } from '@tandemise/domain';
import type { TaskView } from '@tandemise/api-contract';
import { Modal } from './Modal.js';
import { Icon } from './Icon.js';
import { RecordingFor, behalfOf, defaultRecordFor } from './ActorChip.js';
import { ContributionPicker, type Contribution } from './ContributionPicker.js';
import { DownstreamChoice, STATUS_WORDS } from './ImpactDialog.js';
import { useDaemonMutation, useMission } from '../lib/queries.js';
import { useActors } from '../lib/team.js';
import { describeError } from '../lib/daemon.js';
import { showFlash } from '../lib/notices.js';
import { defaultElsewhereTool } from '../lib/domain.js';
import { titleCase } from '../lib/format.js';

/** The daemon's limits on a tool name and a note, said before sending rather than as a refusal after. */
const MAX_TOOL_CHARS = 40;
const MAX_NOTE_CHARS = 4000;

type Step = { readonly id: string; readonly title: string };

/**
 * "Continue elsewhere" (spec A4): which tool the work moves to, and nothing
 * else. The daemon decides whether the step may go (it refuses once other work
 * has used its output) and its reason is shown here, where it was asked.
 */
export function ContinueElsewhereDialog({
  task,
  outputs,
  missionId,
  onClose,
}: {
  task: Step;
  outputs: readonly ArtifactType[];
  missionId: string;
  onClose: () => void;
}): JSX.Element {
  const [tool, setTool] = useState(() => defaultElsewhereTool(outputs));
  const park = useDaemonMutation((daemon) => daemon.parkTask(task.id, { tool: tool.trim() }), ['tasks', 'missions', 'approvals'], missionId);
  const trimmed = tool.trim();
  const tooLong = trimmed.length > MAX_TOOL_CHARS;
  const send = (): void => {
    if (trimmed === '' || tooLong || park.isPending) return;
    park.mutate(undefined, {
      onSuccess: () => {
        showFlash(`Continued in ${trimmed}`);
        onClose();
      },
    });
  };

  return (
    <Modal
      title={`Continue ${task.title} elsewhere`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn--primary" disabled={trimmed === '' || tooLong || park.isPending} onClick={send}>
            {park.isPending ? 'Stopping the agent…' : 'Continue elsewhere'}
          </button>
        </>
      }
    >
      <div className="composer">
        <p className="muted">The agent stops, and work that needs this step waits until you hand it back.</p>
        <label className="field">
          <span className="field__label">Where you will work on it</span>
          <input
            className="input"
            value={tool}
            onChange={(e) => setTool(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') send();
            }}
            autoFocus
          />
          {tooLong ? <span className="field__error">At most {MAX_TOOL_CHARS} characters.</span> : null}
        </label>
        {park.isError ? <p className="field__error" role="alert">{describeError(park.error).detail}</p> : null}
      </div>
    </Modal>
  );
}

/**
 * "Hand back" (spec A4): a note, the one piece of work that came back, and -
 * only when finished work already used this step's output - P2's choice about
 * that work. What comes back becomes the step's next round, authored by the
 * person; the daemon's refusals (a link nothing here can read, a step already
 * handed back) are shown in its own words.
 */
export function HandBackDialog({
  task,
  tool,
  missionId,
  onClose,
}: {
  task: Step;
  tool: string;
  missionId: string;
  onClose: () => void;
}): JSX.Element {
  const actors = useActors();
  const mission = useMission(missionId);
  const [note, setNote] = useState('');
  const [contribution, setContribution] = useState<Contribution[]>([]);
  const [recordFor, setRecordFor] = useState<string | null>(defaultRecordFor(actors, null));
  const used = usedBy(task.id, mission.data?.tasks ?? []);
  // The daemon's default: work still running on the old version is wasted if kept; finished work is the person's call.
  const [choice, setChoice] = useState<'redo' | 'keep' | null>(null);
  const downstream = choice ?? (used.some((t) => t.status === 'RUNNING') ? 'redo' : 'keep');
  const give = useDaemonMutation(
    (daemon) =>
      daemon.handBack(task.id, {
        note: note.trim(),
        contribution: contribution[0]!,
        ...(used.length > 0 ? { downstream } : {}),
        ...behalfOf(actors, recordFor),
      }),
    ['tasks', 'missions', 'approvals', 'artifacts'],
    missionId,
  );
  const trimmed = note.trim();
  const tooLong = trimmed.length > MAX_NOTE_CHARS;
  const ready = trimmed !== '' && !tooLong && contribution.length === 1 && !give.isPending;
  const send = (): void => {
    if (!ready) return;
    give.mutate(undefined, {
      onSuccess: ({ task: next }) => {
        showFlash(`Handed back from ${tool}: round ${next.round}`);
        onClose();
      },
    });
  };

  return (
    <Modal
      title={`Hand back ${task.title}`}
      onClose={onClose}
      footer={
        <>
          <RecordingFor actors={actors} value={recordFor} onChange={setRecordFor} />
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn--primary" disabled={!ready} onClick={send}>
            {give.isPending ? 'Handing back…' : 'Hand back'}
          </button>
        </>
      }
    >
      <div className="composer">
        <label className="field">
          <span className="field__label">What did you do in {tool}?</span>
          <textarea
            className="textarea"
            rows={4}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send();
            }}
            placeholder="The work that follows reads this note with what you attach."
            autoFocus
          />
          {tooLong ? <span className="field__error">At most {MAX_NOTE_CHARS} characters.</span> : null}
        </label>
        <ContributionPicker
          value={contribution}
          onChange={(next) => {
            setContribution(next);
            // A refusal is about what was sent; once the work changes it no longer describes anything on screen.
            give.reset();
          }}
          max={1}
          label="The work"
          hint="One file, or a link."
        />
        {used.length > 0 ? (
          <div className="impact">
            <p className="impact__used">
              {used.map((t) => `${titleCase(t.key)} (${STATUS_WORDS[t.status]})`).join(', ')} used the earlier version.
            </p>
            <DownstreamChoice choice={downstream} onChoice={setChoice} />
          </div>
        ) : null}
        {give.isError ? (
          <p className="field__error" role="alert">
            <Icon name="alert" size={12} /> {describeError(give.error).detail}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}

/**
 * The steps that already read this one's output, as far as the mission view
 * can tell: those that depend on it and have run. Held work that never started
 * has read nothing, so it is not asked about. The daemon applies the choice to
 * the consumers it knows from its run inputs; this only decides whether to ask.
 */
export function usedBy(taskId: string, tasks: readonly TaskView[]): readonly TaskView[] {
  const self = tasks.find((t) => t.id === taskId);
  return tasks.filter(
    (t) => t.id !== taskId && t.runCount > 0 && (t.dependsOn.includes(taskId) || (self !== undefined && t.dependsOn.includes(self.key))),
  );
}
