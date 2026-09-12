import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SecretStorePort } from '@tandemise/domain';
import { TandemiseError, type Logger } from '@tandemise/shared';

const run = promisify(execFile);
const SERVICE = 'com.tandemise.secrets';

/**
 * Credential storage (MVP.md §P8, §19.2).
 *
 * The first principle is to store nothing at all: most integrations reuse an
 * already-authenticated CLI (`gh`, `claude`), so Tandemise holds no credential
 * for them. This store exists only for the cases where the user genuinely hands
 * us a token — a REST connector, say.
 *
 * When a secret must be held, it goes in the macOS Keychain and the database
 * records an opaque reference. `resolve` is the only call that yields a raw
 * value, and its result must never be persisted, logged, or placed in an event
 * body.
 */
export function createSecretStore(opts: { home: string; log: Logger }): SecretStorePort {
  return process.platform === 'darwin'
    ? new KeychainSecretStore(opts.home, opts.log)
    : new PlaintextFileSecretStore(opts.home, opts.log);
}

class KeychainSecretStore implements SecretStorePort {
  readonly backend = 'keychain' as const;
  readonly #index: FileIndex;

  constructor(home: string, private readonly log: Logger) {
    // `security` cannot enumerate by service reliably, so the set of refs we
    // created is tracked separately. It holds names and references, never
    // secret values.
    //
    // The path comes from the caller's `home`, not from the environment:
    // reading TANDEMISE_HOME here produced a RELATIVE path whenever the
    // variable was unset (the normal case, since the default is ~/.tandemise),
    // so the index landed in whatever directory the daemon happened to start
    // in. A restart from elsewhere then saw an empty list and orphaned every
    // Keychain item it could no longer name.
    this.#index = new FileIndex(join(home, 'secret-refs.json'));
  }

  async store(name: string, value: string): Promise<string> {
    const ref = `keychain:${name}:${randomUUID()}`;
    // `-U` updates in place if the account already exists. The value is passed
    // as an argument to `security`, which is visible in `ps` for the lifetime of
    // the call - unavoidable with this CLI, and the exposure window is
    // milliseconds on the user's own machine.
    await run('security', [
      'add-generic-password', '-a', ref, '-s', SERVICE, '-w', value, '-U',
    ]).catch((e: unknown) => {
      throw new TandemiseError('INTERNAL', 'Could not write to the macOS Keychain.', { cause: e });
    });
    this.#index.add(ref, name);
    this.log.info('secrets.stored', { name, backend: this.backend });
    return ref;
  }

  async resolve(ref: string): Promise<string | undefined> {
    try {
      const { stdout } = await run('security', ['find-generic-password', '-a', ref, '-s', SERVICE, '-w']);
      return stdout.replace(/\n$/, '');
    } catch {
      // A missing item is an ordinary outcome (the user deleted it in Keychain
      // Access); it must not read as an internal failure.
      return undefined;
    }
  }

  async remove(ref: string): Promise<void> {
    await run('security', ['delete-generic-password', '-a', ref, '-s', SERVICE]).catch(() => undefined);
    this.#index.remove(ref);
  }

  async list(): Promise<readonly string[]> {
    return this.#index.refs();
  }
}

/**
 * Non-macOS fallback: a 0600 file, with no encryption at all.
 *
 * Named for what it is. It exists so the daemon runs on Linux during
 * development, and the warning it logs on construction says so - a class called
 * `EncryptedFileSecretStore` that stores plaintext is worse than no abstraction.
 */
class PlaintextFileSecretStore implements SecretStorePort {
  readonly backend = 'file' as const;
  readonly #path: string;

  constructor(home: string, private readonly log: Logger) {
    this.#path = join(home, 'secrets.json');
    this.log.warn('secrets.file_backend', {
      detail: 'No OS credential store on this platform; secrets are stored in a 0600 file.',
      path: this.#path,
    });
  }

  #read(): Record<string, string> {
    if (!existsSync(this.#path)) return {};
    try { return JSON.parse(readFileSync(this.#path, 'utf8')) as Record<string, string>; } catch { return {}; }
  }

  #write(data: Record<string, string>): void {
    mkdirSync(dirname(this.#path), { recursive: true });
    // Write-then-rename: overwriting in place loses every stored secret if the
    // process dies mid-write.
    const tmp = `${this.#path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.#path);
  }

  async store(name: string, value: string): Promise<string> {
    const ref = `file:${name}:${randomUUID()}`;
    const data = this.#read();
    data[ref] = value;
    this.#write(data);
    return ref;
  }

  async resolve(ref: string): Promise<string | undefined> {
    return this.#read()[ref];
  }

  async remove(ref: string): Promise<void> {
    const data = this.#read();
    delete data[ref];
    this.#write(data);
  }

  async list(): Promise<readonly string[]> {
    return Object.keys(this.#read());
  }
}

/** Reference index. Names and refs only - never a secret value. */
class FileIndex {
  constructor(private readonly path: string) {}

  #read(): Record<string, string> {
    if (!this.path || !existsSync(this.path)) return {};
    try { return JSON.parse(readFileSync(this.path, 'utf8')) as Record<string, string>; } catch { return {}; }
  }

  add(ref: string, name: string): void {
    if (!this.path) return;
    const data = this.#read();
    data[ref] = name;
    mkdirSync(join(this.path, '..'), { recursive: true });
    writeFileSync(this.path, JSON.stringify(data, null, 2), { mode: 0o600 });
  }

  remove(ref: string): void {
    if (!this.path) return;
    const data = this.#read();
    delete data[ref];
    writeFileSync(this.path, JSON.stringify(data, null, 2), { mode: 0o600 });
  }

  refs(): readonly string[] {
    return Object.keys(this.#read());
  }
}
