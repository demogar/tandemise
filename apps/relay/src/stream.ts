import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  RELAY_API_VERSION, relayClientFrame, type ClaimView, type PresenceView, type RelayServerFrame,
} from '@tandemise/api-contract/relay';
import { claimForViewer, type CoordinationStore } from '@tandemise/coordination';
import { assertVersion, authenticate, type Principal } from './auth.js';
import { RelayError, clientIp } from './http.js';
import type { FailedAuthLimiter } from './rate-limit.js';
import type { Log } from './log.js';

const SILENT_CLOSE_MS = 60_000;
/** A revoked device's sockets close with this code. */
export const CLOSE_REVOKED = 4401;

interface Client {
  readonly principal: Principal;
  projects: Set<string> | null;
  lastHeardAt: number;
}

/**
 * The live edge (spec §Protocol, "The stream"). The socket only notifies;
 * correctness comes from HTTP: a client re-reads the snapshot on every
 * (re)connect and on a gap in `seq`. An open socket is presence "online".
 */
export class RelayStreamHub {
  readonly #wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  readonly #clients = new Map<WebSocket, Client>();
  readonly #timer: ReturnType<typeof setInterval>;

  constructor(
    private readonly store: CoordinationStore,
    private readonly limiter: FailedAuthLimiter,
    private readonly log: Log,
  ) {
    this.#timer = setInterval(() => this.#reapSilent(), 10_000);
    this.#timer.unref();
  }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    let principal: Principal;
    try {
      assertVersion(req);
      principal = authenticate(req, this.store, this.limiter, clientIp(req));
    } catch (e) {
      const status = e instanceof RelayError ? e.status : 401;
      socket.write(`HTTP/1.1 ${status} ${status === 412 ? 'Precondition Failed' : status === 429 ? 'Too Many Requests' : 'Unauthorized'}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
      return;
    }
    this.#wss.handleUpgrade(req, socket, head, (ws) => this.#onConnection(ws, principal));
  }

  #onConnection(ws: WebSocket, principal: Principal): void {
    const client: Client = { principal, projects: null, lastHeardAt: Date.now() };
    this.#clients.set(ws, client);
    this.#send(ws, { type: 'hello', apiVersion: RELAY_API_VERSION, seq: this.store.seq(), serverTime: this.store.now() });
    this.#setPresence(principal.device.id, 'online');
    ws.on('message', (raw) => this.#onMessage(ws, client, raw.toString()));
    ws.on('close', () => this.#onClose(ws, client));
    ws.on('error', () => this.#onClose(ws, client));
  }

  #onMessage(ws: WebSocket, client: Client, raw: string): void {
    client.lastHeardAt = Date.now();
    let parsed;
    try {
      parsed = relayClientFrame.safeParse(JSON.parse(raw));
    } catch {
      return;
    }
    if (!parsed.success) return;
    const frame = parsed.data;
    if (frame.type === 'ping') this.#send(ws, { type: 'pong', t: frame.t });
    else if (frame.type === 'watch') client.projects = new Set(frame.projects);
    else if (frame.type === 'presence') this.#setPresence(client.principal.device.id, frame.status);
  }

  #onClose(ws: WebSocket, client: Client): void {
    if (!this.#clients.delete(ws)) return;
    const deviceId = client.principal.device.id;
    const stillOpen = [...this.#clients.values()].some((c) => c.principal.device.id === deviceId);
    if (stillOpen) return;
    try {
      this.store.clearPresence(deviceId);
      this.broadcastMembers();
    } catch (e) {
      this.log('warn', 'stream.presence_clear_failed', { error: String(e) });
    }
  }

  #setPresence(deviceId: string, status: 'online' | 'away'): void {
    try {
      const view = this.store.setPresence(deviceId, status);
      this.broadcastPresence(view);
    } catch (e) {
      this.log('warn', 'stream.presence_failed', { error: String(e) });
    }
  }

  #reapSilent(): void {
    const now = Date.now();
    for (const [ws, c] of this.#clients) {
      if (now - c.lastHeardAt > SILENT_CLOSE_MS) ws.close(4408, 'silent for 60 s');
    }
  }

  #send(ws: WebSocket, frame: RelayServerFrame): void {
    if (ws.readyState !== ws.OPEN) return;
    try {
      ws.send(JSON.stringify(frame));
    } catch {
      /* the close handler cleans up */
    }
  }

  broadcastClaim(claim: ClaimView): void {
    for (const [ws, c] of this.#clients) {
      if (c.projects !== null && !c.projects.has(claim.projectKey)) continue;
      this.#send(ws, { type: 'claim', seq: claim.seq, claim: claimForViewer(claim, c.principal.memberId) });
    }
  }

  broadcastPresence(presence: PresenceView): void {
    const seq = this.store.seq();
    for (const ws of this.#clients.keys()) this.#send(ws, { type: 'presence', seq, presence });
  }

  /** Members, devices or presence changed in a way a frame can't carry: re-read the snapshot. */
  broadcastMembers(): void {
    const seq = this.store.seq();
    for (const ws of this.#clients.keys()) this.#send(ws, { type: 'members', seq });
  }

  mailboxHint(project: string, pending: number): void {
    for (const [ws, c] of this.#clients) {
      if (c.projects !== null && !c.projects.has(project)) continue;
      this.#send(ws, { type: 'mailbox', project, pending });
    }
  }

  /** Revocation is immediate: the device's sockets close now, with 4401. */
  closeDevice(deviceId: string): void {
    for (const [ws, c] of this.#clients) {
      if (c.principal.device.id === deviceId) {
        this.#clients.delete(ws);
        ws.close(CLOSE_REVOKED, 'device revoked');
      }
    }
  }

  get size(): number {
    return this.#clients.size;
  }

  close(): void {
    clearInterval(this.#timer);
    for (const ws of this.#clients.keys()) ws.close(1001, 'relay shutting down');
    this.#clients.clear();
    this.#wss.close();
  }
}
