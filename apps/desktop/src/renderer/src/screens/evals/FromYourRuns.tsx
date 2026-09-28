import { useState } from 'react';
import { Empty, ErrorState, Segmented, SkeletonList } from '../../components/primitives.js';
import { useRoles, useRunScoreSummary } from '../../lib/queries.js';
import { duration } from '../../lib/format.js';
import { percent, usd } from './shared.js';

type Days = '7' | '30' | '90';

const WINDOWS: readonly { value: Days; label: string }[] = [
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
];

/**
 * How each role has done with each model in real work (spec B1), from the
 * scores every gated step leaves behind. Eval trials never count here.
 */
export function FromYourRuns(): JSX.Element {
  const [days, setDays] = useState<Days>('30');
  const summary = useRunScoreSummary(Number(days) as 7 | 30 | 90);
  const roles = useRoles();
  const roleName = (roleId: string): string => roles.data?.find((r) => r.id === roleId)?.name ?? roleId;
  const rows = summary.data ?? [];

  return (
    <div className="stack" style={{ gap: 'var(--s4)' }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <p className="muted" style={{ margin: 0, fontSize: 'var(--fs-sm)' }}>
          Every gated step your team ran, by role and model. Measured, not judged.
        </p>
        <div aria-label="Window">
          <Segmented value={days} options={WINDOWS} onChange={setDays} />
        </div>
      </div>
      {summary.isError ? (
        <ErrorState error={summary.error} onRetry={() => void summary.refetch()} />
      ) : summary.isPending ? (
        <SkeletonList rows={3} />
      ) : rows.length === 0 ? (
        <div className="card">
          <Empty icon="activity" title="No scores yet" body="Scores start with the first gated step that runs after this update." />
        </div>
      ) : (
        <div className="card card--flush">
          <table className="table scorecard" aria-label="From your runs">
            <thead>
              <tr>
                <th>Role</th>
                <th>Model</th>
                <th className="scorecard__num">Runs</th>
                <th className="scorecard__num">First-attempt pass</th>
                <th className="scorecard__num">Attempts to pass</th>
                <th className="scorecard__num">Criteria failed</th>
                <th className="scorecard__num">Median cost</th>
                <th className="scorecard__num">Median time</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={`${row.roleId}-${row.model ?? ''}`} aria-label={`${roleName(row.roleId)} on ${row.model ?? 'runtime default'}`}>
                  <td>{roleName(row.roleId)}</td>
                  <td className={row.model === null ? 'dim' : 'mono'}>{row.model ?? 'runtime default'}</td>
                  <td className="scorecard__num">{row.runs}</td>
                  <td className="scorecard__num">{percent(row.firstAttemptPassRate)}</td>
                  <td className="scorecard__num">{row.meanAttemptsToPass === null ? '—' : (Math.round(row.meanAttemptsToPass * 10) / 10).toString()}</td>
                  <td className="scorecard__num">{row.criteriaFailed}</td>
                  <td className="scorecard__num">{usd(row.medianCostUsd)}</td>
                  <td className="scorecard__num">{duration(row.medianWallTimeMs === null ? null : Math.round(row.medianWallTimeMs))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
