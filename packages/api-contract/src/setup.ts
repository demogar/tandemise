import { z } from 'zod';

/**
 * Setup as code (P15): the project's setup exported to, and imported from, a
 * repository's `.tandemise/` folder.
 */

export const exportSetupRequest = z.object({
  /** The project repository whose `.tandemise/` folder receives the files. */
  repositoryId: z.string().min(1),
});
export type ExportSetupRequest = z.infer<typeof exportSetupRequest>;

export const previewSetupRequest = z.object({
  /** A folder holding `.tandemise/`, or the `.tandemise` folder itself. */
  path: z.string().min(1),
});
export type PreviewSetupRequest = z.infer<typeof previewSetupRequest>;

export const applySetupRequest = z.object({
  path: z.string().min(1),
  /** The hash the preview showed: the apply is refused when the files changed since. */
  hash: z.string().min(1),
  /** Item id → choice. Items left out take the preview's default. */
  choices: z.record(z.string(), z.enum(['mine', 'theirs'])).default({}),
});
export type ApplySetupRequest = z.input<typeof applySetupRequest>;

export interface SetupExportRecord {
  readonly hash: string;
  readonly repositoryName: string;
  readonly files: number;
  readonly at: string;
}

export interface SetupStatusView {
  /** Null until the project was exported once from this machine. */
  readonly lastExport: SetupExportRecord | null;
}

export interface SetupFileView {
  /** Relative to the repository, e.g. `.tandemise/roles/development.md`. */
  readonly path: string;
  readonly bytes: number;
  /** `written`, or `kept` for a workflow file that already lives in this repository. */
  readonly status: 'written' | 'kept';
}

export interface SetupExportView {
  readonly repositoryName: string;
  /** Absolute path of the `.tandemise` folder written. */
  readonly folder: string;
  readonly files: readonly SetupFileView[];
  /** Files removed because the setup no longer has them (a deleted role). */
  readonly removed: readonly string[];
  readonly hash: string;
  readonly secrets: readonly { readonly file: string; readonly name: string }[];
  /** Things the person has to do for the files to be committed. */
  readonly warnings: readonly string[];
}

export type SetupItemKindView = 'settings' | 'wip' | 'monthly_limits' | 'mission_limits' | 'role' | 'workflow' | 'routine';
export type SetupActionView = 'add' | 'change' | 'remove' | 'same';

export interface SetupItemView {
  readonly id: string;
  readonly kind: SetupItemKindView;
  readonly name: string;
  readonly action: SetupActionView;
  readonly detail: string;
  readonly problem: string | null;
  readonly notes: readonly string[];
  /** The default choice; null when there is nothing to choose (Same, or a problem). */
  readonly choice: 'mine' | 'theirs' | null;
}

export interface SetupPreviewView {
  readonly folder: string;
  readonly hash: string;
  readonly items: readonly SetupItemView[];
  readonly counts: Readonly<Record<SetupActionView, number>>;
  /** Files in the folder this version does not read (a skills lock, say). */
  readonly ignored: readonly string[];
}

export interface SetupApplyView {
  readonly applied: number;
  readonly kept: number;
  /** One line per item changed, in the preview's words. */
  readonly lines: readonly string[];
}
