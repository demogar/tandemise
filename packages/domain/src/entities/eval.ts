import type { ArtifactId, EvalCaseId, EvalRunId, EvalSuiteId, EvalTrialId, MissionId, PersonId, RepositoryId, RunId, TaskId, WorkspaceId } from '@tandemise/shared';
import type { Timestamp } from '@tandemise/shared';
import type { ArtifactHandoff, ArtifactType } from './artifact.js';
import type { ArtifactRequirement, RetryPolicy } from './task.js';
import type { GateExpression } from '../gate.js';
import type { ModelPolicy } from './models.js';
import type { RunPurpose } from './feedback.js';
import type { RunSkill, SkillPin, SkillRef } from './skill.js';
import type { RoleTemplate } from './role.js';
import type { Workspace } from './workspace.js';
import type { Decision } from './decision.js';

/**
 * Evals (P3 spec Part B).
 *
 * A `RunScore` is what an assessed run leaves behind: measured facts, never a
 * judgement, and never read by the engine (Ruling 8). An `EvalCase` is a
 * frozen snapshot of a step, saved from a real mission so it can be replayed
 * against a candidate later. An `EvalRun` is one suite tried as
 * {baseline, candidate} × repeats; its `EvalTrial`s are the hidden missions
 * that carry it out.
 */

/** One run's measured facts, kept after its gate was assessed (spec B1). A record, never an engine input. */
export interface RunScore {
  readonly runId: RunId;
  readonly taskId: TaskId;
  readonly missionId: MissionId;
  readonly workspaceId: WorkspaceId;
  readonly roleId: string;
  readonly model: string | null;
  readonly skills: readonly RunSkill[];
  /** `Run.attempt`: the run's number among its task's runs, not the task's retry counter. */
  readonly attempt: number;
  readonly round: number;
  readonly purpose: RunPurpose | null;
  readonly gatePassed: boolean;
  readonly gateDetail: string;
  readonly facts: Readonly<Record<string, unknown>>;
  /** Null when the mission had no QA reading at scoring time. */
  readonly criteria: CriteriaCounts | null;
  readonly overBudget: number;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly costUsd: number | null;
  readonly wallTimeMs: number | null;
  readonly evalTrial: boolean;
  readonly scoredAt: Timestamp;
}
export interface CriteriaCounts { readonly verified: number; readonly failed: number; readonly unverified: number }

export interface EvalSuite { readonly id: EvalSuiteId; readonly workspaceId: WorkspaceId; readonly name: string; readonly createdAt: Timestamp; readonly updatedAt: Timestamp }

export interface EvalCaseInput {
  readonly type: ArtifactType;
  /** sha256 hex of the body; the body lives in the eval blob store under this hash. */
  readonly sha256: string;
  readonly mediaType: string;
  readonly title: string;
  readonly handoff: ArtifactHandoff | null;
}
export interface EvalCaseSnapshot {
  readonly repositoryId: RepositoryId;
  readonly baseSha: string;
  readonly inputs: readonly EvalCaseInput[];
  readonly step: {
    readonly key: string;
    readonly title: string;
    readonly roleId: string;
    readonly objective: string;
    readonly expectedOutputs: readonly ArtifactType[];
    readonly inputArtifacts: readonly ArtifactRequirement[];
    readonly requiredCapabilities: readonly string[];
    readonly completionGate: GateExpression;
    readonly retryPolicy: RetryPolicy;
    readonly maxWallTimeMs: number;
    readonly modelPolicy: Omit<ModelPolicy, 'model' | 'pinned'> | null;
    /** The step-level model the source step pinned, if any; baseline uses it before the role's. */
    readonly stepModel: string | null;
    /** Pins the source step added itself (`from: 'step'`); role pins come from the variant. */
    readonly stepSkills: readonly SkillPin[];
  };
  readonly mission: {
    readonly title: string;
    readonly goal: string;
    readonly constraints: readonly string[];
    readonly knowledge: Workspace['knowledge'];
    readonly decisions: readonly Decision[];
    readonly answers: readonly { readonly key: string; readonly text: string; readonly answer: string }[];
  };
  readonly criteria: readonly EvalCaseCriterion[];
}
export interface EvalCaseCriterion { readonly key: string; readonly statement: string; readonly source: 'user' | 'spec'; readonly covers: readonly string[] }
export interface EvalCaseProvenance {
  readonly missionId: MissionId;
  readonly missionTitle: string;
  readonly taskId: TaskId;
  readonly runId: RunId;
  readonly inputArtifactIds: readonly ArtifactId[];
  readonly referenceOutputs: readonly { readonly type: ArtifactType; readonly sha256: string }[];
}
export interface EvalCase {
  readonly id: EvalCaseId;
  readonly suiteId: EvalSuiteId;
  readonly name: string;
  readonly snapshot: EvalCaseSnapshot;
  readonly provenance: EvalCaseProvenance;
  readonly createdBy: PersonId | null;
  readonly createdAt: Timestamp;
}

