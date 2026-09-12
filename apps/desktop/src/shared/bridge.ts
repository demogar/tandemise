/**
 * The whole surface the renderer is allowed to reach outside its sandbox.
 *
 * This file is shared by the main process, the preload script and the renderer
 * so that all three agree on one shape. Keeping it small is the point: every
 * member here is a hole in the sandbox, so anything that can be done with a
 * `fetch` to the daemon must be done that way instead of being added here
 * (MVP.md §7.1, §32).
 */

/** Connection details for the local daemon, read from `~/.tandemise/daemon.json`. */
export interface DaemonConnection {
  readonly url: string;
  readonly token: string;
  readonly pid: number;
  readonly startedAt: string;
}

export type DaemonPhase =
  /** Looking for, or waiting on, `daemon.json`. */
  | 'connecting'
  /** We asked the OS to start a daemon and are polling for its handshake file. */
  | 'spawning'
  | 'connected'
  /** No daemon, and we could not start one. `detail` says why. */
  | 'unavailable';

export interface DaemonStatus {
  readonly phase: DaemonPhase;
  readonly connection: DaemonConnection | null;
  readonly detail: string;
  /** Path we looked in, surfaced in the error state so the user can check it. */
  readonly handshakePath: string;
  readonly updatedAt: string;
}

export interface TandemiseBridge {
  readonly platform: NodeJS.Platform;
  getDaemonStatus(): Promise<DaemonStatus>;
  /** Re-runs discovery (and auto-spawn); resolves with the resulting status. */
  reconnectDaemon(): Promise<DaemonStatus>;
  onDaemonStatus(listener: (status: DaemonStatus) => void): () => void;
  /** Native directory picker. Resolves null when the user cancels. */
  selectDirectory(title?: string): Promise<string | null>;
  openExternal(url: string): Promise<void>;
  revealInFinder(path: string): Promise<void>;
}

/** IPC channel names, kept in one place so a typo fails at compile time. */
export const IPC = {
  daemonStatus: 'daemon:status',
  daemonReconnect: 'daemon:reconnect',
  daemonStatusChanged: 'daemon:status-changed',
  selectDirectory: 'dialog:select-directory',
  openExternal: 'shell:open-external',
  revealInFinder: 'shell:reveal',
} as const;
