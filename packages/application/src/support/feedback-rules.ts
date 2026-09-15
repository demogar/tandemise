import type { Approval, ArtifactHandoff, ArtifactType, LoadedArtifact, Mission, MissionTask, RunRepositoryPort } from '@tandemise/domain';
import { canTransition, citedFeedbackIds, isTerminalMissionStatus } from '@tandemise/domain';
import { isOutputApproval } from './approval-view.js';

/** What a note does to its task, by the task's state (spec §2). */
export type FeedbackEffect =
  /** RUNNING, AWAITING_INPUT: delivered when the current pass ends. */
  | { readonly kind: 'queue' }
  /** PENDING, READY, AWAITING_HUMAN, and AWAITING_APPROVAL on a start card: read by the round that comes. */
  | { readonly kind: 'attach' }
  /** AWAITING_APPROVAL with an output card: the card is decided "Request changes" and the next round starts. */
  | { readonly kind: 'review'; readonly card: Approval }
  /** SUCCEEDED: the downstream impact comes first. */
  | { readonly kind: 'reopen' }
  /** FAILED, BLOCKED, CANCELLED, SKIPPED: the next attempt is a round carrying the note. */
  | { readonly kind: 'round_now' };

/**
 * Spec §2's table as one function, so the service, and later the executor and
 * the review pipeline, never disagree about what a note does.
 */
export function feedbackEffectFor(
  task: MissionTask,
  pending: readonly Approval[],
  runs: Pick<RunRepositoryPort, 'listByTask'>,
): FeedbackEffect {
  switch (task.status) {
    case 'RUNNING':
    case 'AWAITING_INPUT':
      return { kind: 'queue' };
    case 'AWAITING_APPROVAL': {
      // A start card means nothing has run yet: the note waits for round 1 like any other.
      const card = pending.find((a) => isOutputApproval(a, task, runs));
      return card === undefined ? { kind: 'attach' } : { kind: 'review', card };
    }
    case 'SUCCEEDED':
      return { kind: 'reopen' };
    case 'FAILED':
    case 'BLOCKED':
    case 'CANCELLED':
    case 'SKIPPED':
      return { kind: 'round_now' };
    default:
      return { kind: 'attach' };
  }
}

/** What a person is told when a mission can take no more rounds. */
export const CLOSED_MISSION_MESSAGE = 'This mission was cancelled; start a new mission to continue this work.';

/**
 * Whether a note can still start or join a round. A mission that ended can be
 * reopened by a round (a completed or failed one goes back to executing), but
 * a cancelled one cannot: its round would start and never run.
 */
export function missionTakesRounds(mission: Pick<Mission, 'status'>): boolean {
  return !isTerminalMissionStatus(mission.status) || canTransition(mission.status, 'EXECUTING');
}

/** One note as a round's brief shows it. */
export interface BriefItem {
  readonly id: string;
  readonly authorName: string;
  readonly text: string;
  /** The output the note is about; null for the whole task. */
  readonly artifactType: ArtifactType | null;
  readonly round: number | null;
}

/** What a pass that carries feedback is asked to do (spec §5). */
export interface RoundBrief {
  readonly round: number;
  /** In round now: must be cited. */
  readonly toAddress: readonly BriefItem[];
  /** Addressed already, in an earlier round or earlier in this one: context only. */
  readonly earlier: readonly BriefItem[];
  /**
   * Set when nothing is owed because an upstream round redid this task: the
   * task and round whose new version it now has to follow.
   */
  readonly redoneAfter?: { readonly key: string; readonly round: number } | null;
  /** This task's own newest output per type, read from the store; empty before it has any. */
  readonly previous: readonly LoadedArtifact[];
  /** Notes delivered to a pass that had already started, rather than before it. */
  readonly delivery?: boolean;
}

/** What the harvest holds a pass's handoffs to, when the pass carries feedback. */
export interface RoundContract {
  readonly round: number;
  readonly required: readonly { readonly id: string; readonly artifactType: ArtifactType | null }[];
  /** Every feedback id on the task: citing anything else is an error. */
  readonly known: ReadonlySet<string>;
  /** Where a note about the whole task must be cited: the task's first expected output. */
  readonly primaryType: ArtifactType;
}

/**
 * The most of a draft a fresh prompt quotes. The file stays on disk in full,
 * so a long draft is cut for the prompt, on a line, and edited in place.
 */
export const MAX_DRAFT_CHARS = 20_000;

export function capDraft(body: string): string {
  if (body.length <= MAX_DRAFT_CHARS) return body;
  const room = body.slice(0, MAX_DRAFT_CHARS);
  const line = room.lastIndexOf('\n');
  return `${line > 0 ? room.slice(0, line) : room}\n(draft truncated for length; edit the file in place)`;
}

/**
 * The P1 handoff contract tightened for a pass that carries feedback (spec §5):
 * each note owed by this artifact is cited, and nothing unknown is. Problems
 * come back worded for the retry prompt, naming the ids still owed.
 */
