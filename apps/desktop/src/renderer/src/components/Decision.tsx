import { useState } from 'react';
import type { ApprovalView } from '@tandemise/api-contract';
import type { Approval, ApprovalOption, RiskClass } from '@tandemise/domain';
import { NEEDS_CHANGES_OPTION, REJECT_OPTION, REPLAN_REST_OPTION, REQUEST_CHANGES_OPTION, SKIP_REST_OPTION, isLimitCard, isPlanFitCard } from '../lib/domain.js';
import { ConfirmDialog } from './Modal.js';
import { ErrorState } from './primitives.js';
import { RecordingFor, behalfOf } from './ActorChip.js';
import { useDaemonMutation } from '../lib/queries.js';
import { useDaemon } from '../lib/connection.js';
import { openImpact } from '../lib/notices.js';
import { useActors, type Actors } from '../lib/team.js';
import { titleCase } from '../lib/format.js';

/**
 * Deciding an approval, wherever it is decided.
 *
 * The Inbox card and a mission's feed card ask the same question and send the
 * same call, so they share this one implementation: which option is picked,
 * the note, whose name it goes on, and whether a risky choice is confirmed
 * first. Two copies would drift, and a decision that confirms in one place and
 * applies silently in another is exactly the inconsistency people stop trusting.
 */
export interface ApprovalDecision {
  readonly approval: Approval;
  readonly actors: Actors;
  readonly copy: CardCopy;
  readonly selected: string;
  readonly select: (optionId: string) => void;
  readonly chosen: ApprovalOption | undefined;
  readonly note: string;
  readonly setNote: (note: string) => void;
  readonly recordFor: string | null;
  readonly setRecordFor: (memberId: string) => void;
  readonly needsConfirm: boolean;
  readonly missingAnswer: boolean;
  readonly pending: boolean;
  readonly error: unknown;
  readonly confirming: ApprovalOption | null;
  /** What sending a given option means: its words, whether it is confirmed first, whether it styles as danger. */
  readonly consequence: (optionId: string | undefined) => Consequence;
  /** Sends the decision, or asks for confirmation first when the choice is consequential. */
  readonly request: () => void;
  /** Picks an option and requests it in one gesture: the feed's buttons are the options themselves. */
  readonly requestOption: (optionId: string) => void;
  readonly submit: () => void;
  readonly cancelConfirm: () => void;
}

export interface Consequence {
  readonly copy: CardCopy;
  readonly confirm: boolean;
  readonly danger: boolean;
  /** The short line under the controls: what happens when this is sent. */
  readonly hint: string;
}

