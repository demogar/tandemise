import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { EvalBlobPort } from '@tandemise/domain';

/**
 * Content-addressed eval case inputs (P3b spec Part B): `<root>/<sha[0..2]>/<sha>`,
 * the same two-character fan-out the artifact store's blobs use.
 *
 * A case outlives its source mission and any artifact store cleanup, so its
 * inputs live here instead - written once, addressed by hash, and re-verified
 * on every read rather than trusted from the filename alone.
 */
export class FileEvalBlobs implements EvalBlobPort {
  constructor(private readonly root: string) {}

  async put(bytes: Uint8Array): Promise<string> {
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const target = this.#path(sha256);
    if (await exists(target)) return sha256;
    await mkdir(dirname(target), { recursive: true });
    const temp = `${target}.tmp-${randomUUID()}`;
    try {
      await writeFile(temp, bytes, { mode: 0o600 });
      await rename(temp, target);
    } catch (e) {
      await rm(temp, { force: true });
      throw e;
    }
    return sha256;
  }

  async get(sha256: string): Promise<Uint8Array | null> {
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await readFile(this.#path(sha256)));
    } catch {
      // Missing (ENOENT) or unreadable: either way, there is nothing to return.
      return null;
    }
    return createHash('sha256').update(bytes).digest('hex') === sha256 ? bytes : null;
  }

  async has(sha256: string): Promise<boolean> {
    // A `stat` answers existence without reading and re-hashing a file that
    // may be large; a caller that needs the stronger guarantee calls `get`.
    return exists(this.#path(sha256));
  }

  #path(sha256: string): string {
    return join(this.root, sha256.slice(0, 2), sha256);
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
