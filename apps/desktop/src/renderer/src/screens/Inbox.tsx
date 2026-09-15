import { useState } from 'react';
import type { ApprovalView } from '@tandemise/api-contract';
import type { Approval } from '@tandemise/domain';
import { PageHeader } from '../components/PageHeader.js';
import { Icon } from '../components/Icon.js';
import { Attribution } from '../components/ActorChip.js';
import { Empty, ErrorState, Segmented, SkeletonList } from '../components/primitives.js';
import { Modal } from '../components/Modal.js';
import { ApprovalCard, pipelinePosition } from './approvals/ApprovalCard.js';
import { TaskDetail } from './mission/TaskDetail.js';
import { useInbox, type InboxItem } from '../lib/inbox.js';
import { useApprovals, useMission } from '../lib/queries.js';
import { actorsLine, useActors, type Actors } from '../lib/team.js';
import { pluralize, relativeTime, titleCase } from '../lib/format.js';
import { REQUEST_CHANGES_OPTION } from '../lib/domain.js';

type Filter = 'me' | 'everyone';

/**
 * Everything waiting on a person, one line each.
 *
 * The line says what is asked, who it is for and where it came from; the full
 * card - rationale, evidence, options - opens under the row. Scanning twenty
 * one-liners is the job; reading one card is the exception.
 */