export type EvalCandidate =
  | { readonly kind: 'models'; readonly roles: Readonly<Record<string, string>> }
  | { readonly kind: 'skills'; readonly roles: Readonly<Record<string, readonly SkillRef[]>> }
  | { readonly kind: 'setup'; readonly folder: string };

/** A role as one variant runs it: the frozen template plus its resolved role pins. */
export interface EvalRoleVariant { readonly role: RoleTemplate; readonly pins: readonly SkillPin[] }
export interface EvalVariant { readonly label: EvalVariantLabel; readonly roles: Readonly<Record<string, EvalRoleVariant>> }
export type EvalVariantLabel = 'baseline' | 'candidate';

export const EVAL_RUN_STATUSES = ['queued', 'running', 'completed', 'cancelled', 'stopped_at_cap', 'failed'] as const;
export type EvalRunStatus = (typeof EVAL_RUN_STATUSES)[number];
export const EVAL_TRIAL_STATUSES = ['queued', 'running', 'passed', 'failed', 'blocked', 'cancelled'] as const;
export type EvalTrialStatus = (typeof EVAL_TRIAL_STATUSES)[number];

export interface EvalRun {
  readonly id: EvalRunId;
  readonly suiteId: EvalSuiteId;
  readonly workspaceId: WorkspaceId;
  readonly status: EvalRunStatus;
  readonly reason: string | null;
  readonly repeats: number;
  readonly spendCapUsd: number;
  readonly candidate: EvalCandidate;
  readonly variants: { readonly baseline: EvalVariant; readonly candidate: EvalVariant };
  /** Written when the run ends; `Scorecard` from @tandemise/evaluation, stored as JSON. */
  readonly scorecard: unknown | null;
  readonly startedBy: PersonId | null;
  readonly createdAt: Timestamp;
  readonly startedAt: Timestamp | null;
  readonly finishedAt: Timestamp | null;
}

export interface TrialScore {
  readonly gatePassed: boolean;
  readonly attempts: number;
  readonly firstAttemptPassed: boolean;
  readonly criteria: CriteriaCounts | null;
  readonly overBudget: number;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly costUsd: number | null;
  readonly wallTimeMs: number | null;
  readonly model: string | null;
}
export interface EvalTrial {
  readonly id: EvalTrialId;
  readonly runId: EvalRunId;
  readonly caseId: EvalCaseId;
  readonly variant: EvalVariantLabel;
  readonly repeat: number;
  /** Order the runner takes trials in: case → (baseline, candidate) → repeat, so a stopped run keeps pairs. */
  readonly seq: number;
  readonly missionId: MissionId | null;
  readonly status: EvalTrialStatus;
  readonly reason: string | null;
  readonly score: TrialScore | null;
  readonly startedAt: Timestamp | null;
  readonly finishedAt: Timestamp | null;
}
