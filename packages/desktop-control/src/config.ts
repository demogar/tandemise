import { z } from 'zod';

/**
 * `Integration.config` for the desktop provider.
 *
 * Note what is *not* here: the helper binary path. That is a property of the
 * machine the daemon runs on, not of a workspace's integration row, and it is
 * supplied once at composition when the client is constructed.
 */
export const desktopConfigSchema = z.object({
  /**
   * Workspace-level app allowlist, by bundle id. Empty means the workspace adds
   * no narrowing of its own - the assignment's grants remain the allowlist, and
   * they are always required (MVP.md §19.2).
   */
  apps: z.array(z.string()).default([]),
  maxInspectDepth: z.number().int().min(1).max(40).default(12),
  maxInspectNodes: z.number().int().min(1).max(20_000).default(2_000),
});

export type DesktopConfig = z.output<typeof desktopConfigSchema>;

export const DEFAULT_DESKTOP_CONFIG: DesktopConfig = {
  apps: [],
  maxInspectDepth: 12,
  maxInspectNodes: 2_000,
};
