import { WebSocket } from 'ws';
import { RELAY_API_HEADER, RELAY_API_VERSION, RELAY_STREAM_PATH, type RelayClientFrame, type RelayServerFrame } from '@tandemise/api-contract/relay';

const PING_EVERY_MS = 20_000;

export interface RelayStreamEvents {
  open(): void;
  frame(frame: RelayServerFrame): void;
  /** `code` 4401 means this device was revoked. */
  close(code: number): void;
}

/**
 * One WebSocket to the relay. The device token goes in the `Authorization`
 * header of the handshake, never in the URL; Node's `ws` sets handshake
 * headers, which the global WebSocket can't. Pings every 20 s. It does not
 * reconnect by itself: the owner decides when, with backoff.
 */
export class RelayStream {
  #ws: WebSocket | null = null;
  #ping: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly baseUrl: string, private readonly events: RelayStreamEvents) {}

  get open(): boolean {
    return this.#ws?.readyState === WebSocket.OPEN;
  }

  /** Opens the socket; resolves once it is open or has failed (never rejects). */
  connect(token: string): Promise<boolean> {
    this.close();
    let settle: (open: boolean) => void = () => {};
    const settled = new Promise<boolean>((resolve) => { settle = resolve; });
    const url = `${this.baseUrl.replace(/^http/, 'ws')}${RELAY_STREAM_PATH}`;
    const ws = new WebSocket(url, { headers: { authorization: `Bearer ${token}`, [RELAY_API_HEADER]: RELAY_API_VERSION }, handshakeTimeout: 10_000 });
    this.#ws = ws;
    ws.on('open', () => {
      this.#ping = setInterval(() => this.send({ type: 'ping', t: Date.now() }), PING_EVERY_MS);
      this.#ping.unref?.();
      this.events.open();
      settle(true);
    });
    ws.on('message', (raw) => {
      try {
        this.events.frame(JSON.parse(raw.toString()) as RelayServerFrame);
      } catch {
        /* a malformed frame is dropped; correctness comes from the snapshot */
      }
    });
    let closed = false;
    const onClose = (code: number): void => {
      if (closed) return;
      closed = true;
      if (this.#ping) clearInterval(this.#ping);
      this.#ping = null;
      if (this.#ws === ws) this.#ws = null;
      settle(false);
      this.events.close(code);
    };
    ws.on('close', (code) => onClose(code));
    ws.on('error', () => onClose(1006));
    ws.on('unexpected-response', (_req, res) => onClose(res.statusCode === 401 ? 4401 : 1006));
    return settled;
  }

  send(frame: RelayClientFrame): void {
    if (this.#ws?.readyState === WebSocket.OPEN) this.#ws.send(JSON.stringify(frame));
  }

  close(): void {
    const ws = this.#ws;
    this.#ws = null;
    if (this.#ping) clearInterval(this.#ping);
    this.#ping = null;
    if (ws) {
      ws.removeAllListeners();
      ws.on('error', () => {});
      ws.terminate();
    }
  }
}
