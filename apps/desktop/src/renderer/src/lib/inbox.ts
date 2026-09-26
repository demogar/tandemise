import { useMemo } from 'react';
import type { ApprovalView, InboxRefinementView, InboxSilentRunView, InboxStalledView, InboxTaskView } from '@tandemise/api-contract';
import { isApprovalForMember, isHumanTaskForMember } from '@tandemise/api-contract/for-me';
import { useInboxView, useMyMemberId } from './queries.js';

export type InboxItem =
  | { readonly kind: 'approval'; readonly id: string; readonly view: ApprovalView; readonly forMe: boolean; readonly escalated: boolean; readonly at: string }
  | { readonly kind: 'task'; readonly id: string; readonly task: InboxTaskView; readonly forMe: boolean; readonly escalated: boolean; readonly at: string }
  | { readonly kind: 'refinement'; readonly id: string; readonly refinement: InboxRefinementView; readonly forMe: boolean; readonly escalated: boolean; readonly at: string }
  | { readonly kind: 'stalled'; readonly id: string; readonly stalled: InboxStalledView; readonly forMe: boolean; readonly escalated: boolean; readonly at: string }
  | { readonly kind: 'quiet'; readonly id: string; readonly run: InboxSilentRunView; readonly forMe: boolean; readonly escalated: boolean; readonly at: string };

/** The mission an item is about, so one mission is never shown twice for one cause. */
export function missionOfItem(item: InboxItem): string | null {
  switch (item.kind) {
    case 'approval': return item.view.approval.missionId;
    case 'task': return item.task.missionId;
    case 'refinement': return item.refinement.missionId;
    case 'stalled': return item.stalled.missionId;
    case 'quiet': return item.run.missionId;
  }
}

/**
 * Everything waiting on a person: open approvals and tasks parked for a human.
 *
 * One daemon read (`GET /v1/inbox`) feeds the nav badge, Home and the Inbox, so
 * the three can never disagree and the always-mounted badge never fans out into
 * a mission detail per working mission.
 *
 * "For me" follows the addressees the daemon wrote, which are advisory until
 * accounts exist. The rule itself lives in `@tandemise/api-contract/for-me`,
 * shared with the daemon's mission feed so the two never disagree.
 */
export function useInbox(): {
  readonly pending: readonly InboxItem[];
  readonly forMeCount: number;
  /** For me, minus checks: what actually waits on me. Home's "Needs you now". */
  readonly needsMe: readonly InboxItem[];
  readonly isPending: boolean;
  readonly error: unknown;
  readonly refetch: () => void;
} {
  const meId = useMyMemberId();
  const inbox = useInboxView();

  return useMemo(() => {
    const items: InboxItem[] = [];
    for (const view of inbox.data?.approvals ?? []) {
      if (view.approval.status !== 'PENDING') continue;
      items.push({
        kind: 'approval',
        id: view.approval.id,
        view,
        forMe: isApprovalForMember(view.addressees.map((a) => a.id), meId),
        escalated: view.escalationLevel > 0,
        at: view.approval.createdAt,
      });
    }
    for (const task of inbox.data?.tasks ?? []) {
      // Read from what the escalation recorded, not from the wording of the status line.
      const escalated = task.escalatedTo.length > 0;
      const people = {
        assigneeId: task.assignee?.id ?? null,
        claimableIds: task.claimable.map((c) => c.id),
        escalatedToIds: task.escalatedTo.map((a) => a.id),
      };
      items.push({
        kind: 'task',
        id: task.id,
        task,
        forMe: isHumanTaskForMember(people, meId),
        escalated,
        at: task.updatedAt,
      });
    }
    // A request that cannot be planned until its creator decides what refinement proposed (P6).
    for (const refinement of inbox.data?.refinements ?? []) {
      items.push({
        kind: 'refinement',
        id: `refinement:${refinement.missionId}`,
        refinement,
        forMe: refinement.forIds.length === 0 || (meId !== null && refinement.forIds.includes(meId)),
        escalated: false,
        at: refinement.updatedAt,
      });
    }
    // A mission nothing moves and nothing asks about (P9): one row, derived by the daemon, gone when it can move.
    for (const stalled of inbox.data?.stalled ?? []) {
      items.push({
        kind: 'stalled',
        id: `stalled:${stalled.missionId}`,
        stalled,
        forMe: stalled.forIds.length === 0 || (meId !== null && stalled.forIds.includes(meId)),
        escalated: false,
        at: stalled.since,
      });
    }
    // An agent quiet past its threshold: asked before its wall-time budget runs out.
    for (const run of inbox.data?.silentRuns ?? []) {
      items.push({
        kind: 'quiet',
        id: `quiet:${run.runId}`,
        run,
        forMe: run.forIds.length === 0 || (meId !== null && run.forIds.includes(meId)),
        escalated: false,
        at: run.lastEventAt,
      });
    }
    // Escalated first: someone already missed it. Then oldest, because it has waited longest.
    items.sort((a, b) => Number(b.escalated) - Number(a.escalated) || Date.parse(a.at) - Date.parse(b.at));
    return {
      pending: items,
      forMeCount: items.filter((i) => i.forMe).length,
      needsMe: items.filter((i) => i.forMe && !(i.kind === 'approval' && i.view.approval.kind === 'check')),
      isPending: inbox.isPending,
      error: inbox.error ?? null,
      refetch: () => void inbox.refetch(),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inbox.data, inbox.isPending, inbox.error, meId]);
}
