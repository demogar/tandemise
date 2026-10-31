import type { TaskHoldId } from '@tandemise/shared';

/** What to start for a held task: the runtime's own interactive CLI, resumed in the agent's session. */
export interface InteractiveInvocation {
  readonly file: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
  /** Where the session's transcript lands, so the engine can read the session id after the hold ends. */
  readonly sessionFile: string;
}

/**
 * Owns the interactive processes behind holds. The byte stream (what the person types and sees) lives in the
 * terminal package, not here: the domain only needs to start, ask about and stop a session.
 */
export interface InteractiveSessionsPort {
  available(): { readonly ok: true } | { readonly ok: false; readonly reason: string };
  open(holdId: TaskHoldId, inv: InteractiveInvocation): { readonly pid: number };
  isOpen(holdId: TaskHoldId): boolean;
  /** Ask the process to exit, then kill it after `graceMs`. */
  end(holdId: TaskHoldId, graceMs?: number): Promise<void>;
  /** Called when a session's process exits on its own or via `end`. Returns the unsubscribe. */
  onExit(cb: (holdId: TaskHoldId, code: number | null) => void): () => void;
}
