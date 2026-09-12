import type { Logger, RunId, Timestamp, WorkerAssignmentId } from '@tandemise/shared';
import type { Capability, RiskClass } from '@tandemise/domain';
import type { ToolOutcome } from './tool.js';

/**
 * The audit record every tool invocation produces (MVP.md §P7, §22).
 *
 * Emitted for denials and validation failures too - "what was refused" is the
 * half of the record that matters when someone asks why a mission stalled, and
 * a log that only contains successes cannot answer that.
 *
 * `inputSummary` / `outputSummary` are produced with `summarize` from
 * `@tandemise/shared`, so a token echoed by a CLI never reaches the record.
 */
export interface ToolInvocationAudit {
  readonly toolName: string;
  readonly integrationId: string | null;
  readonly capability: Capability;
  readonly risk: RiskClass;
  readonly assignmentId: WorkerAssignmentId;
  readonly runId: RunId | null;
  readonly resource: string | null;
  readonly decision: 'allow' | 'require_approval' | 'deny';
  readonly decisionReason: string;
  /** Null unless the decision was `require_approval`. */
  readonly approved: boolean | null;
  readonly outcome: ToolOutcome;
  readonly inputSummary: string;
  readonly outputSummary: string;
  readonly durationMs: number;
  readonly at: Timestamp;
}

export interface ToolAuditSink {
  record(entry: ToolInvocationAudit): void;
}

/**
 * The default sink. Structured logging already carries correlation fields and
 * redaction, so the cheapest durable audit trail is a log line; a persistence-
 * backed sink can be bound over this one without the broker changing.
 */
export function loggingAuditSink(log: Logger): ToolAuditSink {
  return {
    record: (entry) => {
      const level = entry.decision === 'deny' || entry.outcome === 'error' ? 'warn' : 'info';
      log[level]('tool.invoked', { ...entry });
    },
  };
}

/** Keeps records in memory. For tests and the developer diagnostics surface. */
export class RecordingAuditSink implements ToolAuditSink {
  readonly #entries: ToolInvocationAudit[] = [];

  record(entry: ToolInvocationAudit): void {
    this.#entries.push(entry);
  }

  entries(): readonly ToolInvocationAudit[] {
    return [...this.#entries];
  }
}
