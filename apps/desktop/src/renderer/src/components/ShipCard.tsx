import { useShip } from '../lib/queries.js';
import { Icon } from './Icon.js';
import { ErrorState } from './primitives.js';
import './ShipCard.css';

/**
 * The ship step (#53 §10), part 1: "Opening the pull request", then "Pull
 * request opened" with a way to it. The headline and status are the daemon's.
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
      {view.prs.map((pr) => (
        <div key={`${pr.repo}#${pr.number}`} className="ship__pr">
          <span className="ship__ref">{pr.repo} #{pr.number}</span>
          <button type="button" className="btn" title={pr.url} onClick={() => void window.tandemise.openExternal(pr.url)}>
            <Icon name="externalLink" size={13} />
            Open in GitHub
          </button>
        </div>
      ))}
    </section>
  );
}