export function useApprovalDecision(view: ApprovalView): ApprovalDecision {
  const { approval } = view;
  const [selected, setSelected] = useState<string>(approval.recommendedOptionId ?? approval.options[0]?.id ?? 'approve');
  const [note, setNote] = useState('');
  const [confirming, setConfirming] = useState<ApprovalOption | null>(null);
  const actors = useActors();
  const [recordFor, setRecordFor] = useState<string | null>(null);

  const daemon = useDaemon();
  const decide = useDaemonMutation(
    (client, args: { optionId: string; note: string }) =>
      client.decideApproval(approval.id, { optionId: args.optionId, note: args.note || undefined, ...behalfOf(actors, recordFor) }),
    ['approvals', 'missions', 'tasks'],
  );

  // "Needs changes" with a note is feedback. On work something downstream
  // already used, the round waits for the person's choice about that work, and
  // the card has no way to say so; the task's thread does (spec §3).
  const afterDecided = (optionId: string, sentNote: string): void => {
    if (approval.kind !== 'check' || optionId !== NEEDS_CHANGES_OPTION || sentNote.trim() === '' || approval.taskId === null || approval.missionId === null) return;
    const missionId = approval.missionId;
    void daemon.taskFeedback(approval.taskId).then(
      (thread) => {
        if (thread.pendingImpact !== null && thread.pendingImpact.dependents.length > 0) {
          openImpact({ impact: thread.pendingImpact, missionId, recordFor });
        }
      },
      // The decision itself is recorded; the note stays pending on the card with "Start round" if this read fails.
      () => undefined,
    );
  };
  const send = (optionId: string): void => decide.mutate({ optionId, note }, { onSuccess: () => afterDecided(optionId, note) });

  // One place decides what an option means, so the full form, the inline
  // buttons and the confirm step can never disagree about it.
  const consequence = (optionId: string | undefined): Consequence => {
    const copy = copyFor(approval, optionId, view.revisable);
    // Request changes starts another round of the same work: nothing is lost, so nothing is confirmed.
    const confirm = copy.question || approval.kind === 'check' || optionId === REQUEST_CHANGES_OPTION
      ? false
      : isConsequential(approval.risk) || optionId === REJECT_OPTION || optionId === SKIP_REST_OPTION;
    const danger = (optionId === REJECT_OPTION || optionId === SKIP_REST_OPTION) && !copy.question && approval.kind !== 'check';
    const hint = copy.question
      ? 'The worker is waiting, and carries on as soon as you send this.'
      : approval.kind === 'check'
        ? 'Nothing is waiting on this; your note is kept with the work.'
        : optionId === REQUEST_CHANGES_OPTION
          ? 'The next round works from your note.'
          : optionId === REPLAN_REST_OPTION
            ? 'Nothing changes until you approve the new steps.'
            : confirm ? 'You will be asked to confirm.' : 'Applies immediately.';
    return { copy, confirm, danger, hint };
  };

  const chosen = approval.options.find((option) => option.id === selected) ?? approval.options[0];
  const current = consequence(chosen?.id);
  const missingAnswer = current.copy.noteRequired && note.trim().length === 0;

  const sendOrConfirm = (option: ApprovalOption | undefined): void => {
    if (!option) return;
    const { copy, confirm } = consequence(option.id);
    if (copy.noteRequired && note.trim().length === 0) return;
    if (confirm) setConfirming(option);
    else send(option.id);
  };

  const submit = (): void => {
    const option = confirming ?? chosen;
    if (!option) return;
    send(option.id);
    setConfirming(null);
  };

  return {
    approval,
    actors,
    copy: current.copy,
    selected,
    select: setSelected,
    chosen,
    note,
    setNote,
    recordFor,
    setRecordFor,
    needsConfirm: current.confirm,
    missingAnswer,
    pending: decide.isPending,
    error: decide.isError ? decide.error : null,
    confirming,
    consequence,
    request: () => sendOrConfirm(chosen),
    requestOption: (optionId) => {
      setSelected(optionId);
      sendOrConfirm(approval.options.find((option) => option.id === optionId));
    },
    submit,
    cancelConfirm: () => setConfirming(null),
  };
}

/**
 * The options, the note, "Recording for" and the submit button.
 *
 * `inline` is the feed's form of the same controls: a one-line note, one
 * button per option and a short hint, so a card spends one row on deciding.
 * It is a layout, not a second behaviour - everything it sends and every word
 * it shows comes from `useApprovalDecision`.
 */
