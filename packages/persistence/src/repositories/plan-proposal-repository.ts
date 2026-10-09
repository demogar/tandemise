import { asId, type ApprovalId, type MissionId, type TaskId, type Timestamp } from '@tandemise/shared';
import type { MissionStatus, MissionTask, PlanProposal, PlanProposalRepositoryPort } from '@tandemise/domain';
import type { TandemiseDatabase } from '../database.js';

interface PlanProposalRow {
  approval_id: string;
  mission_id: string;
  tasks: string;
  replaces: string;
  resume_status: string;
  plan_fit_approval_id: string | null;
  created_at: string;
}

/** A replan waiting on its plan card; see migration 021. */
export class SqlitePlanProposalRepository implements PlanProposalRepositoryPort {
  readonly #upsert;
  readonly #select;
  readonly #delete;

  constructor(db: TandemiseDatabase) {
    this.#upsert = db.handle.prepare<PlanProposalRow>(
      `INSERT INTO plan_proposals (approval_id, mission_id, tasks, replaces, resume_status, plan_fit_approval_id, created_at)
       VALUES (:approval_id, :mission_id, :tasks, :replaces, :resume_status, :plan_fit_approval_id, :created_at)
       ON CONFLICT(approval_id) DO UPDATE SET tasks = excluded.tasks, replaces = excluded.replaces,
         resume_status = excluded.resume_status, plan_fit_approval_id = excluded.plan_fit_approval_id`,
    );
    this.#select = db.handle.prepare<{ approvalId: string }, PlanProposalRow>(
      'SELECT * FROM plan_proposals WHERE approval_id = :approvalId',
    );
    this.#delete = db.handle.prepare<{ approvalId: string }>('DELETE FROM plan_proposals WHERE approval_id = :approvalId');
  }

  put(proposal: PlanProposal): void {
    this.#upsert.run({
      approval_id: proposal.approvalId,
      mission_id: proposal.missionId,
      tasks: JSON.stringify(proposal.tasks),
      replaces: JSON.stringify(proposal.replaces),
      resume_status: proposal.resumeStatus,
      plan_fit_approval_id: proposal.planFitApprovalId,
      created_at: proposal.createdAt,
    });
  }

  get(approvalId: ApprovalId): PlanProposal | undefined {
    const row = this.#select.get({ approvalId });
    if (row === undefined) return undefined;
    return {
      approvalId: asId<'ApprovalId'>(row.approval_id),
      missionId: asId<'MissionId'>(row.mission_id) as MissionId,
      tasks: JSON.parse(row.tasks) as MissionTask[],
      replaces: (JSON.parse(row.replaces) as string[]).map((id) => asId<'TaskId'>(id) as TaskId),
      resumeStatus: row.resume_status as MissionStatus,
      planFitApprovalId: row.plan_fit_approval_id === null ? null : asId<'ApprovalId'>(row.plan_fit_approval_id),
      createdAt: row.created_at as Timestamp,
    };
  }

  delete(approvalId: ApprovalId): void {
    this.#delete.run({ approvalId });
  }
}
