import { createRequire } from 'node:module';
import type { InteractiveInvocation, InteractiveSessionsPort } from '@tandemise/domain';
import type { TaskHoldId } from '@tandemise/shared';
import { Scrollback } from './scrollback.js';

/** Who is watching a session: raw terminal bytes out, and the exit when it ends. */
export interface TerminalSink {
  data(chunk: Buffer): void;
  exit(code: number | null): void;
}

// The slice of node-pty we use. It is loaded lazily, so this stays structural.
interface PtyProcess {
  readonly pid: number;
  onData(cb: (data: string) => void): unknown;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): unknown;
  write(data: string | Buffer): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}
interface PtyModule {
  spawn(file: string, args: string[], opts: Record<string, unknown>): PtyProcess;
}

interface Session {
  readonly pty: PtyProcess;
  readonly scrollback: Scrollback;
  readonly sinks: Set<TerminalSink>;
  exited: boolean;
  readonly exitWaiters: Array<() => void>;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Owns the pseudo-terminals behind held tasks. The byte stream is deliberately
 * not part of the domain port: windows attach to it through the daemon socket.
 */
export class PtyHost implements InteractiveSessionsPort {
  readonly #sessions = new Map<string, Session>();
  readonly #exitListeners = new Set<(holdId: TaskHoldId, code: number | null) => void>();
  #pty: PtyModule | null = null;
  #loadError: string | null = null;
  #loadTried = false;

  available(): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
    this.#load();
    if (this.#pty) return { ok: true };
    return { ok: false, reason: `The terminal component didn't load on this machine (${this.#loadError}).` };
  }

  open(holdId: TaskHoldId, inv: InteractiveInvocation): { readonly pid: number } {
    const pty = this.#load();
    if (!pty) throw new Error(`The terminal component didn't load on this machine (${this.#loadError}).`);
    if (this.#sessions.has(holdId)) throw new Error(`Session ${holdId} is already open`);
    const proc = pty.spawn(inv.file, [...inv.args], {
      name: 'xterm-256color',
      cwd: inv.cwd,
      env: { ...inv.env },
      cols: 120,
      rows: 32,
    });
    const session: Session = { pty: proc, scrollback: new Scrollback(), sinks: new Set(), exited: false, exitWaiters: [] };
    this.#sessions.set(holdId, session);
    proc.onData((text) => {
      const chunk = Buffer.from(text, 'utf8');
      session.scrollback.push(chunk);
      for (const sink of [...session.sinks]) sink.data(chunk);
    });
    proc.onExit(({ exitCode }) => {
      session.exited = true;
      this.#sessions.delete(holdId);
      for (const sink of [...session.sinks]) sink.exit(exitCode);
      session.sinks.clear();
      for (const w of session.exitWaiters) w();
      for (const cb of [...this.#exitListeners]) cb(holdId, exitCode);
    });
    return { pid: proc.pid };
  }

  isOpen(holdId: TaskHoldId): boolean {
    return this.#sessions.has(holdId);
  }

  /** Replays the scrollback to the sink, then streams. Returns the detach function; detaching never closes the PTY. */
  attach(holdId: TaskHoldId, sink: TerminalSink): () => void {
    const session = this.#sessions.get(holdId);
    if (!session) {
      sink.exit(null);
      return () => {};
    }
    const replay = session.scrollback.snapshot();
    if (replay.length > 0) sink.data(replay);
    session.sinks.add(sink);
    return () => {
      session.sinks.delete(sink);
    };
  }

  write(holdId: TaskHoldId, data: string | Buffer): void {
    this.#sessions.get(holdId)?.pty.write(data);
  }

  resize(holdId: TaskHoldId, cols: number, rows: number): void {
    const session = this.#sessions.get(holdId);
    if (!session || !(cols > 0) || !(rows > 0)) return;
    try {
      session.pty.resize(Math.floor(cols), Math.floor(rows));
    } catch {
      // The process may have just exited; a late resize is harmless.
    }
  }

  /** Ask politely with `/exit`, then SIGTERM after `graceMs`, then SIGKILL after another `graceMs`. */
  async end(holdId: TaskHoldId, graceMs = 3000): Promise<void> {
    const session = this.#sessions.get(holdId);
    if (!session) return;
    const gone = new Promise<void>((resolve) => session.exitWaiters.push(resolve));
    const waitFor = async (ms: number): Promise<boolean> =>
      Promise.race([gone.then(() => true), sleep(ms).then(() => session.exited)]);
    try {
      session.pty.write('/exit\r');
    } catch {
      // Already gone; fall through to the kills.
    }
    if (await waitFor(graceMs)) return;
    try { session.pty.kill('SIGTERM'); } catch { /* exited meanwhile */ }
    if (await waitFor(graceMs)) return;
    try { session.pty.kill('SIGKILL'); } catch { /* exited meanwhile */ }
    await waitFor(graceMs);
  }

  onExit(cb: (holdId: TaskHoldId, code: number | null) => void): () => void {
    this.#exitListeners.add(cb);
    return () => {
      this.#exitListeners.delete(cb);
    };
  }

  /** Ends every open session. For daemon shutdown. */
  async endAll(graceMs = 1000): Promise<void> {
    await Promise.all([...this.#sessions.keys()].map((id) => this.end(id as TaskHoldId, graceMs)));
  }

  // node-pty is native: a failed load must never break importing this package,
  // so it is required on first use and the failure is reported by `available()`.
  #load(): PtyModule | null {
    if (this.#pty || this.#loadTried) return this.#pty;
    this.#loadTried = true;
    try {
      this.#pty = createRequire(import.meta.url)('node-pty') as PtyModule;
    } catch (e) {
      this.#loadError = e instanceof Error ? e.message : String(e);
    }
    return this.#pty;
  }
}