export function Inbox(): JSX.Element {
  const inbox = useInbox();
  // Decisions are history, not something waiting: read only while this screen is open.
  const decided = (useApprovals().data ?? []).filter((v) => v.approval.status !== 'PENDING');
  const actors = useActors();
  const [filter, setFilter] = useState<Filter>('me');
  const [open, setOpen] = useState<string | null>(null);
  const [task, setTask] = useState<Extract<InboxItem, { kind: 'task' }> | null>(null);

  const items = filter === 'me' ? inbox.pending.filter((i) => i.forMe) : inbox.pending;
  const others = inbox.pending.length - inbox.forMeCount;

  return (
    <>
      <PageHeader
        title="Inbox"
        subtitle="What is waiting on a person."
        actions={
          // A solo workspace has no "everyone else"; the filter would only add a click.
          actors.solo && others === 0 ? null : (
            <Segmented
              value={filter}
              onChange={setFilter}
              options={[
                { value: 'me', label: `For me${inbox.forMeCount > 0 ? ` · ${inbox.forMeCount}` : ''}` },
                { value: 'everyone', label: `Everyone${inbox.pending.length > 0 ? ` · ${inbox.pending.length}` : ''}` },
              ]}
            />
          )
        }
      />

      <div className="page">
        <div className="page__inner">
          {inbox.error ? <ErrorState error={inbox.error} onRetry={inbox.refetch} /> : null}

          {inbox.isPending ? (
            <SkeletonList rows={3} />
          ) : items.length === 0 ? (
            <div className="card">
              <Empty
                icon="check"
                title={filter === 'me' ? 'Nothing is waiting on you' : 'Nothing is waiting on anyone'}
                body={
                  filter === 'me' && others > 0
                    ? `${pluralize(others, 'request')} ${others === 1 ? 'is' : 'are'} waiting on someone else. Switch to Everyone to see ${others === 1 ? 'it' : 'them'}.`
                    : 'Approvals, questions and tasks for a person land here, one line each.'
                }
              />
            </div>
          ) : (
            <div className="card card--flush">
              {items.map((item) => (
                <div key={item.id}>
                  <InboxRow
                    item={item}
                    actors={actors}
                    open={open === item.id}
                    onClick={() => (item.kind === 'task' ? setTask(item) : setOpen(open === item.id ? null : item.id))}
                  />
                  {item.kind === 'approval' && open === item.id ? (
                    <div className="inbox__open">
                      <ApprovalCard view={item.view} />
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          )}

          {decided.length > 0 ? (
            <section className="section" style={{ marginTop: 'var(--s8)' }}>
              <div className="section__head">
                <h2 className="section__title">Decided</h2>
                <span className="section__meta">{pluralize(decided.length, 'decision')}</span>
              </div>
              <div className="list">
                {decided.slice(0, 30).map((view) => (
                  <DecidedRow key={view.approval.id} view={view} actors={actors} />
                ))}
              </div>
            </section>
          ) : null}
        </div>
      </div>

      {task ? <OpenTask item={task} onClose={() => setTask(null)} /> : null}
    </>
  );
}

/**
 * The task the row opened, kept live. Its mission is read only now, for the one
 * task that was opened - the inbox line carries just enough to list it.
 * Claiming it, or anyone else acting on it, invalidates that query, so the open
 * card follows: otherwise you claim for Bo and the card still offers "Claim".
 */
function OpenTask({ item, onClose }: { item: Extract<InboxItem, { kind: 'task' }>; onClose: () => void }): JSX.Element {
  const mission = useMission(item.task.missionId);
  const task = mission.data?.tasks.find((t) => t.id === item.task.id);
  if (mission.data === undefined || task === undefined) {
    return (
      <Modal title={item.task.title} wide onClose={onClose}>
        {mission.error ? <ErrorState error={mission.error} onRetry={() => void mission.refetch()} /> : <SkeletonList rows={3} />}
      </Modal>
    );
  }
  return <TaskDetail task={task} detail={mission.data} onClose={onClose} />;
}

function InboxRow({ item, actors, open, onClick }: { item: InboxItem; actors: Actors; open: boolean; onClick: () => void }): JSX.Element {
  const title = item.kind === 'approval' ? item.view.approval.title : item.task.title;
  const mission = item.kind === 'approval' ? item.view.missionTitle : item.task.missionTitle;
  const forRefs =
    item.kind === 'approval'
      ? item.view.addressees
      : item.task.assignee
        ? [item.task.assignee, ...item.task.escalatedTo.filter((a) => a.id !== item.task.assignee?.id)]
        : item.task.claimable;
  // Whoever the request climbed to last: the latest addressee of a card, or the latest person a pool was opened to.
  const climbed = item.kind === 'approval' ? item.view.addressees : item.task.escalatedTo;
  const escalatedTo = item.escalated ? climbed[climbed.length - 1] : undefined;
  const label = item.kind === 'task' ? (item.task.assignee ? 'Task' : 'Up for grabs') : kindLabel(item.view.approval);

  return (
    <button type="button" className="list__row inbox__row" data-active={open} onClick={onClick} aria-expanded={item.kind === 'approval' ? open : undefined}>
      <span className={`dot dot--${item.escalated ? 'failed' : item.kind === 'approval' && item.view.approval.kind === 'check' ? 'pending' : 'blocked'}`} />
      <div className="list__main">
        <div className="list__title">{title}</div>
        {/* What the cited artifact concludes, so the line says what is being decided and not only who asks. */}
        {item.kind === 'approval' && item.view.headline ? <div className="inbox__headline truncate">{item.view.headline}</div> : null}
        <div className="list__subtitle truncate">
          {forRefs.length > 0 ? `For ${actorsLine(forRefs, actors.meId)}` : 'For anyone'}
          {escalatedTo ? (
            <>
              <span className="sep">·</span>
              <span className="inbox__escalated">Escalated to {escalatedTo.id === actors.meId ? 'you' : escalatedTo.name}</span>
            </>
          ) : item.escalated ? (
            <>
              <span className="sep">·</span>
              <span className="inbox__escalated">Escalated</span>
            </>
          ) : null}
          {mission ? (
            <>
              <span className="sep">·</span>
              {mission}
            </>
          ) : null}
        </div>
      </div>
      <div className="list__aside">
        <span className="chip chip--muted">{label}</span>
        <span className="dim" style={{ fontSize: 'var(--fs-xs)', minWidth: 56, textAlign: 'right' }}>{relativeTime(item.at)}</span>
        <Icon name={item.kind === 'task' ? 'chevronRight' : open ? 'chevronUp' : 'chevronDown'} size={13} className="dim" />
      </div>
    </button>
  );
}

function kindLabel(approval: Approval): string {
  const position = pipelinePosition(approval);
  if (position) return position;
  if (approval.kind === 'choice') return 'Question';
  return titleCase(approval.kind);
}

function DecidedRow({ view, actors }: { view: ApprovalView; actors: Actors }): JSX.Element {
  const { approval } = view;
  return (
    <div className="list__row">
      <span className={`dot dot--${outcomeTone(approval)}`} />
      <div className="list__main">
        <div className="list__title">{approval.title}</div>
        <div className="list__subtitle truncate">
          {outcomeLabel(approval)}
          {chosenLabel(approval) ? ` · ${chosenLabel(approval)}` : ''}
          {view.decidedByRef ? (
            <>
              <span className="sep">·</span>
              <Attribution by={view.decidedByRef} responsible={null} recordedBy={view.recordedByRef} meId={actors.meId} />
            </>
          ) : null}
          {approval.decisionNote ? ` · “${approval.decisionNote}”` : ''}
        </div>
      </div>
      <div className="list__aside">
        <span className="dim" style={{ fontSize: 'var(--fs-xs)' }}>{view.missionTitle}</span>
      </div>
    </div>
  );
}

/**
 * A question is answered or left to the worker; an authorization is approved or
 * rejected; either can lapse or be withdrawn. "Rejected" for an unanswered
 * question that simply expired would tell you that you said no to something you
 * never saw.
 */
function outcomeLabel(approval: Approval): string {
  const question = approval.kind === 'choice';
  // Stored as a rejection, but the work went back for another round: "Rejected" would read as the end of it.
  if (approval.selectedOptionId === REQUEST_CHANGES_OPTION) return 'Changes requested';
  if (approval.kind === 'check' && (approval.status === 'APPROVED' || approval.status === 'REJECTED')) {
    return approval.status === 'APPROVED' ? 'Looks good' : 'Needs changes';
  }
  switch (approval.status) {
    case 'APPROVED':
      return question ? 'Answered' : 'Approved';
    case 'REJECTED':
      return question ? 'Left to the worker' : 'Rejected';
    case 'EXPIRED':
      return question ? 'Not answered in time' : 'Expired';
    case 'CANCELLED':
      return 'Withdrawn — the work ended first';
    default:
      return approval.status;
  }
}

function outcomeTone(approval: Approval): string {
  if (approval.status === 'APPROVED') return 'succeeded';
  if (approval.selectedOptionId === REQUEST_CHANGES_OPTION) return 'running';
  if (approval.status === 'REJECTED' && approval.kind !== 'choice') return approval.kind === 'check' ? 'blocked' : 'failed';
  return 'pending';
}

/** The option's label, not its id: "Claude Design", not "claude_design". */
function chosenLabel(approval: Approval): string | null {
  if (approval.selectedOptionId === null) return null;
  // Approve and reject are already said by the outcome; repeating them is noise.
  if (approval.kind !== 'choice' && ['approve', 'reject', REQUEST_CHANGES_OPTION, 'looks_good', 'needs_changes'].includes(approval.selectedOptionId)) return null;
  return approval.options.find((o) => o.id === approval.selectedOptionId)?.label ?? approval.selectedOptionId;
}
