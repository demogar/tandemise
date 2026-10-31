import { z } from 'zod';
import type { SetupItemView } from './setup.js';

/**
 * The brain (#51): one git repository per project for memory and the factory.
 * Shapes follow `setup.ts`.
 */

const ghName = z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9._-]+$/, 'Use letters, digits, ., - and _.');

export const linkBrainRequest = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('create'), owner: ghName, name: ghName }),
  z.object({ mode: z.literal('adopt'), remote: z.string().trim().min(1).max(2048) }),
  z.object({ mode: z.literal('local') }),
]);
export type LinkBrainRequest = z.infer<typeof linkBrainRequest>;

export const applyBrainRequest = z.object({
  /** The hash the adopt preview showed. */
  hash: z.string().min(1),
  choices: z.record(z.string(), z.enum(['mine', 'theirs'])).default({}),
});
export type ApplyBrainRequest = z.input<typeof applyBrainRequest>;

export const shareBrainRequest = z.object({ owner: ghName, name: ghName });
export type ShareBrainRequest = z.infer<typeof shareBrainRequest>;

export type BrainStatus = 'up_to_date' | 'offline' | 'protected' | 'local_only' | 'unlinked';

export interface BrainView {
  readonly linked: boolean;
  /** `github.com/<owner>/<name>`, or null for a brain on this machine only. */
  readonly remote: string | null;
  /** A link a person can open, when the remote is on GitHub. */
  readonly remoteUrl: string | null;
  readonly writerId: string | null;
  readonly lastPulledSha: string | null;
  readonly lastPushedSha: string | null;
  readonly lastSyncAt: string | null;
  readonly status: BrainStatus;
  /** One sentence, ready to show. */
  readonly statusLine: string;
  readonly problems: readonly string[];
  readonly counts: { readonly rules: number; readonly lessons: number; readonly candidates: number; readonly mcpsNeeded: number };
}

/** What adopting an existing brain would change here, before anything is linked. */
export interface BrainAdoptPreview {
  readonly hash: string;
  readonly items: readonly SetupItemView[];
  readonly brain: { readonly rules: number; readonly lessons: number; readonly mcpsNeeded: readonly string[] };
}
