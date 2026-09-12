import type { IncomingMessage } from 'node:http';
import type { Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Logger } from '@tandemise/shared';
import type { EventBusPort, ProjectionBusPort, RunEventRecord } from '@tandemise/domain';
import type { ClientMessage, ServerMessage } from '@tandemise/api-contract';
import { API_VERSION } from '@tandemise/api-contract';

/**
 * The live update socket (MVP.md §7.2).
 *
 * Deliberately dumb: it forwards durable events and invalidation signals and
 * holds no state a client could lose. Each client declares which mission it is
 * watching so a busy mission does not push its firehose at a window showing the
 * settings screen; everything else (approvals, runtime health) is broadcast,
 * because those matter regardless of which screen is open.
 */
export class StreamServer {
  readonly #wss: WebSocketServer;
  readonly #subscriptions = new Map<WebSocket, Set<string>>();
  readonly #log: Logger;
  #unsubscribe: Array<() => void> = [];

  constructor(opts: {
    server: Server;
    log: Logger;
    daemonVersion: string;
    events: EventBusPort;
    projections: ProjectionBusPort;
  }) {
    this.#log = opts.log.child({ component: 'stream' });
    this.#wss = new WebSocketServer({ noServer: true });

    this.#wss.on('connection', (socket: WebSocket) => {
      this.#subscriptions.set(socket, new Set());
      this.#send(socket, {
        type: 'hello',
        apiVersion: API_VERSION,
        daemonVersion: opts.daemonVersion,
        serverTime: new Date().toISOString(),
      });

      socket.on('message', (raw) => this.#onMessage(socket, raw.toString()));
      socket.on('close', () => this.#subscriptions.delete(socket));
      socket.on('error', (e) => {
        this.#log.debug('stream.socket_error', { error: String(e) });
        this.#subscriptions.delete(socket);
      });
    });

    this.#unsubscribe.push(
      opts.events.subscribe((record) => this.#broadcastEvent(record)),
      opts.projections.subscribe((topic, scope) =>
        this.#broadcast({ type: 'invalidate', topic, ...(scope.missionId ? { missionId: scope.missionId } : {}) }),
      ),
    );
  }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.#wss.handleUpgrade(req, socket, head, (ws) => {
      this.#wss.emit('connection', ws, req);
    });
  }

  get clientCount(): number {
    return this.#subscriptions.size;
  }

  close(): void {
    for (const off of this.#unsubscribe) off();
    this.#unsubscribe = [];
    for (const socket of this.#subscriptions.keys()) socket.close(1001, 'daemon shutting down');
    this.#subscriptions.clear();
    this.#wss.close();
  }

  #onMessage(socket: WebSocket, raw: string): void {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw) as ClientMessage;
    } catch {
      this.#send(socket, { type: 'error', code: 'VALIDATION', message: 'Malformed message.' });
      return;
    }
    const subs = this.#subscriptions.get(socket);
    if (!subs) return;

    switch (msg.type) {
      case 'subscribe':
        if (msg.missionId) subs.add(msg.missionId);
        break;
      case 'unsubscribe':
        if (msg.missionId) subs.delete(msg.missionId);
        else subs.clear();
        break;
      case 'ping':
        this.#send(socket, { type: 'pong', t: msg.t });
        break;
    }
  }

  #broadcastEvent(record: RunEventRecord): void {
    const message: ServerMessage = { type: 'event', record };
    for (const [socket, subs] of this.#subscriptions) {
      if (subs.size > 0 && !subs.has(record.missionId)) continue;
      this.#send(socket, message);
    }
  }

  #broadcast(message: ServerMessage): void {
    for (const socket of this.#subscriptions.keys()) this.#send(socket, message);
  }

  #send(socket: WebSocket, message: ServerMessage): void {
    if (socket.readyState !== socket.OPEN) return;
    try {
      socket.send(JSON.stringify(message));
    } catch (e) {
      this.#log.debug('stream.send_failed', { error: String(e) });
    }
  }
}
