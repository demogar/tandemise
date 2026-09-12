import type {
  Approval, ArtifactManifest, CheckResult, Decision, Evaluation, ExecutionTargetRecord,
  Integration, Mission, MissionProgress, MissionTask, Repository, RoleTemplate, Run,
  RunEventRecord, RuntimeHealth, RuntimeProfile, RuntimeDiscovery, RuntimeSettingField, Workspace,
  MissionPlan, PlanValidationIssue, GateOutcome,
} from '@tandemise/domain';

/**
 * Read models the UI consumes.
 *
 * The renderer never reads SQLite and never re-derives joins (MVP.md §7.2); it
 * receives projected state. Keeping these shapes here - rather than letting the
 * UI assemble them from six endpoints - is what keeps a mission screen one
 * request instead of a waterfall.
 */

export interface SystemInfo {
  readonly daemonVersion: string;
  readonly apiVersion: string;
  readonly schemaVersion: number;
  readonly startedAt: string;
  readonly pid: number;
  readonly home: string;
  readonly platform: string;
  readonly nodeVersion: string;
}

export interface TaskView extends MissionTask {
  readonly roleName: string;
  /** DAG column, from `planLevels` - lets the UI lay out without a graph lib. */
  readonly level: number;
  readonly latestRun: Run | null;
  readonly runCount: number;
  readonly outputArtifacts: readonly ArtifactManifest[];
  readonly checks: readonly CheckResult[];
  readonly gate: GateOutcome | null;
  readonly pendingApprovalId: string | null;
  readonly runtimeName: string | null;
  readonly targetName: string | null;
}

export interface MissionSummary {
  readonly mission: Mission;
  readonly progress: MissionProgress;
  readonly repositoryName: string | null;
  /** Title of whatever is currently happening, for the list row subtitle. */
  readonly currentActivity: string | null;
  readonly lastEventAt: string | null;
}

export interface MissionDetail {
  readonly mission: Mission;
  readonly progress: MissionProgress;
  readonly repository: Repository | null;
  readonly tasks: readonly TaskView[];
  readonly artifacts: readonly ArtifactManifest[];
  readonly approvals: readonly Approval[];
  readonly decisions: readonly Decision[];
  readonly targets: readonly ExecutionTargetRecord[];
  readonly checks: readonly CheckResult[];
  readonly evaluations: readonly Evaluation[];
  readonly metrics: MissionMetrics;
  readonly plan: MissionPlan | null;
  readonly planIssues: readonly PlanValidationIssue[];
}

/** MVP.md §22.2. Values the runtime does not expose stay null, never guessed. */
export interface MissionMetrics {
  readonly wallClockMs: number;
  readonly runtimeActiveMs: number;
  readonly humanWaitMs: number;
  readonly retries: number;
  readonly failures: number;
  readonly filesChanged: number;
  readonly commits: number;
  readonly reviewFindings: number;
  readonly qaDefects: number;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly costUsd: number | null;
  readonly runtimeFallbacks: number;
}

export interface RuntimeView {
  readonly profile: RuntimeProfile;
  readonly health: RuntimeHealth;
  readonly adapterDisplayName: string;
  /**
   * What this profile's adapter lets it configure.
   *
   * Optional because a client is not always talking to a daemon of its own
   * vintage - `npm run dev` deliberately reuses a daemon that is already
   * running, so a freshly built renderer routinely meets an older one. A field
   * added to a view is therefore absent, not empty, and code that reads it must
   * say what it does in that case rather than trust the type.
   */
  readonly settingsSchema?: readonly RuntimeSettingField[];
  readonly activeRuns: number;
  readonly rolesRouted: readonly string[];
}

export interface IntegrationView {
  readonly integration: Integration;
  readonly health: { state: string; detail: string; checkedAt: string };
  readonly availableCapabilities: readonly { capability: string; risk: string; description: string }[];
}

export interface ApprovalView {
  readonly approval: Approval;
  readonly missionTitle: string | null;
  readonly taskTitle: string | null;
  readonly roleName: string | null;
}

export interface WorkspaceView {
  readonly workspace: Workspace;
  readonly repositories: readonly Repository[];
  readonly roles: readonly RoleTemplate[];
}

export interface HomeView {
  readonly workspace: Workspace | null;
  readonly activeMissions: readonly MissionSummary[];
  readonly blockedMissions: readonly MissionSummary[];
  readonly recentMissions: readonly MissionSummary[];
  readonly pendingApprovals: readonly ApprovalView[];
  readonly runtimes: readonly RuntimeView[];
  readonly recentEvents: readonly RunEventRecord[];
}

export interface RepositoryProbe {
  readonly path: string;
  readonly isGitRepository: boolean;
  readonly name: string;
  readonly defaultBranch: string | null;
  readonly currentBranch: string | null;
  readonly remoteUrl: string | null;
  readonly isClean: boolean;
  readonly detectedChecks: {
    install: string | null; typecheck: string | null; lint: string | null;
    test: string | null; build: string | null;
    devServer: string | null; devServerUrl: string | null;
  };
  readonly languages: readonly string[];
  readonly warnings: readonly string[];
}

export interface RuntimeDiscoveryView extends RuntimeDiscovery {
  /** True when a profile already exists for this adapter. */
  readonly configured: boolean;
}
