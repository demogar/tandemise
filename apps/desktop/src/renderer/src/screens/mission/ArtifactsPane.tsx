import { useEffect, useState } from 'react';
import type { MissionDetail } from '@tandemise/api-contract';
import { ArtifactReader } from '../artifacts/ArtifactReader.js';
import { ArtifactRows } from '../artifacts/ArtifactRows.js';
import { Empty, ErrorState, SkeletonList } from '../../components/primitives.js';
import { useMissionArtifacts } from '../../lib/queries.js';
import { pluralize } from '../../lib/format.js';

/**
 * A mission's artifacts, newest version of each by default.
 *
 * The list comes from the mission's own artifacts endpoint rather than the
 * mission detail, because only that endpoint knows which rows are superseded
 * and what version each one is.
 */
export function ArtifactsPane({ detail }: { detail: MissionDetail }): JSX.Element {
  const missionId = detail.mission.id;
  const [showOlder, setShowOlder] = useState(false);
  const artifacts = useMissionArtifacts(missionId, showOlder);
  const rows = artifacts.data ?? [];
  const [selected, setSelected] = useState<string | null>(null);
  const olderCount = rows.filter((a) => a.supersededBy !== null).length;
  // Whether there is anything to reveal, known before the toggle is used: a live version past v1 has history.
  const hasHistory = showOlder ? olderCount > 0 : rows.some((a) => a.version > 1);

  // Keep the reader on what the user picked while it is still listed; hiding
  // older versions falls back to the newest artifact.
  useEffect(() => {
    setSelected((current) => (current && rows.some((a) => a.id === current) ? current : rows[0]?.id ?? null));
  }, [artifacts.data]);

  if (artifacts.isError) {
    return (
      <div className="page">
        <div className="page__inner">
          <ErrorState error={artifacts.error} onRetry={() => void artifacts.refetch()} />
        </div>
      </div>
    );
  }

  if (artifacts.isPending) {
    return (
      <div className="page">
        <div className="page__inner">
          <SkeletonList rows={4} />
        </div>
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="page">
        <div className="page__inner">
          <div className="card">
            <Empty
              icon="artifacts"
              title="No artifacts yet"
              body="Roles hand work to each other as typed artifacts — a spec, a plan, a review report. They appear here as they are produced."
            />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="reader">
      <div className="reader__list">
        {/* Shown whenever the switch is on, so it can always be turned off again. */}
        {hasHistory || showOlder ? (
          <div className="artifact-list__bar">
            <span>{showOlder ? pluralize(olderCount, 'older version') : 'Newest versions'}</span>
            <label className="row" style={{ gap: 'var(--s2)', cursor: 'pointer' }}>
              Show older versions
              <button
                type="button"
                role="switch"
                className="switch"
                aria-checked={showOlder}
                aria-label="Show older versions"
                onClick={() => setShowOlder((value) => !value)}
              />
            </label>
          </div>
        ) : null}
        <ArtifactRows artifacts={rows} selectedId={selected} onSelect={setSelected} groupByType />
      </div>
      <div className="reader__pane">
        <ArtifactReader id={selected} />
      </div>
    </div>
  );
}
