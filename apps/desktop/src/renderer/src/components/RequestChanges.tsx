import { useState } from 'react';
import type { FeedbackGivenView } from '@tandemise/api-contract';
import { Modal } from './Modal.js';
import { ErrorState } from './primitives.js';
import { Icon } from './Icon.js';
import { RecordingFor, behalfOf, defaultRecordFor } from './ActorChip.js';
import { useDaemonMutation } from '../lib/queries.js';
import { useActors } from '../lib/team.js';
import { draftFor, openComposer, openImpact, saveDraft, showFlash, useComposerRequest } from '../lib/notices.js';
import { roundStartedLine } from './ImpactDialog.js';
import { ContributionPicker, type Contribution } from './ContributionPicker.js';

/** The daemon's limit on a note, said before sending rather than as a refusal after. */
const MAX_NOTE_CHARS = 4000;

/** The daemon's limit on files and links attached to one note (spec A3). */
const MAX_ATTACHMENTS = 5;

type Output = { readonly id: string; readonly label: string };

/**
 * "Request changes" wherever a task's work is read: the feed card, the reader,
 * the task drawer. One button and one composer, so a note sent from any of them
 * reads and behaves the same.
 */
export function RequestChangesButton({
  taskId,
  taskTitle,
  missionId,
  outputs = [],
  about,
  variant = 'default',
  className,
}: {
  taskId: string;
  taskTitle: string;
  missionId: string;
  outputs?: readonly Output[];
  /** Preselects "About": the reader asks about the output it shows. */
  about?: string;
  variant?: 'ghost' | 'default';
  className?: string;
}): JSX.Element {
  return (
    <button
      type="button"
      className={className ?? (variant === 'ghost' ? 'btn btn--ghost' : 'btn')}
      // The composer opens from the shell, so it outlives this button's card moving to another section.
      onClick={() => openComposer({ taskId, taskTitle, missionId, outputs, ...(about === undefined ? {} : { about }) })}
    >
      <Icon name="message" size={12} />
      Request changes
    </button>
  );
}

/** Mounted once in the shell: the composer whichever button opened it. */
export function ComposerHost(): JSX.Element | null {
  const request = useComposerRequest();
  if (request === null) return null;
  return (
    <RequestChangesComposer
      key={request.taskId}
      taskId={request.taskId}
      taskTitle={request.taskTitle}
      missionId={request.missionId}
      outputs={request.outputs}
      {...(request.about === undefined ? {} : { about: request.about })}
      onClose={() => openComposer(null)}
    />
  );
}

/**
 * One textarea: what should change. Whether that starts a round now, waits for
 * the running pass, or is added to work that has not run is the daemon's call
 * (spec §2); the composer only says which of those happened. When finished work
 * already used the output, the impact dialog follows it, because that choice is
 * the person's to make before anything reopens.
 */
export function RequestChangesComposer({
  taskId,
  taskTitle,
  missionId,
  outputs,
  about: preset,
  onClose,
}: {
  taskId: string;
  taskTitle: string;
  missionId: string;
  outputs: readonly Output[];
  about?: string;
  onClose: () => void;
}): JSX.Element {
  const actors = useActors();
  const [text, setTextState] = useState(() => draftFor(taskId));
  const setText = (next: string): void => {
    setTextState(next);
    saveDraft(taskId, next);
  };
  const [about, setAbout] = useState<string>(preset ?? '');
  const [recordFor, setRecordFor] = useState<string | null>(defaultRecordFor(actors, null));
  // Not kept with the draft text: a file's bytes are too big to park in storage, and picking it again is one click.
  const [attachments, setAttachments] = useState<Contribution[]>([]);
  const give = useDaemonMutation(
    (daemon) =>
      daemon.giveFeedback(taskId, {
        text: text.trim(),
        ...(about ? { artifactId: about } : {}),
        ...(attachments.length === 0 ? {} : { attachments }),
        ...behalfOf(actors, recordFor),
      }),
    ['tasks', 'missions', 'approvals', 'artifacts'],
    missionId,
  );

  const trimmed = text.trim();
  const tooLong = trimmed.length > MAX_NOTE_CHARS;
  const send = (): void => {
    if (trimmed === '' || tooLong || give.isPending) return;
    give.mutate(undefined, {
      onSuccess: (given) => {
        // A finished task whose output was used waits for the person's choice about that work.
        // The question is asked from the shell, so it outlives this composer and the card it was opened on.
        if (given.impact !== null && given.impact.dependents.length > 0) openImpact({ impact: given.impact, missionId, recordFor });
        else showFlash(outcome(given));
        saveDraft(taskId, '');
        onClose();
      },
    });
  };
  // "About" is worth a control only when there is a choice: several outputs, or one output the composer was opened on.
  const showAbout = outputs.length > 1 || (preset !== undefined && outputs.length > 0);

  return (
    <Modal
      title={`Request changes to ${taskTitle}`}
      onClose={onClose}
      footer={
        <>
          <RecordingFor actors={actors} value={recordFor} onChange={setRecordFor} />
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn--primary" disabled={trimmed === '' || tooLong || give.isPending} onClick={send}>
            {give.isPending ? 'Sending…' : 'Request changes'}
          </button>
        </>
      }
    >
      <div className="composer">
        <label className="field">
          <span className="field__label">What should change?</span>
          <textarea
            className="textarea"
            rows={5}
            value={text}
            onChange={(e) => setText(e.target.value)}
            // Cmd/Ctrl+Enter sends, as in every other place a note is written and sent in one go.
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send();
            }}
            placeholder="The next round works from exactly what you write."
            autoFocus
          />
          {tooLong ? <span className="field__error">At most {MAX_NOTE_CHARS} characters.</span> : null}
        </label>
        <ContributionPicker value={attachments} onChange={setAttachments} max={MAX_ATTACHMENTS} label="Attach" />
        {showAbout ? (
          <label className="field">
            <span className="field__label">About</span>
            <select className="select" value={about} onChange={(e) => setAbout(e.target.value)}>
              <option value="">The whole task</option>
              {outputs.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {give.isError ? <ErrorState error={give.error} /> : null}
      </div>
    </Modal>
  );
}

/** What the note did, in the words the person reads next to where they sent it. */
function outcome(given: FeedbackGivenView): string {
  if (given.roundStarted !== null) return roundStartedLine(given.roundStarted, given.roundNotes);
  if (given.feedback.status === 'queued') return 'Queued: delivered when the current pass ends';
  return 'Added to the task';
}
