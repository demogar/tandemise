import { token } from '@tandemise/kernel';
import type {
  ApprovalRepositoryPort, ArtifactRepositoryPort, AssignmentRepositoryPort,
  CheckpointRepositoryPort, DecisionRepositoryPort, EvaluationRepositoryPort,
  EventRepositoryPort, ExecutionTargetRepositoryPort, FeedbackRepositoryPort, IntegrationRepositoryPort,
  LeaseRepositoryPort, MemberRepositoryPort, MissionCriteriaRepositoryPort, MissionQuestionRepositoryPort, MissionRepositoryPort, LimitRepositoryPort, PersonRepositoryPort,
  RepoRepositoryPort, RoleRepositoryPort, RunInputRepositoryPort,
  RunRepositoryPort, RuntimeProfileRepositoryPort, TaskRepositoryPort, UnitOfWork,
  WorkspaceRepositoryPort,
} from '@tandemise/domain';
import type { TandemiseDatabase } from './database.js';

/**
 * Tokens for the persistence ports.
 *
 * They live here rather than in `@tandemise/domain` only because domain does
 * not depend on `@tandemise/kernel`. The token is still a *contract* name: a
 * consumer that resolves `MISSION_REPOSITORY` gets the port interface and has
 * no path to SQLite, which is what keeps the mission engine swappable against
 * an in-memory double (MVP.md §6.1).
 */

export const DATABASE = token<TandemiseDatabase>('persistence.Database');
export const UNIT_OF_WORK = token<UnitOfWork>('persistence.UnitOfWork');

export const WORKSPACE_REPOSITORY = token<WorkspaceRepositoryPort>('persistence.WorkspaceRepository');
export const REPO_REPOSITORY = token<RepoRepositoryPort>('persistence.RepoRepository');
export const MISSION_REPOSITORY = token<MissionRepositoryPort>('persistence.MissionRepository');
export const TASK_REPOSITORY = token<TaskRepositoryPort>('persistence.TaskRepository');
export const RUN_REPOSITORY = token<RunRepositoryPort>('persistence.RunRepository');
export const EVENT_REPOSITORY = token<EventRepositoryPort>('persistence.EventRepository');
export const ARTIFACT_REPOSITORY = token<ArtifactRepositoryPort>('persistence.ArtifactRepository');
export const APPROVAL_REPOSITORY = token<ApprovalRepositoryPort>('persistence.ApprovalRepository');
export const ROLE_REPOSITORY = token<RoleRepositoryPort>('persistence.RoleRepository');
export const RUNTIME_PROFILE_REPOSITORY = token<RuntimeProfileRepositoryPort>('persistence.RuntimeProfileRepository');
export const EXECUTION_TARGET_REPOSITORY = token<ExecutionTargetRepositoryPort>('persistence.ExecutionTargetRepository');
export const INTEGRATION_REPOSITORY = token<IntegrationRepositoryPort>('persistence.IntegrationRepository');
export const ASSIGNMENT_REPOSITORY = token<AssignmentRepositoryPort>('persistence.AssignmentRepository');
export const DECISION_REPOSITORY = token<DecisionRepositoryPort>('persistence.DecisionRepository');
export const EVALUATION_REPOSITORY = token<EvaluationRepositoryPort>('persistence.EvaluationRepository');
export const CHECKPOINT_REPOSITORY = token<CheckpointRepositoryPort>('persistence.CheckpointRepository');
export const LEASE_REPOSITORY = token<LeaseRepositoryPort>('persistence.LeaseRepository');
export const PERSON_REPOSITORY = token<PersonRepositoryPort>('persistence.PersonRepository');
export const MEMBER_REPOSITORY = token<MemberRepositoryPort>('persistence.MemberRepository');
export const FEEDBACK_REPOSITORY = token<FeedbackRepositoryPort>('persistence.FeedbackRepository');
export const RUN_INPUT_REPOSITORY = token<RunInputRepositoryPort>('persistence.RunInputRepository');
export const MISSION_CRITERIA_REPOSITORY = token<MissionCriteriaRepositoryPort>('persistence.MissionCriteriaRepository');
export const MISSION_QUESTION_REPOSITORY = token<MissionQuestionRepositoryPort>('persistence.MissionQuestionRepository');
export const LIMIT_REPOSITORY = token<LimitRepositoryPort>('persistence.LimitRepository');
