import { join } from 'node:path';
import { token } from '@tandemise/kernel';
import type { MissionId, TandemisePaths, WorkspaceId } from '@tandemise/shared';
import { z } from 'zod';

/**
 * Where the browser puts things.
 *
 * Supplied by the composition root rather than computed here, because
 * `TandemisePaths` is workspace-aware and this package has no business deciding
 * the on-disk layout (MVP.md §11.2).
 */
export interface BrowserOptions {
  /** Root for persistent profiles: `paths.browserProfiles(workspaceId)`. */
  profileRoot(workspaceId: WorkspaceId): string;
  /** Mission-scoped download directory (MVP.md §13.2). */
  downloadDirectory(workspaceId: WorkspaceId, missionId: MissionId): string;
}

export const BROWSER_OPTIONS = token<BrowserOptions>('browser/options');

export function browserOptionsFrom(paths: TandemisePaths): BrowserOptions {
  return {
    profileRoot: (workspaceId) => paths.browserProfiles(workspaceId),
    downloadDirectory: (workspaceId, missionId) =>
      join(paths.mission(workspaceId, missionId), 'downloads'),
  };
}

/**
 * What a browser integration row may configure.
 *
 * `profile` is the one that matters: it is the name a role's browser identity
 * is kept under, and giving two roles the same name is how you deliberately
 * share a login between them.
 */
export const browserConfigSchema = z.object({
  profile: z.string().min(1).default('default')
    .describe('Persistent profile name, e.g. qa or product'),
  headless: z.boolean().default(true),
  defaultTimeoutMs: z.number().int().min(1000).max(300_000).default(15_000),
  viewport: z.object({
    width: z.number().int().min(320).max(3840),
    height: z.number().int().min(240).max(2160),
  }).optional(),
  /** Guarded by capability as well; this is the belt-and-braces switch. */
  allowEvaluate: z.boolean().default(false)
    .describe('Permit browser.evaluate. Arbitrary page script is a last resort (MVP.md §13.1).'),
}).strict();

export type BrowserConfig = z.infer<typeof browserConfigSchema>;
