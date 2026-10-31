import type { ShipPullRequestView } from '@tandemise/api-contract';
import { useDaemonMutation, useShip } from '../lib/queries.js';
import { Icon } from './Icon.js';
import { ErrorState } from './primitives.js';
import './ShipCard.css';
import { Button } from '@tandemise/design/react';

/**
 * The ship step (#53 §10): opening the pull request, waiting for CI, then
 * either "Waiting for your review" with the reasons and Merge, or merged.
 * Every headline, reason and line is the daemon's.
 */
export function ShipCard({ missionId }: { missionId: string }): JSX.Element | null {
  const ship = useShip(missionId);
  if (ship.isError) return <ErrorState error={ship.error} onRetry={() => void ship.refetch()} />;
  const view = ship.data;
  if (view === undefined) return null;
  return (
    <section className="ship card" aria-label="Pull request" data-stage={view.stage}>
      <div className="ship__head">
        <span className="ship__dot" aria-hidden="true" />
        <span className="ship__headline">{view.headline}</span>
      </div>
      <p className="ship__status">{view.status}</p>
      {view.prs.map((pr) => <ShipPullRequest key={`${pr.repo}#${pr.number}`} missionId={missionId} pr={pr} />)}
    </section>
  );
}

function ShipPullRequest({ missionId, pr }: { missionId: string; pr: ShipPullRequestView }): JSX.Element {
  const merge = useDaemonMutation((daemon, cardId: string) => daemon.decideApproval(cardId, { optionId: 'approve' }), ['ship', 'approvals', 'tasks'], missionId);
  const revert = useDaemonMutation((daemon, decisionId: string) => daemon.revertShip(decisionId), ['ship', 'missions'], missionId);
  const decision = pr.decision;
  return (
    <div className="ship__pr">
      <div className="ship__row">
        <span className="ship__ref">{pr.repo} #{pr.number}</span>
        <Button title={pr.url} onClick={() => void window.tandemise.openExternal(pr.url)}>
          <Icon name="externalLink" size={13} />
          Open in GitHub
        </Button>
        {decision?.cardId != null ? (
          <Button variant="primary" disabled={merge.isPending} onClick={() => merge.mutate(decision.cardId!)}>
            Merge
          </Button>
        ) : null}
        {decision?.canRevert === true ? (
          <Button disabled={revert.isPending || revert.isSuccess} onClick={() => revert.mutate(decision.id)}>
            {revert.isSuccess ? 'Reverting…' : 'Revert'}
          </Button>
        ) : null}
      </div>
      {decision === null ? null : (
        <div className="ship__decision" data-verdict={decision.verdict}>
          {decision.reasons.length > 0 ? (
            <ul className="ship__reasons">
              {decision.reasons.map((r) => <li key={r}>{r}</li>)}
            </ul>
          ) : null}
          <p className="ship__score">{decision.scoreLine}{decision.factors.length > 0 ? `: ${decision.factors.join(', ')}` : ''}</p>
          {decision.wouldHave === null ? null : (
            <p className="ship__would">What would have happened with auto-merge on: {decision.wouldHave}</p>
          )}
          <p className="ship__policy">Checked {decision.headSha.slice(0, 7)} · policy {decision.policyRef}</p>
          {merge.isError ? <p className="ship__error">{(merge.error as Error).message}</p> : null}
          {revert.isError ? <p className="ship__error">{(revert.error as Error).message}</p> : null}
        </div>
      )}
    </div>
  );
}
