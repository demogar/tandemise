import type { WorkerAssignmentId } from '@tandemise/shared';

/**
 * The longest one run may spend parked on people, in total.
 *
 * Long enough for a question asked at the end of a working day to be answered
 * the next morning. Past it, the worker is told it got no answer and carries on
 * with its own judgement - a stale question is worse than a recorded
 * assumption, and a process held idle for days is fragile in ways nothing here
 * can repair (a laptop lid, a reboot).
 */
export const MAX_PARKED_MS = 24 * 60 * 60 * 1000;

/**
 * A run's wall-time budget, with a clock that stops while a person is thinking.
 *
 * The budget exists to stop a runaway agent, and time a worker spends blocked
 * inside `ask_human` is provably not agent work: the process is waiting on a
 * socket and consuming nothing. A plain `AbortSignal.timeout` counts that time
 * anyway, so a twenty-minute budget would kill any worker whose question was
 * not answered within twenty minutes - which makes asking unusable exactly when
 * the person is away, the only case where it matters.
 *
 * Pauses nest, because a runtime may issue parallel tool calls and two of them
 * can be questions. The clock restarts only when the last one is answered.
 */
export class RunDeadline {
  readonly #controller = new AbortController();
  #remainingMs: number;
  #runningSince: number | null;
  #timer: NodeJS.Timeout | undefined;
  #pauses = 0;
  #parkedSince: number | null = null;
  #parkedMs = 0;
  #expired = false;

  constructor(
    budgetMs: number,
    private readonly maxParkedMs: number = MAX_PARKED_MS,
    private readonly now: () => number = Date.now,
  ) {
    this.#remainingMs = Math.max(1, budgetMs);
    this.#runningSince = now();
    this.#arm();
  }

  /** Aborts when the unparked budget is spent. Never aborts while parked. */
  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  /** True once the budget was exhausted, as opposed to the run being stopped. */
  get expired(): boolean {
    return this.#expired;
  }

  get parked(): boolean {
    return this.#pauses > 0;
  }

  /** Stops the clock. Returns how much of the park allowance is left. */
  pause(): number {
    this.#pauses++;
    if (this.#pauses === 1 && !this.#expired) {
      clearTimeout(this.#timer);
      this.#remainingMs -= this.now() - (this.#runningSince ?? this.now());
      this.#runningSince = null;
      this.#parkedSince = this.now();
    }
    return this.parkAllowanceMs();
  }

  /** Restarts the clock once every pause has been released. */
  resume(): void {
    if (this.#pauses === 0) return;
    this.#pauses--;
    if (this.#pauses > 0 || this.#expired) return;
    this.#parkedMs += this.now() - (this.#parkedSince ?? this.now());
    this.#parkedSince = null;
    this.#runningSince = this.now();
    this.#arm();
  }

  parkAllowanceMs(): number {
    const current = this.#parkedSince === null ? 0 : this.now() - this.#parkedSince;
    return Math.max(0, this.maxParkedMs - this.#parkedMs - current);
  }

  dispose(): void {
    clearTimeout(this.#timer);
  }

  #arm(): void {
    clearTimeout(this.#timer);
    if (this.#remainingMs <= 0) {
      this.#expire();
      return;
    }
    this.#timer = setTimeout(() => this.#expire(), this.#remainingMs);
    // A generous budget on a fast run must not hold the daemon's event loop open.
    this.#timer.unref();
  }

  #expire(): void {
    if (this.#expired) return;
    this.#expired = true;
    this.#controller.abort(new Error('The run exhausted its wall-time budget.'));
  }
}

/**
 * The live deadlines in this process, by worker assignment.
 *
 * The executor owns each deadline; `ask_human` needs to stop the clock on the
 * run it was called from and knows only the assignment. Keyed by assignment
 * rather than task because an assignment is one attempt, and pausing a
 * previous attempt's clock would be meaningless.
 *
 * Nothing here is persisted. A daemon restart ends every run it was driving,
 * and a deadline for a run that no longer exists has nothing to stop.
 */
export class RunDeadlines {
  readonly #live = new Map<WorkerAssignmentId, RunDeadline>();

  constructor(private readonly options: { readonly maxParkedMs?: number } = {}) {}

  open(assignmentId: WorkerAssignmentId, budgetMs: number): RunDeadline {
    const deadline = new RunDeadline(budgetMs, this.options.maxParkedMs ?? MAX_PARKED_MS);
    this.#live.set(assignmentId, deadline);
    return deadline;
  }

  close(assignmentId: WorkerAssignmentId): void {
    this.#live.get(assignmentId)?.dispose();
    this.#live.delete(assignmentId);
  }

  /**
   * Stops the run's clock and returns the park allowance left, or `null` when
   * no run in this process holds that assignment - a tool invoked outside a
   * live attempt, in a test.
   */
  pause(assignmentId: WorkerAssignmentId): number | null {
    return this.#live.get(assignmentId)?.pause() ?? null;
  }

  /**
   * Restarts the run's clock. `running` means the run is live and no other
   * question is open; `parked` that another still is; `gone` that the run this
   * assignment belonged to has already ended.
   */
  resume(assignmentId: WorkerAssignmentId): 'running' | 'parked' | 'gone' {
    const deadline = this.#live.get(assignmentId);
    if (deadline === undefined) return 'gone';
    deadline.resume();
    return deadline.parked ? 'parked' : 'running';
  }
}
