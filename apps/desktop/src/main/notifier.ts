import { Notification, type BrowserWindow } from 'electron';
import { appendFileSync } from 'node:fs';
import type { DaemonConnector } from './daemon-connection.js';
import type { NotificationOpen } from '../shared/bridge.js';

/** One notice as the daemon's `POST /v1/notifications/take` returns it (P16). */
interface Notice {
  readonly title: string;
  readonly body: string;
  readonly route: string;
  readonly workspaceId: string | null;
  readonly ids: readonly string[];
  readonly shape: string;
}

/** What the test hook records for every notification shown. */
export interface NotificationRecord extends Notice {
  readonly at: string;
  /** From the Settings button, not from the Inbox. */
  readonly test: boolean;
  /** The window was hidden or not focused when it was shown. */
  readonly windowVisible: boolean;
}

const POLL_MS = Number(process.env['TANDEMISE_NOTIFY_POLL_MS'] ?? '') || 5_000;
/** Test hook: every notice is appended to this file as one JSON line, and the debug IPC is enabled. */
const RECORD_FILE = process.env['TANDEMISE_NOTIFY_RECORD'] ?? null;

export const TEST_NOTICE = {
  title: 'Notifications are on',
  body: 'This is how Tandemise will tell you something needs you.',
} as const;

/**
 * Asks the daemon what is new in the Inbox and shows it (P16 spec §3).
 *
 * Lives in the main process so it keeps working while the window is hidden or
 * closed to the tray. The daemon decides what to announce and records it; this
 * class only reports whether the person is already looking at the Inbox, and
 * shows what comes back.
 */
export class Notifier {
  #timer: NodeJS.Timeout | null = null;
  #busy = false;
  #paused = false;
  /** Test override for "is the window focused": a window driven over CDP may not have OS focus. */
  #focusOverride: boolean | null = null;
  readonly #records: NotificationRecord[] = [];
  /** Kept referenced until closed: a garbage-collected Notification loses its click handler. */
  readonly #live = new Set<Notification>();

  constructor(
    private readonly connector: DaemonConnector,
    private readonly window: () => BrowserWindow | null,
    private readonly open: (target: NotificationOpen) => void,
  ) {}

  static get recording(): boolean {
    return RECORD_FILE !== null;
  }

  start(): void {
    this.#timer ??= setInterval(() => void this.poll(), POLL_MS);
  }

  stop(): void {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
  }

  /** One round trip. Skipped while one is in flight, paused by the test hook, or with no daemon. */
  async poll(): Promise<number> {
    const connection = this.connector.status.connection;
    if (this.#busy || this.#paused || this.connector.status.phase !== 'connected' || connection === null) return 0;
    this.#busy = true;
    try {
      const res = await fetch(`${connection.url}/v1/notifications/take`, {
        method: 'POST',
        headers: { authorization: `Bearer ${connection.token}`, 'x-tandemise-api-version': 'v1', 'content-type': 'application/json' },
        body: JSON.stringify({ suppress: this.#lookingAtInbox() }),
      });
      if (!res.ok) return 0;
      const { notices } = (await res.json()) as { notices: readonly Notice[] };
      for (const notice of notices) this.#show(notice, false);
      return notices.length;
    } catch {
      // The daemon restarting is normal; the connector reports it, and the next poll retries.
      return 0;
    } finally {
      this.#busy = false;
    }
  }

  /** Settings → "Send a test notification". Touches nothing in the daemon. */
  test(): void {
    this.#show({ ...TEST_NOTICE, route: '/settings', workspaceId: null, ids: [], shape: 'test' }, true);
  }

  /** The acceptance suite's handle on what a person would see and click (only with TANDEMISE_NOTIFY_RECORD). */
  async debug(op: string, arg: unknown): Promise<unknown> {
    switch (op) {
      case 'list': return this.#records;
      case 'click': {
        const record = this.#records[typeof arg === 'number' ? arg : this.#records.length - 1];
        if (record === undefined) throw new Error('No such notification.');
        this.#click(record);
        return record;
      }
      case 'hide': this.window()?.hide(); return true;
      case 'window': {
        const window = this.window();
        return window === null || window.isDestroyed() ? null : { visible: window.isVisible(), focused: window.isFocused() };
      }
      case 'focus': this.#focusOverride = typeof arg === 'boolean' ? arg : null; return this.#focusOverride;
      case 'pause': this.#paused = true; return true;
      case 'resume': this.#paused = false; return true;
      case 'poll': {
        const paused = this.#paused;
        this.#paused = false;
        try { return await this.poll(); } finally { this.#paused = paused; }
      }
      default: throw new Error(`Unknown notification debug op '${op}'.`);
    }
  }

  /** Visible, focused and on the Inbox: the person is already looking at what would be announced. */
  #lookingAtInbox(): boolean {
    const window = this.window();
    if (window === null || window.isDestroyed() || !window.isVisible() || window.isMinimized()) return false;
    if (!(this.#focusOverride ?? window.isFocused())) return false;
    const hash = safeHash(window.webContents.getURL());
    return hash === '#/inbox' || hash.startsWith('#/inbox/') || hash.startsWith('#/inbox?');
  }

  #show(notice: Notice, test: boolean): void {
    const window = this.window();
    const record: NotificationRecord = {
      ...notice,
      at: new Date().toISOString(),
      test,
      windowVisible: window !== null && !window.isDestroyed() && window.isVisible(),
    };
    this.#records.push(record);
    if (RECORD_FILE !== null) {
      try { appendFileSync(RECORD_FILE, JSON.stringify(record) + '\n'); } catch { /* the record is a test aid only */ }
    }
    if (!Notification.isSupported()) return;
    const native = new Notification({ title: notice.title, body: notice.body });
    this.#live.add(native);
    native.on('click', () => this.#click(record));
    native.on('close', () => this.#live.delete(native));
    native.show();
  }

  #click(record: NotificationRecord): void {
    this.open({ route: record.route, workspaceId: record.workspaceId });
  }
}

function safeHash(url: string): string {
  try {
    return new URL(url).hash;
  } catch {
    return '';
  }
}
