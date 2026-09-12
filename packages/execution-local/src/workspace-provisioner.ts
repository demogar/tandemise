import { mkdir } from 'node:fs/promises';
import type { MissionId, TandemisePaths, WorkspaceId, Logger } from '@tandemise/shared';

export interface WorkspaceLayout {
  readonly root: string;
  readonly repos: string;
  readonly artifacts: string;
  readonly browserProfiles: string;
}

export interface MissionLayout {
  readonly root: string;
  readonly worktrees: string;
  readonly logs: string;
}

/**
 * Creates the on-disk layout of MVP.md §11.2 under `~/.tandemise`.
 *
 * Directories are created 0700: a workspace holds checked-out source, agent
 * logs and browser profiles, none of which should be readable by other users of
 * the machine.
 */
export class WorkspaceProvisioner {
  constructor(
    readonly paths: TandemisePaths,
    private readonly log: Logger,
  ) {}

  async ensureRoot(): Promise<void> {
    await ensureDir(this.paths.root);
    await ensureDir(this.paths.logs);
    await ensureDir(this.paths.workspaces);
  }

  async ensureWorkspace(workspaceId: WorkspaceId): Promise<WorkspaceLayout> {
    await this.ensureRoot();
    const layout: WorkspaceLayout = {
      root: this.paths.workspace(workspaceId),
      repos: this.paths.repos(workspaceId),
      artifacts: this.paths.artifacts(workspaceId),
      browserProfiles: this.paths.browserProfiles(workspaceId),
    };
    for (const dir of Object.values(layout)) await ensureDir(dir);
    this.log.debug('workspace.ensured', { workspaceId, root: layout.root });
    return layout;
  }

  async ensureMission(workspaceId: WorkspaceId, missionId: MissionId): Promise<MissionLayout> {
    await this.ensureWorkspace(workspaceId);
    const layout: MissionLayout = {
      root: this.paths.mission(workspaceId, missionId),
      worktrees: this.paths.worktrees(workspaceId, missionId),
      logs: this.paths.missionLogs(workspaceId, missionId),
    };
    for (const dir of Object.values(layout)) await ensureDir(dir);
    this.log.debug('mission.workspace_ensured', { workspaceId, missionId, root: layout.root });
    return layout;
  }
}

async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
}
