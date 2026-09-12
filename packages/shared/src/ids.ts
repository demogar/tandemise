/**
 * Branded identifier types. Prevents accidentally passing a MissionId where a
 * TaskId is expected - a real source of bugs in an orchestrator where almost
 * every function takes three or four different string ids.
 */
declare const brand: unique symbol;
export type Brand<T, B extends string> = T & { readonly [brand]: B };

export type WorkspaceId = Brand<string, 'WorkspaceId'>;
export type RepositoryId = Brand<string, 'RepositoryId'>;
export type MissionId = Brand<string, 'MissionId'>;
export type TaskId = Brand<string, 'TaskId'>;
export type RunId = Brand<string, 'RunId'>;
export type RoleId = Brand<string, 'RoleId'>;
export type RuntimeProfileId = Brand<string, 'RuntimeProfileId'>;
export type ExecutionTargetId = Brand<string, 'ExecutionTargetId'>;
export type IntegrationId = Brand<string, 'IntegrationId'>;
export type WorkerAssignmentId = Brand<string, 'WorkerAssignmentId'>;
export type ArtifactId = Brand<string, 'ArtifactId'>;
export type ApprovalId = Brand<string, 'ApprovalId'>;
export type DecisionId = Brand<string, 'DecisionId'>;
export type EvaluationId = Brand<string, 'EvaluationId'>;
export type EventId = Brand<string, 'EventId'>;
export type PolicyId = Brand<string, 'PolicyId'>;
export type LeaseId = Brand<string, 'LeaseId'>;

const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

/**
 * Sortable, collision-resistant, human-pasteable id: `<prefix>_<time><random>`.
 * Lexicographic order matches creation order, which keeps SQLite indexes and
 * UI lists naturally chronological without an extra sort column.
 */
export function newId<T extends string>(prefix: string): Brand<string, T> {
  const bytes = new Uint8Array(10);
  globalThis.crypto.getRandomValues(bytes);
  let ts = Date.now();
  let time = '';
  for (let i = 0; i < 10; i++) {
    time = ALPHABET[ts % 32]! + time;
    ts = Math.floor(ts / 32);
  }
  let rand = '';
  for (const b of bytes) rand += ALPHABET[b % 32]!;
  return `${prefix}_${time}${rand}` as Brand<string, T>;
}

export const ids = {
  workspace: () => newId<'WorkspaceId'>('ws'),
  repository: () => newId<'RepositoryId'>('repo'),
  mission: () => newId<'MissionId'>('msn'),
  task: () => newId<'TaskId'>('tsk'),
  run: () => newId<'RunId'>('run'),
  runtimeProfile: () => newId<'RuntimeProfileId'>('rt'),
  executionTarget: () => newId<'ExecutionTargetId'>('tgt'),
  integration: () => newId<'IntegrationId'>('int'),
  workerAssignment: () => newId<'WorkerAssignmentId'>('wa'),
  artifact: () => newId<'ArtifactId'>('art'),
  approval: () => newId<'ApprovalId'>('apr'),
  decision: () => newId<'DecisionId'>('dec'),
  evaluation: () => newId<'EvaluationId'>('evl'),
  event: () => newId<'EventId'>('evt'),
  policy: () => newId<'PolicyId'>('pol'),
  lease: () => newId<'LeaseId'>('lse'),
} as const;

/** Cast a persisted string back to its branded type at a trust boundary. */
export function asId<T extends string>(value: string): Brand<string, T> {
  return value as Brand<string, T>;
}
