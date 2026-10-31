import type { MemberId, MissionId, TaskHoldId, TaskId, Timestamp } from '@tandemise/shared';
import type { AgentEvent } from '../event.js';
import type { Mission } from './mission.js';
import type { MissionTask, TaskStatus } from './task.js';
import { isTaskFinished } from './task.js';

/** How a hold ended: the agent picks the work up again, or the person leaves it as it was. */
export type HoldEnding = 'continued' | 'released';

export interface HoldDiffStat {
  readonly files: number;
  readonly insertions: number;
  readonly deletions: number;
}

/**
 * A person taking the keyboard on an agent step: the same session the agent was in, opened interactively.
 * At most one is open per task; `fromStatus` is where the task goes back to when the hold is released.
 */
export interface TaskHold {
  readonly id: TaskHoldId;
  readonly taskId: TaskId;
  readonly missionId: MissionId;
  readonly heldBy: MemberId;
  readonly fromStatus: TaskStatus;
  readonly runtimeProfileId: string;
  readonly sessionBefore: string | null;
  readonly sessionAfter: string | null;
  readonly ptyPid: number | null;
  readonly startedAt: Timestamp;
  readonly endedAt: Timestamp | null;
  readonly endedBy: MemberId | null;
  readonly ending: HoldEnding | null;
  /** When the agent's next run read what the person did. Null until it has. */
  readonly consumedAt: Timestamp | null;
  readonly diffStat: HoldDiffStat | null;
  /** The hold's working directory under the daemon's home, where its session transcript is kept. */
  readonly dir: string;
}

/**
 * Statuses a hold can start from. Not PENDING (nothing to resume), not a person's or an outside wait, and not
 * finished work: that is a request for changes, not a hold.
 */
export const HOLDABLE_TASK_STATUSES: readonly TaskStatus[] = ['READY', 'RUNNING', 'AWAITING_INPUT', 'AWAITING_APPROVAL'];

export interface HoldRefusalInput {
  readonly task: Pick<MissionTask, 'title' | 'executor' | 'status'>;
  readonly mission: Pick<Mission, 'evalTrialId'>;
  readonly trial: boolean;
  /** Whether the task's run still has a live stream. False while RUNNING means it is on its checks. */
  readonly liveRun: boolean;
  /** For AWAITING_APPROVAL: whether the approval is on finished output, not the start of the step. */
  readonly outputUnderReview: boolean;
  readonly runtimeHasInteractive: boolean;
  readonly openHold: TaskHold | null;
  readonly holderName: string | null;
}

const clock = (iso: Timestamp): string => {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/** Why this task cannot be held right now, in words for the person who asked; null when it can. */
export function holdRefusal(input: HoldRefusalInput): string | null {
  const { task } = input;
  if (task.status === 'SUCCEEDED') return 'This step is done; request changes instead.';
  if (task.executor !== 'agent') return `'${task.title}' is a person's step; there is no agent to hold.`;
  if (input.trial) return "Eval trials can't be held.";
  if (task.status === 'RUNNING' && !input.liveRun) return "It's checking its work. You can hold it once that's done.";
  if (!input.runtimeHasInteractive) return 'Only Claude Code steps can be held for now.';
  if (input.openHold !== null) return `Held by ${input.holderName ?? 'someone'} since ${clock(input.openHold.startedAt)}.`;
  if (task.status === 'AWAITING_APPROVAL' && !input.outputUnderReview) return 'Approve the start first, then you can hold it.';
  if (!HOLDABLE_TASK_STATUSES.includes(task.status)) {
    return isTaskFinished(task.status) ? 'This step has ended and cannot be held.' : `It can't be held while it is ${task.status.toLowerCase().replace(/_/g, ' ')}.`;
  }
  return null;
}

/** One line for the timeline and the step's detail: how a hold ended and what it changed. */
export function describeHoldEnd(hold: Pick<TaskHold, 'ending' | 'diffStat'>): string {
  const how = hold.ending === 'released' ? 'Released without handing back' : hold.ending === 'continued' ? 'Continued by the agent' : 'Still held';
  const d = hold.diffStat;
  if (d === null) return how;
  if (d.files === 0) return `${how}; no files changed.`;
  return `${how}; ${d.files} file${d.files === 1 ? '' : 's'} changed (+${d.insertions} -${d.deletions}).`;
}

const NOW_MAX = 80;
const cut = (text: string): string => (text.length > NOW_MAX ? `${text.slice(0, NOW_MAX - 1)}…` : text);

/**
 * What a tool's `inputSummary` (a redacted, possibly truncated JSON string, see `summarize`) points at.
 * A regex rather than a parse, because a long input is cut mid-JSON.
 */
function inputField(summary: string, names: readonly string[]): string | null {
  for (const name of names) {
    const m = new RegExp(`"${name}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`).exec(summary);
    if (m?.[1] !== undefined && m[1] !== '') return m[1].replace(/\\(["\\])/g, '$1');
  }
  return summary.startsWith('{') ? null : summary || null;
}

/** The "Now" line on a running step: what the agent is doing, from its latest event, never a raw tool name. */
export function nowLine(event: AgentEvent | null, workingDirectory: string | null = null): string {
  if (event === null) return 'Starting…';
  // A path inside the step's own checkout reads relative to it: "Editing src/app/page.tsx", not the worktree's full path.
  const shown = (path: string): string => {
    const root = workingDirectory?.replace(/\/+$/, '') ?? null;
    return root !== null && root !== '' && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
  };
  switch (event.type) {
    case 'tool.started': {
      const tool = event.tool;
      if (tool.startsWith('mcp__tandemise')) return 'Using a Tandemise tool';
      const raw = inputField(event.inputSummary, ['file_path', 'path', 'notebook_path']);
      const path = raw === null ? null : shown(raw);
      switch (tool) {
        case 'Edit': case 'MultiEdit': case 'Write': case 'NotebookEdit':
          return cut(path === null ? 'Editing files' : `Editing ${path}`);
        case 'Read': return cut(path === null ? 'Reading files' : `Reading ${path}`);
        case 'Bash': {
          const cmd = inputField(event.inputSummary, ['command']);
          return cut(cmd === null ? 'Running a command' : `Running ${cmd}`);
        }
        case 'Grep': case 'Glob': return 'Searching the code';
        case 'WebFetch': case 'WebSearch': return 'Looking something up';
        default: return tool.startsWith('mcp__') ? 'Using a tool' : `Using ${tool}`;
      }
    }
    case 'message': case 'thinking_summary': {
      const text = event.text.replace(/\s+/g, ' ').trim();
      return text === '' ? 'Working…' : cut(text);
    }
    case 'file.changed': return cut(`Editing ${shown(event.path)}`);
    default: return 'Working…';
  }
}
