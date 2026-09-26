import { LEGACY_TANDEMISE_IGNORE_BODY, TANDEMISE_IGNORE_BODY, TANDEMISE_IGNORE_FILE } from '@tandemise/domain';
import type { FileSystemHandle } from '@tandemise/execution-core';

/**
 * Writes Tandemise's own `.tandemise/.gitignore`, or upgrades the old one.
 *
 * Only a missing file or Tandemise's exact old body (`*`, which also hid the
 * project's committed setup from git) is replaced: a file someone edited is
 * theirs.
 */
export async function ensureTandemiseIgnore(fs: FileSystemHandle): Promise<void> {
  if (await fs.exists(TANDEMISE_IGNORE_FILE)) {
    const current = await fs.read(TANDEMISE_IGNORE_FILE);
    if (current !== LEGACY_TANDEMISE_IGNORE_BODY) return;
  }
  await fs.write(TANDEMISE_IGNORE_FILE, TANDEMISE_IGNORE_BODY);
}
