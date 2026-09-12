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
  /**
   * Per-client subscription state.
   *
   * `all` is explicit rather than inferred from an empty set. Overloading
   * "empty" to mean "everything" made `{type:'unsubscribe'}` - which clears the
   * set - silently equivalent to subscribing to every mission, the exact
   * opposite of what the client asked for.
   */
  readonly #subscriptions = new Map<WebSocket, { all: boolean; missions: Set<string> }>();
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
      // A client that has not subscribed to anything specific sees everything;
      // that is what the Home screen needs. It narrows by subscribing.
      this.#subscriptions.set(socket, { all: true, missions: new Set() });
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
        if (msg.missionId) {
          subs.missions.add(msg.missionId);
          subs.all = false;
        } else {
          subs.all = true;
          subs.missions.clear();
        }
        break;
      case 'unsubscribe':
        if (msg.missionId) subs.missions.delete(msg.missionId);
        else { subs.all = false; subs.missions.clear(); }
        break;
      case 'ping':
        this.#send(socket, { type: 'pong', t: msg.t });
        break;
    }
  }

  #broadcastEvent(record: RunEventRecord): void {
    const message: ServerMessage = { type: 'event', record };
    for (const [socket, subs] of this.#subscriptions) {
      if (!subs.all && !subs.missions.has(record.missionId)) continue;
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
