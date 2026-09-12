import { errorMessage, type Logger } from '@tandemise/shared';

/** A component with startup work that must complete before traffic is served. */
export interface Startable {
  readonly name: string;
  start(): Promise<void>;
}

/** A component with shutdown work. Stopped in reverse start order. */
export interface Stoppable {
  readonly name: string;
  stop(): Promise<void>;
}

export type LifecycleComponent = Partial<Startable & Stoppable> & { readonly name: string };

/**
 * Deterministic ordered startup/shutdown.
 *
 * Ordering matters in a supervisor: the database must be open before recovery
 * runs, recovery must finish before the scheduler ticks, and on the way down the
 * scheduler must stop before the processes it supervises are reaped. Encoding
 * that as registration order - rather than as implicit import side effects -
 * keeps "Quit Tandemise" a coordinated shutdown (MVP.md §7.3).
 */
export class LifecycleHost {
  readonly #components: LifecycleComponent[] = [];
  readonly #started: LifecycleComponent[] = [];
  #state: 'idle' | 'starting' | 'running' | 'stopping' | 'stopped' = 'idle';

  constructor(private readonly log: Logger) {}

  add(component: LifecycleComponent): this {
    this.#components.push(component);
    return this;
  }

  get state(): typeof this.n {
    return this.#state as never;
  }
  private declare n: 'idle' | 'starting' | 'running' | 'stopping' | 'stopped';

  async start(): Promise<void> {
    this.#state = 'starting';
    for (const c of this.#components) {
      if (!c.start) { this.#started.push(c); continue; }
      const t0 = Date.now();
      await c.start();
      this.#started.push(c);
      this.log.debug('lifecycle.started', { component: c.name, ms: Date.now() - t0 });
    }
    this.#state = 'running';
  }

  async stop(): Promise<void> {
    if (this.#state === 'stopped' || this.#state === 'stopping') return;
    this.#state = 'stopping';
    for (const c of [...this.#started].reverse()) {
      if (!c.stop) continue;
      try {
        await c.stop();
        this.log.debug('lifecycle.stopped', { component: c.name });
      } catch (e) {
        // A failing shutdown step must not strand the remaining ones.
        this.log.error('lifecycle.stop_failed', { component: c.name, error: errorMessage(e) });
      }
    }
    this.#started.length = 0;
    this.#state = 'stopped';
  }
}