export function DecisionForm({ decision, variant = 'full' }: { decision: ApprovalDecision; variant?: 'full' | 'inline' }): JSX.Element {
  const { approval, copy, chosen, actors } = decision;
  // The inline form asks for an answer only after someone tried to send without one, not before they have read the card.
  const [tried, setTried] = useState(false);
  // The option a pointer or keyboard is on: the note and hint describe that one before it is clicked.
  const [aiming, setAiming] = useState<string | null>(null);

  if (variant === 'inline') {
    // The recommended option is the one primary action; with none, the first option is.
    // It sits last, nearest the hand, and a destructive option sits first, farthest from it.
    const primaryId = approval.recommendedOptionId ?? approval.options[0]?.id;
    const rank = (id: string): number => (id === primaryId ? 2 : decision.consequence(id).danger ? 0 : 1);
    const ordered = [...approval.options].sort((a, b) => rank(a.id) - rank(b.id));
    // A question that can be answered in words is asked as one: the note reads as the answer, required, from the start.
    const answerable = approval.kind === 'choice' && approval.options.some((o) => o.id === 'answer');
    const next = decision.consequence(aiming ?? (answerable ? 'answer' : decision.selected));
    // Judged for the option the hint describes: pointing at Approve after a refused Request changes should not still say a note is missing.
    const missing = tried && next.copy.noteRequired && decision.note.trim().length === 0;
    const aim = (id: string | null) => () => setAiming(id);
    return (
      <div className="decide-inline">
        <div className="decide-inline__row">
          <input
            className="input decide-inline__note"
            // The one-line note is a few words wide next to three buttons; the full sentence stays as its label.
            placeholder={next.copy.noteShort}
            aria-label={next.copy.notePlaceholder}
            aria-required={next.copy.noteRequired}
            data-required={next.copy.noteRequired}
            value={decision.note}
            onChange={(event) => decision.setNote(event.target.value)}
          />
          <RecordingFor actors={actors} value={decision.recordFor} onChange={decision.setRecordFor} />
          <span className="decide-inline__hint" data-warn={missing}>
            {missing ? missingText(next.copy) : next.hint}
          </span>
          {ordered.map((option) => {
            const { danger } = decision.consequence(option.id);
            return (
              <button
                key={option.id}
                type="button"
                className={`btn${danger ? ' btn--danger' : option.id === primaryId ? ' btn--primary' : ''}`}
                title={option.description ?? undefined}
                disabled={decision.pending}
                onMouseEnter={aim(option.id)}
                onMouseLeave={aim(null)}
                onFocus={aim(option.id)}
                onBlur={aim(null)}
                onClick={() => {
                  setTried(true);
                  decision.requestOption(option.id);
                }}
              >
                {decision.pending && option.id === decision.selected ? 'Submitting…' : submitLabel(decision.consequence(option.id).copy, option)}
              </button>
            );
          })}
        </div>
        {decision.error ? <ErrorState error={decision.error} /> : null}
        <DecisionConfirm decision={decision} />
      </div>
    );
  }

  const { danger, hint } = decision.consequence(chosen?.id);
  return (
    <>
      {approval.options.map((option) => (
        <button
          key={option.id}
          type="button"
          className="option"
          data-selected={option.id === decision.selected}
          data-recommended={option.id === approval.recommendedOptionId}
          onClick={() => decision.select(option.id)}
        >
          <span className="option__radio" />
          <span style={{ flex: 1, minWidth: 0 }}>
            <span className="option__label">
              {option.label}
              {option.id === approval.recommendedOptionId ? (
                <span className="badge badge--accent" style={{ marginLeft: 8 }}>
                  Recommended
                </span>
              ) : null}
            </span>
            {option.description ? <span className="option__desc">{option.description}</span> : null}
          </span>
        </button>
      ))}

      <textarea
        className="textarea"
        style={{ minHeight: copy.noteRequired ? 88 : 56, marginTop: 4 }}
        placeholder={copy.notePlaceholder}
        aria-label={copy.notePlaceholder}
        aria-required={copy.noteRequired}
        value={decision.note}
        onChange={(event) => decision.setNote(event.target.value)}
      />

      {decision.error ? <ErrorState error={decision.error} /> : null}

      <div className="row row--wrap" style={{ justifyContent: 'flex-end', marginTop: 4 }}>
        <span className="dim" style={{ fontSize: 'var(--fs-xs)', marginRight: 'auto' }}>
          {decision.missingAnswer ? missingText(copy) : hint}
        </span>
        <RecordingFor actors={actors} value={decision.recordFor} onChange={decision.setRecordFor} />
        <button
          type="button"
          className={`btn ${danger ? 'btn--danger' : 'btn--primary'}`}
          disabled={decision.pending || !chosen || decision.missingAnswer}
          onClick={decision.request}
        >
          {decision.pending ? 'Submitting…' : submitLabel(copy, chosen)}
        </button>
      </div>
      <DecisionConfirm decision={decision} />
    </>
  );
}

/** The "are you sure" for a consequential choice: what it changes and its risk, before it is recorded. */
function DecisionConfirm({ decision }: { decision: ApprovalDecision }): JSX.Element | null {
  const { confirming, approval } = decision;
  if (!confirming) return null;
  return (
    <ConfirmDialog
      title={`${confirming.label}?`}
      destructive={confirming.id === REJECT_OPTION || isConsequential(approval.risk)}
      confirmLabel={confirming.label}
      busy={decision.pending}
      onCancel={decision.cancelConfirm}
      onConfirm={decision.submit}
      body={
        <>
          <p>{approval.effect}</p>
          <p style={{ marginTop: 'var(--s3)' }}>
            Risk class <strong>{riskLabel(approval.risk)}</strong>. This decision is recorded and shown to every downstream role.
          </p>
        </>
      }
    />
  );
}

/** Why the send did nothing: an open question wants its answer, Request changes wants what should change. */
function missingText(copy: CardCopy): string {
  return copy.question ? 'Write your answer to send it.' : 'Say what should change to send it.';
}

/** A question's button says it sends an answer; "Figma" alone reads like a link. */
function submitLabel(copy: CardCopy, chosen: ApprovalOption | undefined): string {
  if (chosen === undefined) return 'Decide';
  if (!copy.question || chosen.id === 'answer' || chosen.id === REJECT_OPTION) return chosen.label;
  return `Answer: ${chosen.label}`;
}

