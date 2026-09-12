import type {
  ApprovalId, ArtifactId, EventId, MissionId, RunId, TaskId, Timestamp, WorkspaceId,
} from '@tandemise/shared';

/**
 * The canonical event vocabulary (MVP.md §10.4).
 *
 * Every runtime adapter normalizes into this shape, which is what lets one
 * mission timeline show Claude Code and any other worker side by side. Adapters
 * translate; they never extend this union - a new event kind is a deliberate
 * change to the organization's vocabulary, not an adapter detail.
 */
export type AgentEvent =
  | { readonly type: 'message'; readonly text: string }
  | { readonly type: 'thinking_summary'; readonly text: string }
  | { readonly type: 'tool.started'; readonly tool: string; readonly inputSummary: string }
  | { readonly type: 'tool.completed'; readonly tool: string; readonly outcome: 'ok' | 'error'; readonly outputSummary?: string }
  | { readonly type: 'file.changed'; readonly path: string; readonly change: 'add' | 'edit' | 'delete' }
  | { readonly type: 'artifact.created'; readonly artifactId: ArtifactId }
  | { readonly type: 'approval.requested'; readonly approvalId: ApprovalId }
  | { readonly type: 'usage'; readonly inputTokens?: number; readonly outputTokens?: number; readonly cacheReadTokens?: number; readonly cacheWriteTokens?: number; readonly costUsd?: number | null }
  | { readonly type: 'checkpoint'; readonly externalSessionId?: string; readonly label?: string }
  | { readonly type: 'completed'; readonly resultRef?: string; readonly summary?: string }
  | { readonly type: 'failed'; readonly code: string; readonly message: string; readonly retryable: boolean }
  /** Adapter could not classify the line; kept for the raw log view only. */
  | { readonly type: 'raw'; readonly channel: 'stdout' | 'stderr'; readonly text: string };

export type AgentEventType = AgentEvent['type'];

/**
 * Orchestration events the daemon itself emits. They share the timeline with
 * agent events so the user sees one causal story rather than two.
 */
export type OrchestrationEvent =
  | { readonly type: 'mission.status'; readonly from: string; readonly to: string; readonly reason?: string }
  | { readonly type: 'task.status'; readonly from: string; readonly to: string; readonly reason?: string }
  | { readonly type: 'run.started'; readonly attempt: number; readonly runtime: string; readonly target: string }
  | { readonly type: 'run.finished'; readonly status: string; readonly durationMs: number }
  | { readonly type: 'check.result'; readonly name: string; readonly outcome: 'PASS' | 'FAIL' | 'SKIP'; readonly detail?: string }
  | { readonly type: 'gate.evaluated'; readonly gate: string; readonly passed: boolean; readonly detail?: string }
  | { readonly type: 'approval.resolved'; readonly approvalId: ApprovalId; readonly status: string; readonly option?: string }
  | { readonly type: 'policy.denied'; readonly capability: string; readonly reason: string }
  | { readonly type: 'note'; readonly text: string; readonly level?: 'info' | 'warn' | 'error' };

export type TandemiseEventBody = AgentEvent | OrchestrationEvent;

/**
 * A persisted event. The append-only log exists for run reconstruction,
 * streaming, debugging and recovery - not as a general event-sourcing substrate
 * (MVP.md §20.3).
 */
export interface RunEventRecord {
  readonly id: EventId;
  readonly workspaceId: WorkspaceId;
  readonly missionId: MissionId;
  readonly taskId: TaskId | null;
  readonly runId: RunId | null;
  readonly sequence: number;
  readonly roleId: string | null;
  readonly runtimeProfileId: string | null;
  readonly body: TandemiseEventBody;
  readonly createdAt: Timestamp;
}

/**
 * Event types shown in the semantic timeline by default. Everything else is
 * available behind the raw log view (MVP.md §23.3) - the default surface should
 * read like a status report, not a terminal.
 */
export const SEMANTIC_EVENT_TYPES: ReadonlySet<string> = new Set([
  'message', 'file.changed', 'artifact.created', 'approval.requested', 'completed',
  'failed', 'mission.status', 'task.status', 'run.started', 'run.finished',
  'check.result', 'gate.evaluated', 'approval.resolved', 'policy.denied', 'note',
  'tool.started',
]);

export function isSemanticEvent(body: TandemiseEventBody): boolean {
  return SEMANTIC_EVENT_TYPES.has(body.type);
}
