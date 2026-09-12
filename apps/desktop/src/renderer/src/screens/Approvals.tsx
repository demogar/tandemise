import { PageHeader } from '../components/PageHeader.js';
import { Empty, ErrorState, SkeletonCards } from '../components/primitives.js';
import { ApprovalCard } from './approvals/ApprovalCard.js';
import { useApprovals } from '../lib/queries.js';
import { pluralize } from '../lib/format.js';

export function Approvals(): JSX.Element {
  const approvals = useApprovals();
  const pending = (approvals.data ?? []).filter((view) => view.approval.status === 'PENDING');
  const decided = (approvals.data ?? []).filter((view) => view.approval.status !== 'PENDING');

  return (
    <>
      <PageHeader
        title="Approvals"
        subtitle="One inbox for every decision the workforce needs from you."
        actions={
          pending.length > 0 ? <span className="badge badge--blocked">{pluralize(pending.length, 'decision')} waiting</span> : null
        }
      />

      <div className="page">
        <div className="page__inner">
          {approvals.isError ? <ErrorState error={approvals.error} onRetry={() => void approvals.refetch()} /> : null}

          {approvals.isPending ? (
            <SkeletonCards count={2} />
          ) : pending.length === 0 ? (
            <div className="card">
              <Empty
                icon="check"
                title="Inbox zero"
                body="No plan, permission, choice, or release decision is waiting. When an agent hits something it should not decide alone, the request lands here with its rationale and evidence attached."
              />
            </div>
          ) : (
            <div className="stack" style={{ gap: 'var(--s4)' }}>
              {pending.map((view) => (
                <ApprovalCard key={view.approval.id} view={view} />
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
                {decided.map((view) => (
                  <div key={view.approval.id} className="list__row">
                    <span className={`dot dot--${view.approval.status === 'APPROVED' ? 'succeeded' : 'failed'}`} />
                    <div className="list__main">
                      <div className="list__title">{view.approval.title}</div>
                      <div className="list__subtitle truncate">
                        {view.approval.status === 'APPROVED' ? 'Approved' : 'Rejected'}
                        {view.approval.selectedOptionId ? ` · ${view.approval.selectedOptionId}` : ''}
                        {view.approval.decisionNote ? ` · “${view.approval.decisionNote}”` : ''}
                      </div>
                    </div>
                    <div className="list__aside">
                      <span className="dim" style={{ fontSize: 'var(--fs-xs)' }}>{view.missionTitle}</span>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ) : null}
        </div>
      </div>
    </>
  );
}