export interface CardCopy {
  /** A worker asked something, rather than asked to be allowed something. */
  readonly question: boolean;
  readonly kindLabel: string;
  readonly effectQuestion: string;
  readonly notePlaceholder: string;
  /** The same ask in the few words a one-line note field shows before it cuts off. */
  readonly noteShort: string;
  /** An open question is answered in the note; there is nothing to send without one. */
  readonly noteRequired: boolean;
}

/**
 * The words on the card depend on what is being asked.
 *
 * A `choice` is a worker asking you something and waiting on the answer. Asking
 * "what changes if you approve?" of it, painting "decide without me" red, and
 * making you confirm it as if it were destructive would all misdescribe what
 * the click does - and an open question whose answer box says "optional" would
 * invite sending nothing to a worker that is blocked on exactly that.
 *
 * A task's output card is the other case that changed. "Request changes" sends
 * the note as the brief for the next round, so it cannot be sent empty; "Reject
 * without changes" stops the task, and its note is only for the record. A card
 * from before rounds has no Request changes, and its reject with a note still
 * starts a round, so it keeps that wording.
 */
export function copyFor(approval: Approval, selectedId: string | undefined, revisable = false): CardCopy {
  if (approval.kind === 'choice') {
    const open = selectedId === 'answer';
    const notePlaceholder = open
      ? 'Your answer — the worker reads exactly what you write.'
      : selectedId === REJECT_OPTION
        ? 'Anything it should keep in mind while it decides? (optional)'
        : 'Anything to add — a link, a detail? (optional)';
    return {
      question: true,
      kindLabel: 'Question',
      effectQuestion: 'What happens when you answer?',
      notePlaceholder,
      noteShort: notePlaceholder,
      noteRequired: open,
    };
  }
  // A limit card (P8) is answered with a number, not a note: the copy only frames it.
  if (isLimitCard(approval)) {
    return {
      question: false,
      kindLabel: 'Limit reached',
      effectQuestion: 'What happens when you decide?',
      notePlaceholder: '',
      noteShort: '',
      noteRequired: false,
    };
  }
  // A step said the plan no longer fits: the answer is what happens to the steps after it, not a yes or no.
  if (isPlanFitCard(approval)) {
    const requestsChanges = selectedId === REQUEST_CHANGES_OPTION;
    const replans = selectedId === REPLAN_REST_OPTION;
    return {
      question: false,
      kindLabel: 'Plan no longer fits',
      effectQuestion: 'What happens when you decide?',
      notePlaceholder: requestsChanges
        ? 'What should it do instead? It goes again as the next round, using exactly what you write.'
        : replans
          ? 'What should the rest of the mission do now? The planner reads exactly this (optional).'
          : 'Add a note for the record (optional).',
      noteShort: requestsChanges ? 'What should it do instead?' : replans ? 'What should the rest do now? (optional)' : 'Add a note for the record (optional)',
      noteRequired: requestsChanges,
    };
  }
  if (approval.kind === 'check') {
    return {
      question: false,
      kindLabel: 'Check',
      effectQuestion: 'What happens next?',
      notePlaceholder: selectedId === NEEDS_CHANGES_OPTION
        ? 'What needs to change? With a note, it goes back as the next round.'
        : 'Anything to add? (optional)',
      noteShort: selectedId === NEEDS_CHANGES_OPTION ? 'What needs to change?' : 'Anything to add? (optional)',
      noteRequired: false,
    };
  }
  const requestsChanges = selectedId === REQUEST_CHANGES_OPTION;
  const legacyRevising = revisable && selectedId === REJECT_OPTION && !approval.options.some((o) => o.id === REQUEST_CHANGES_OPTION);
  return {
    question: false,
    kindLabel: titleCase(approval.kind),
    effectQuestion: 'What changes if you approve?',
    notePlaceholder: requestsChanges || legacyRevising
      ? 'What should change? It goes back as the next round, using exactly what you write.'
      : 'Add a note for the record (optional) — downstream roles will read it.',
    noteShort: requestsChanges || legacyRevising ? 'What should change?' : 'Add a note for the record (optional)',
    noteRequired: requestsChanges,
  };
}

const RISK_LABELS: Readonly<Record<RiskClass, string>> = {
  read: 'Read only',
  write_reversible: 'Reversible',
  external_side_effect: 'Leaves this machine',
  destructive: 'Destructive',
  financial: 'Financial',
  release: 'Release',
};

export function riskLabel(risk: RiskClass): string {
  return RISK_LABELS[risk] ?? titleCase(risk);
}

export function isConsequential(risk: RiskClass): boolean {
  return risk === 'destructive' || risk === 'financial' || risk === 'release' || risk === 'external_side_effect';
}
