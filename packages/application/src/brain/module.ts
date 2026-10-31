import type { Container } from '@tandemise/kernel';
import { TandemiseError } from '@tandemise/shared';
import type { BrainHostPort, BrainRepoPort } from '@tandemise/domain';
import * as b from './tokens.js';

const SOURCE = '@tandemise/application:brain';

const noGit = (): never => {
  throw new TandemiseError('PRECONDITION_FAILED', 'Brains need git on this machine.');
};

/**
 * The brain's bindings (#51), kept out of `../module.ts`, which other work
 * edits in parallel. The defaults keep the application usable without git or
 * gh; the daemon rebinds both ports.
 */
export function bindBrain(container: Container): void {
  const repo: BrainRepoPort = {
    clone: noGit, init: noGit, setRemote: noGit, head: noGit, fetchAndRebase: noGit, commit: noGit, push: noGit,
    branch: noGit, moveUnpushedTo: noGit, fastForward: noGit, revert: noGit, readAt: noGit, listAt: noGit, diffAt: noGit,
  };
  const host: BrainHostPort = {
    available: async () => ({ ok: false, reason: 'GitHub CLI is not connected.' }),
    createRepo: async () => { throw new TandemiseError('PRECONDITION_FAILED', 'GitHub CLI is not connected.'); },
    openPr: async () => { throw new TandemiseError('PRECONDITION_FAILED', 'GitHub CLI is not connected.'); },
    findPr: async () => null,
    prState: async () => null,
  };
  container.bind(b.BRAIN_REPO, () => repo, { source: SOURCE });
  container.bind(b.BRAIN_HOST, () => host, { source: SOURCE });
}
