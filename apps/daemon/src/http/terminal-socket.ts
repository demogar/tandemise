import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import type { Logger, TaskHoldId, TaskId } from '@tandemise/shared';
import { asId } from '@tandemise/shared';
import type { HoldService } from '@tandemise/application';
import type { PtyHost } from '@tandemise/terminal';

/** A keystroke burst or a paste; anything larger is not typing. */
const MAX_INPUT_BYTES = 1024 * 1024;

/**
 * The terminal of a held task, at `/v1/tasks/:id/terminal` (hold-and-interact
 * spec, "The terminal").
 *
 * Binary frames are raw terminal bytes both ways; text frames are JSON
 * control: `resize` from the window, `exit` and `error` from the daemon. A
 * window attaches to the PTY the hold already opened and gets its scrollback
 * first, so a reconnect repaints. Closing the window only detaches it; the
 * PTY, and the hold, carry on. Authentication happened in the HTTP server
 * before the upgrade reached here.
 */
export class TerminalSocketServer {
  readonly #wss: WebSocketServer;
  readonly #holds: Pick<HoldService, 'terminalFor'>;
  readonly #host: Pick<PtyHost, 'attach' | 'write' | 'resize'>;
  readonly #log: Logger;

  constructor(opts: {
    readonly holds: Pick<HoldService, 'terminalFor'>;
    readonly host: Pick<PtyHost, 'attach' | 'write' | 'resize'>;
    readonly log: Logger;
  }) {
    this.#holds = opts.holds;
    this.#host = opts.host;
    this.#log = opts.log.child({ component: 'terminal-socket' });
    this.#wss = new WebSocketServer({ noServer: true, maxPayload: MAX_INPUT_BYTES });
  }

  /** `path` is the authenticated `/v1/tasks/:id/terminal`. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, path: string): void {
    const taskId = asId<'TaskId'>(decodeURIComponent(path.split('/')[3] ?? ''));
    this.#wss.handleUpgrade(req, socket, head, (ws) => this.#connected(ws, taskId));
  }

  close(): void {
    for (const ws of this.#wss.clients) ws.close(1001, 'daemon shutting down');
    this.#wss.close();
  }

  #connected(ws: WebSocket, taskId: TaskId): void {
    const holdId = this.#holds.terminalFor(taskId);
    if (holdId === null) {
      this.#control(ws, { type: 'error', message: 'This step has no open terminal. Hold it, or open its terminal again.' });
      ws.close(1000);
      return;
    }
    ws.on('error', (e) => this.#log.debug('terminal.socket_error', { taskId, error: String(e) }));
    const detach = this.#host.attach(holdId, {
      data: (chunk) => {
        if (ws.readyState === ws.OPEN) ws.send(chunk, { binary: true });
      },
      // Also what a window gets when the session ended before it attached.
      exit: (code) => {
        this.#control(ws, { type: 'exit', code });
        ws.close(1000);
      },
    });
    ws.on('message', (data, isBinary) => this.#input(holdId, data, isBinary));
    ws.on('close', () => detach());
  }

  #input(holdId: TaskHoldId, data: RawData, isBinary: boolean): void {
    const bytes = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
    if (isBinary) {
      this.#host.write(holdId, bytes);
      return;
    }
    let message: unknown;
    try {
      message = JSON.parse(bytes.toString('utf8'));
    } catch {
      return;
    }
    const m = message as { type?: unknown; cols?: unknown; rows?: unknown };
    if (m.type === 'resize' && typeof m.cols === 'number' && typeof m.rows === 'number') {
      this.#host.resize(holdId, m.cols, m.rows);
    }
  }

  #control(ws: WebSocket, message: { type: 'exit'; code: number | null } | { type: 'error'; message: string }): void {
    if (ws.readyState !== ws.OPEN) return;
    try {
      ws.send(JSON.stringify(message));
    } catch (e) {
      this.#log.debug('terminal.send_failed', { error: String(e) });
    }
  }
}
