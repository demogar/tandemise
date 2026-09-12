/**
 * Credential storage port (MVP.md §P8).
 *
 * Callers receive and store *references*. The only operation that yields a raw
 * value is `resolve`, which exists so an integration can populate a child
 * process environment - and the returned value must never be persisted, logged,
 * or placed in an event body.
 */
export interface SecretStorePort {
  /** Stores a secret and returns an opaque reference to record in the database. */
  store(name: string, value: string): Promise<string>;
  resolve(ref: string): Promise<string | undefined>;
  remove(ref: string): Promise<void>;
  list(): Promise<readonly string[]>;
  readonly backend: 'keychain' | 'file' | 'memory';
}
