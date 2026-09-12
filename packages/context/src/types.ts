import type {
  ArtifactType, CapabilityGrant, Decision, LoadedArtifact, Mission, MissionTask,
  RoleTemplate, WorkspaceKnowledge,
} from '@tandemise/domain';
import type { ArtifactId, Timestamp } from '@tandemise/shared';

/**
 * Input to the Context Compiler (MVP.md §14.1).
 *
 * Everything here is *already resolved*. The compiler does no I/O and holds no
 * ports: it is a pure function from known facts to a prompt. That makes the
 * output reproducible, makes it testable without a filesystem, and means the
 * caller - which does have the repositories - decides what is relevant. A
 * compiler that could fetch would inevitably start fetching "just in case",
 * which is the giant-shared-prompt failure MVP.md §14.1 exists to prevent.
 */
export interface ContextRequest {
  readonly role: RoleTemplate;
  readonly workspaceName: string;
  readonly knowledge: WorkspaceKnowledge;
  readonly mission: Mission;
  readonly task: MissionTask;
  /** Artifacts this task depends on, already loaded. Bodies are untrusted. */
  readonly dependencyArtifacts: readonly LoadedArtifact[];
  /** Accepted decisions that constrain this task (MVP.md §14.4). */
  readonly decisions: readonly Decision[];
  /** Code excerpts, logs, screenshots' descriptions, prior reports. */
  readonly evidence: readonly EvidenceItem[];
  readonly grants: readonly CapabilityGrant[];
  readonly outputContract: OutputContract;
  /** Hard character budget for the whole prompt. */
  readonly maxChars?: number;
}

export interface EvidenceItem {
  readonly label: string;
  /** Where it came from: a URL, a file path, a tool name. Shown in the fence. */
  readonly origin: string;
  readonly text: string;
  /** Oldest evidence is dropped first when the budget binds. */
  readonly recordedAt?: Timestamp;
}

export interface ExpectedArtifact {
  readonly type: ArtifactType;
  /** The exact skeleton to fill in, from `renderArtifactTemplate`. */
  readonly template: string;
  /** Where to write it, in words the runtime's tools can act on. */
  readonly destination: string;
}

export interface OutputContract {
  readonly artifacts: readonly ExpectedArtifact[];
  readonly workingDirectory: string;
  /** The gate expression that decides whether this task succeeded, if any. */
  readonly completionGate?: string | null;
  /** Anything else the role must do, e.g. "leave the branch pushed". */
  readonly notes?: readonly string[];
}

export type TruncationAction = 'summarized' | 'dropped';

export interface TruncationNote {
  readonly section: string;
  readonly action: TruncationAction;
  readonly removedChars: number;
  readonly reason: string;
}

export interface CompiledContext {
  readonly prompt: string;
  readonly includedArtifactIds: readonly ArtifactId[];
  /** ~4 characters per token. Good enough to choose a model, not to bill one. */
  readonly approxTokens: number;
  readonly truncated: readonly TruncationNote[];
}