export function checkRoundHandoff(type: ArtifactType, handoff: Pick<ArtifactHandoff, 'changed'> | null, contract: RoundContract): readonly string[] {
  const owed = contract.required.filter((r) => (r.artifactType ?? contract.primaryType) === type);
  const cited = citedFeedbackIds(handoff);
  const problems: string[] = [];
  if (owed.length > 0 && (handoff?.changed.length ?? 0) === 0) problems.push('handoff.changed must have at least one entry');
  const unknown = cited.filter((id) => !contract.known.has(id));
  if (unknown.length > 0) problems.push(`handoff.changed cites feedback that is not on this task: ${unknown.join(', ')}`);
  const missing = owedUncited(type, handoff, contract);
  if (missing.length > 0) {
    problems.push(`handoff.changed must cite ${missing.join(', ')}: address each one, or decline it with what: "Declined: <reason>"`);
  }
  return problems;
}

/** The ids of the notes this artifact owes and does not cite. */
export function owedUncited(type: ArtifactType, handoff: Pick<ArtifactHandoff, 'changed'> | null, contract: RoundContract): readonly string[] {
  const cited = citedFeedbackIds(handoff);
  return contract.required.filter((r) => (r.artifactType ?? contract.primaryType) === type && !cited.includes(r.id)).map((r) => r.id);
}

/** Continuation lines are indented so a multi-line note stays one numbered item. */
const oneItem = (text: string): string => text.trim().replace(/\n+/g, '\n   ');

/**
 * The brief, framed as the owner's request and never as a failed check: an
 * author told they failed rewrites from scratch, and a round is an edit (the
 * P0 lesson).
 */
export function renderRoundBrief(brief: RoundBrief, destination: (type: ArtifactType) => string): string {
  // Nothing owed outside a delivery pass: the pass is a later round going again
  // because its input changed (or a retry of one), not a request. Saying people
  // asked for changes, with an empty list to cite, would send the author looking
  // for notes that do not exist.
  const owed = brief.toAddress.length > 0 || brief.delivery === true;
  const lines: string[] = [
    brief.delivery === true
      ? 'While you worked, the people this work is for left notes on this task. This is their request, not a failed check.'
      : !owed
        ? brief.redoneAfter
          ? `Work this builds on changed: '${brief.redoneAfter.key}' round ${brief.redoneAfter.round}. Update your previous output to match; keep what still applies.`
          : `This is round ${brief.round} of this task. Update your previous output; keep what still applies.`
      : brief.round > 1
        ? `This is round ${brief.round} of this task. The people this work is for read your previous output and asked for changes. This is their request, not a failed check.`
        // A retry in round 1 that already has output was asked for changes to it, not left notes before it began.
        : brief.previous.length > 0
          ? 'The people this work is for left notes on this task. This is their request, not a failed check.'
          : 'Before you started, the people this work is for left notes on this task. This is their request, not a failed check.',
  ];
  if (brief.previous.length > 0) {
    lines.push('', 'Your previous output:');
    for (const draft of brief.previous) {
      lines.push('', `${draft.manifest.type}, to edit and write back to \`${destination(draft.manifest.type)}\`:`, '', '````markdown', capDraft(draft.body.trimEnd()), '````');
    }
  }
  if (owed) {
    lines.push('', 'Feedback to address:',
      ...brief.toAddress.map((item, i) => `${i + 1}. ${item.id} (${item.authorName}): ${oneItem(item.text)}${item.artifactType === null ? '' : ` [about the ${item.artifactType}]`}`));
  }
  if (brief.earlier.length > 0) {
    lines.push('', 'Addressed already, for context. Do not undo these:',
      ...brief.earlier.map((item) => `- ${item.id} (${item.authorName}, round ${item.round}): ${oneItem(item.text)}`));
  }
  if (!owed) return lines.join('\n');
  lines.push('',
    'Edit your previous output; do not rewrite it. Keep everything nobody asked to change.',
    'In the handoff, fill `changed` with one entry per change and set its `feedback` to the id it answers. One entry may answer several ids, separated by commas; `changed` holds at most 3 entries.',
    'Cite every item under "Feedback to address": either address it, or decline it with `what: "Declined: <reason>"`.');
  return lines.join('\n');
}

/**
 * What a continued session is told: the same brief, plus where to write.
 *
 * A round's folder is emptied before its run, so the session is asked to
 * write each file back in full from the inlined draft; only a delivery pass,
 * which follows its own run in the same folder, finds the files still there.
 */
export function roundRequest(brief: RoundBrief, destinations: readonly string[], options: { readonly inPlace?: boolean } = {}): string {
  const paths = destinations.map((d) => `\`${d}\``).join(', ');
  return [
    renderRoundBrief(brief, (type) => destinations.find((d) => d.endsWith(`/${type}.md`)) ?? `${type}.md`),
    '',
    options.inPlace === true
      ? `Edit the files in place (${paths}) and keep their front matter valid.`
      : `Write each file back in full (${paths}), starting from the draft above, front matter included.`,
  ].join('\n');
}
