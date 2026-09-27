import { z } from 'zod';
import type { IssueLinkState, IssueSyncSettings } from '@tandemise/domain';

/**
 * GitHub issues in and out (P14). Its own module, like the other feature
 * contracts, so the two views and one request stay together.
 */

/** PATCH /v1/repositories/:id/issues - any subset; the daemon validates the words. */
export const updateIssueSettingsRequest = z.object({
  enabled: z.boolean().optional(),
  githubRepo: z.string().max(200).nullable().optional(),
  label: z.string().max(100).optional(),
  pollMinutes: z.number().int().optional(),
  closeOnComplete: z.boolean().optional(),
  postComments: z.boolean().optional(),
  workflowPreset: z.string().max(200).nullable().optional(),
}).strict();
export type UpdateIssueSettingsRequest = z.infer<typeof updateIssueSettingsRequest>;

/** A repository's issue settings with the words the window shows. */
export interface RepositoryIssuesView {
  readonly repositoryId: string;
  readonly repositoryName: string;
  /** The stored settings; defaults (off) when the repository never had any. */
  readonly settings: Pick<IssueSyncSettings, 'enabled' | 'githubRepo' | 'label' | 'pollMinutes' | 'closeOnComplete' | 'postComments' | 'workflowPreset' | 'lastCheckedAt' | 'lastError'>;
  /** `owner/name` read from the checkout's remote, to prefill the field; null when it is not GitHub. */
  readonly suggestedRepo: string | null;
  /** "Last checked 2 min ago · 3 linked", "Not checked yet · 0 linked", "Checking…", "Off". */
  readonly statusLabel: string;
  readonly linked: number;
  readonly checking: boolean;
}

/** One issue Tandemise read, and its mission. */
export interface IssueLinkView {
  readonly id: string;
  readonly repositoryId: string;
  readonly githubRepo: string;
  readonly number: number;
  readonly url: string;
  readonly title: string;
  readonly author: string | null;
  readonly state: IssueLinkState;
  /** Null when the person deleted the draft (the issue does not come back). */
  readonly missionId: string | null;
}

export interface IssuesOverview {
  readonly repositories: readonly RepositoryIssuesView[];
  readonly links: readonly IssueLinkView[];
}
