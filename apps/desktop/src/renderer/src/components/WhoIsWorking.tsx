import { Link } from 'wouter';
import type { CoordinationClaimRowView } from '@tandemise/api-contract';
import { useCoordinationClaims } from '../lib/queries.js';
import { ErrorState, SkeletonList } from './primitives.js';
import { Tooltip } from '@tandemise/design/react';
import './WhoIsWorking.css';

const PRESENCE_WORDS: Readonly<Record<CoordinationClaimRowView['presence'], string>> = {
  online: 'Online',
  away: 'Away',
  offline: 'Offline',
};

/**
 * "Who's working on what" (relay spec, §What the desktop shows): one row per
 * active claim in this project, your own first. Facts only: a name, the
 * tracker item, and since when.
 */
export function WhoIsWorking(): JSX.Element {
  const claims = useCoordinationClaims();
  if (claims.isPending) return <SkeletonList rows={2} />;
  if (claims.isError) return <ErrorState error={claims.error} onRetry={() => void claims.refetch()} />;
  const rows = claims.data ?? [];
  if (rows.length === 0) {
    return <p className="who-working__empty">Nobody is working on a tracker item right now.</p>;
  }
  return (
    <ul className="who-working" aria-label="Claims">
      {rows.map((row) => (
        <li key={row.claimId} className="who-working__row" data-mine={row.mine} data-stale={row.stale}>
          <Tooltip content={PRESENCE_WORDS[row.presence]}>
            <span className="who-working__dot" data-presence={row.presence} role="img" aria-label={PRESENCE_WORDS[row.presence]} />
          </Tooltip>
          <span className="who-working__name">{row.memberName}</span>
          {row.itemUrl ? (
            <Tooltip content={`Open ${row.itemKey}`}>
              <button type="button" className="who-working__key" onClick={() => void window.tandemise.openExternal(row.itemUrl!)}>
                {row.itemKey}
              </button>
            </Tooltip>
          ) : (
            <span className="who-working__key">{row.itemKey}</span>
          )}
          {row.missionId ? (
            <Link href={`/missions/${row.missionId}`} className="who-working__title">{row.itemTitle}</Link>
          ) : (
            <span className="who-working__title">{row.itemTitle}</span>
          )}
          <span className="who-working__since">{row.stale && row.staleLabel ? row.staleLabel : `since ${row.since}`}</span>
          {row.mine && row.sync === 'pending' ? <span className="who-working__badge" data-sync="pending">Pending</span> : null}
          {row.mine && row.sync === 'conflicted' ? <span className="who-working__badge" data-sync="conflicted">Conflicted</span> : null}
        </li>
      ))}
    </ul>
  );
}
