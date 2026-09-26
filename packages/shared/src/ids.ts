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
export type PersonId = Brand<string, 'PersonId'>;
export type MemberId = Brand<string, 'MemberId'>;
export type FeedbackId = Brand<string, 'FeedbackId'>;
export type CriterionId = Brand<string, 'CriterionId'>;
export type QuestionId = Brand<string, 'QuestionId'>;
export type LimitIncidentId = Brand<string, 'LimitIncidentId'>;
export type RoutineId = Brand<string, 'RoutineId'>;
export type RoutineRunId = Brand<string, 'RoutineRunId'>;
export type SkillId = Brand<string, 'SkillId'>;
export type SkillVersionId = Brand<string, 'SkillVersionId'>;

const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

/**
 * Sortable, collision-resistant, human-pasteable id: `<prefix>_<time><random>`.
 * Lexicographic order matches creation order, which keeps SQLite indexes and
 * UI lists naturally chronological without an extra sort column.
 *
 * Within one process that order holds even for ids made in the same
 * millisecond: the second one reuses the time and increments the random part
 * of the one before it, as monotonic ULIDs do. Without that, two notes given
 * in the same millisecond sort by their random tails and come back from
 * `ORDER BY created_at, id` in either order.
 */
let lastTime = '';
let lastRand = '';
let lastMs = -1;

export function newId<T extends string>(prefix: string): Brand<string, T> {
  const now = Date.now();
  if (now > lastMs || lastRand === '') {
    const bytes = new Uint8Array(10);
    globalThis.crypto.getRandomValues(bytes);
    let rand = '';
    for (const b of bytes) rand += ALPHABET[b % 32]!;
    lastMs = now;
    lastTime = encodeTime(now);
    lastRand = rand;
  } else {
    // Same millisecond, or the wall clock stepped back: keep the last time and count up from its random part.
    const next = increment(lastRand);
    if (next === null) {
      lastMs += 1;
      lastTime = encodeTime(lastMs);
      lastRand = '0'.repeat(lastRand.length);
    } else {
      lastRand = next;
    }
  }
  return `${prefix}_${lastTime}${lastRand}` as Brand<string, T>;
}

function encodeTime(ms: number): string {
  let ts = ms;
  let time = '';
  for (let i = 0; i < 10; i++) {
    time = ALPHABET[ts % 32]! + time;
    ts = Math.floor(ts / 32);
  }
  return time;
}

/** `value` plus one in base 32, or null when every digit was already the last one. */
function increment(value: string): string | null {
  const digits = value.split('');
  for (let i = digits.length - 1; i >= 0; i--) {
    const d = ALPHABET.indexOf(digits[i]!);
    if (d < 31) {
      digits[i] = ALPHABET[d + 1]!;
      return digits.join('');
    }
    digits[i] = ALPHABET[0]!;
  }
  return null;
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
  person: () => newId<'PersonId'>('per'),
  member: () => newId<'MemberId'>('mem'),
  feedback: () => newId<'FeedbackId'>('fb'),
  criterion: () => newId<'CriterionId'>('crt'),
  question: () => newId<'QuestionId'>('qst'),
  limitIncident: () => newId<'LimitIncidentId'>('lim'),
  routine: () => newId<'RoutineId'>('rtn'),
  routineRun: () => newId<'RoutineRunId'>('rtr'),
  skill: () => newId<'SkillId'>('skl'),
  skillVersion: () => newId<'SkillVersionId'>('skv'),
} as const;

/** Cast a persisted string back to its branded type at a trust boundary. */
export function asId<T extends string>(value: string): Brand<string, T> {
  return value as Brand<string, T>;
}
