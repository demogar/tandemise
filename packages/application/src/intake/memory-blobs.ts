import { createHash } from 'node:crypto';
import type { EvalBlobPort } from '@tandemise/domain';

/**
 * Content-addressed bytes in memory: `INTAKE_BLOBS`' default (plan Task 3).
 * The daemon rebinds it to files under `paths.intakeBlobs`; a composition
 * without a disk (a check) still records a signal's inline attachments.
 */
export class MemoryBlobs implements EvalBlobPort {
  readonly #bytes = new Map<string, Uint8Array>();

  async put(bytes: Uint8Array): Promise<string> {
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (!this.#bytes.has(sha256)) this.#bytes.set(sha256, new Uint8Array(bytes));
    return sha256;
  }

  async get(sha256: string): Promise<Uint8Array | null> {
    return this.#bytes.get(sha256) ?? null;
  }

  async has(sha256: string): Promise<boolean> {
    return this.#bytes.has(sha256);
  }
}
