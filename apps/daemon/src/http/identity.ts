import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { TandemiseError, type Logger } from '@tandemise/shared';

/**
 * The local daemon handshake (MVP.md §7.2).
 *
 * The daemon binds an ephemeral port on loopback and writes its coordinates to a
 * file only the user can read. The desktop app reads that file; nothing else on
 * the machine can reach the API without it. The token is per-installation and
 * regenerated on an explicit reset.
 *
 * This is deliberately simple. The threat it defends against is another local
 * process - not a network attacker, because there is no network listener beyond
 * 127.0.0.1.
 */
export interface DaemonConnectionFile {
  readonly url: string;
  readonly token: string;
  readonly pid: number;
  readonly apiVersion: string;
  readonly startedAt: string;
}

const FILE_NAME = 'daemon.json';
const TOKEN_NAME = 'daemon-token';

export function connectionFilePath(home: string): string {
  return join(home, FILE_NAME);
}

/**
 * Loads the persisted token, or mints one. Kept in its own 0600 file so that
 * rewriting the connection file on every start does not churn the secret.
 */
export function loadOrCreateToken(home: string): string {
  const path = join(home, TOKEN_NAME);
  if (existsSync(path)) {
    const existing = readFileSync(path, 'utf8').trim();
    if (existing.length >= 32) return existing;
  }
  const token = randomBytes(32).toString('base64url');
  writeSecret(path, token);
  return token;
}

export function rotateToken(home: string): string {
  const path = join(home, TOKEN_NAME);
  if (existsSync(path)) unlinkSync(path);
  return loadOrCreateToken(home);
}

export function writeConnectionFile(home: string, info: DaemonConnectionFile): void {
  writeSecret(connectionFilePath(home), JSON.stringify(info, null, 2) + '\n');
}

export function removeConnectionFile(home: string, log?: Logger): void {
  try {
    if (existsSync(connectionFilePath(home))) unlinkSync(connectionFilePath(home));
  } catch (e) {
    log?.warn('daemon.connection_file_cleanup_failed', { error: String(e) });
  }
}

export function readConnectionFile(home: string): DaemonConnectionFile | undefined {
  const path = connectionFilePath(home);
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as DaemonConnectionFile;
  } catch {
    return undefined;
  }
}

/**
 * Constant-time bearer comparison. A length-leaking `===` here would be a small
 * but real oracle, and the fix costs nothing.
 */
export function verifyBearer(header: string | undefined, expected: string): boolean {
  if (!header) return false;
  const prefix = 'Bearer ';
  const provided = header.startsWith(prefix) ? header.slice(prefix.length) : header;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function writeSecret(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, contents, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

/**
 * Single-daemon instance lock (MVP.md §21.2 step 2). Two daemons sharing one
 * SQLite file and one set of worktrees would corrupt both.
 */
export class InstanceLock {
  #path: string;
  #held = false;

  constructor(home: string) {
    this.#path = join(home, 'daemon.lock');
  }

  /**
   * Claims the lock, or throws CONFLICT.
   *
   * The claim is made with `wx`, which is atomic: the kernel creates the file
   * or fails with EEXIST, and exactly one of several simultaneous daemons can
   * win. A check-then-write - `existsSync` followed by `writeFileSync` - looks
   * equivalent and is not: four processes starting together all observed an
   * absent file and all believed they held the lock, which would put two
   * daemons on one SQLite file and one worktree root.
   *
   * Only after losing the race do we inspect the incumbent, because that is the
   * one moment when a stale lock from a crashed daemon must be distinguished
   * from a live one.
   */
  acquire(): void {
    mkdirSync(dirname(this.#path), { recursive: true });
    const stamp = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() });

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        writeFileSync(this.#path, stamp, { mode: 0o600, flag: 'wx' });
        this.#held = true;
        return;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      }

      const incumbent = this.#readIncumbent();
      if (incumbent !== undefined && incumbent !== process.pid && isProcessAlive(incumbent)) {
        throw new TandemiseError('CONFLICT', `Another Tandemise daemon is already running (pid ${incumbent}).`, {
          details: { pid: incumbent, lockFile: this.#path },
        });
      }
      // Stale (the holder is gone, or the file is unreadable). Clear it and
      // retry the atomic claim once - if another process wins that race, the
      // second pass sees a live incumbent and reports the conflict correctly.
      try { unlinkSync(this.#path); } catch { /* someone else cleared it first */ }
    }

    throw new TandemiseError('CONFLICT', 'Could not acquire the Tandemise daemon lock.', {
      details: { lockFile: this.#path },
    });
  }

  /** The holder's pid, or undefined when the lock file is absent or unreadable. */
  #readIncumbent(): number | undefined {
    try {
      const raw = readFileSync(this.#path, 'utf8').trim();
      // Older daemons wrote a bare pid; both spellings are accepted.
      const pid = raw.startsWith('{') ? (JSON.parse(raw) as { pid?: number }).pid : Number.parseInt(raw, 10);
      return typeof pid === 'number' && Number.isFinite(pid) && pid > 0 ? pid : undefined;
    } catch {
      return undefined;
    }
  }

  release(): void {
    if (!this.#held) return;
    try {
      if (existsSync(this.#path) && this.#readIncumbent() === process.pid) {
        unlinkSync(this.#path);
      }
    } catch { /* a failed unlock must not block shutdown */ }
    this.#held = false;
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    // Signal 0 performs the permission/existence check without delivering.
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}
