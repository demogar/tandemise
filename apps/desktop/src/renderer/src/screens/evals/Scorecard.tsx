import { useState } from 'react';
import type { Scorecard as ScorecardData, ScorecardDifferenceView, VariantScoreView } from '@tandemise/api-contract';
import { Icon } from '../../components/Icon.js';
import { duration, metric } from '../../lib/format.js';
import { percent, usd } from './shared.js';

/** Which way is better for a difference: a pass rate should go up; attempts, length, tokens, cost and time should go down. */
type Better = 'higher' | 'lower';

interface Row {
  readonly label: string;
  readonly value: (score: VariantScoreView) => string;
  readonly difference?: { readonly of: (difference: ScorecardDifferenceView) => number | null; readonly better: Better; readonly format: (value: number) => string };
}

const points = (value: number): string => `${Math.round(value * 100)} pts`;
const oneDecimal = (value: number): string => (Math.round(value * 10) / 10).toString();
const count = (value: number): string => new Intl.NumberFormat().format(Math.round(value));

const ROWS: readonly Row[] = [
  {
    label: 'Trials',
    // "Ran" is the rates' denominator (every scored trial); passed and failed split it; errored trials never scored.
    value: ({ trials: t }) =>
      `${t.completed} ran · ${t.completed - t.failed} passed · ${t.failed} failed · ${t.blocked} blocked${t.errored > 0 ? ` · ${t.errored} errored` : ''}`,
  },
  { label: 'Gate pass rate', value: (s) => percent(s.gatePassRate), difference: { of: (d) => d.gatePassRate, better: 'higher', format: points } },
  {
    label: 'First-attempt pass rate',
    value: (s) => percent(s.firstAttemptPassRate),
    difference: { of: (d) => d.firstAttemptPassRate, better: 'higher', format: points },
  },
  {
    label: 'Criteria',
    value: (s) => (s.criteria === null ? '—' : `${s.criteria.verified} verified / ${s.criteria.failed} failed / ${s.criteria.unverified} unverified`),
  },
  {
    label: 'Mean attempts',
    value: (s) => (s.meanAttempts === null ? '—' : oneDecimal(s.meanAttempts)),
    difference: { of: (d) => d.meanAttempts, better: 'lower', format: oneDecimal },
  },
  { label: 'Over-budget outputs', value: (s) => String(s.overBudget), difference: { of: (d) => d.overBudget, better: 'lower', format: count } },
  { label: 'Tokens (mean)', value: (s) => metric(s.tokens.mean === null ? null : Math.round(s.tokens.mean)), difference: { of: (d) => d.meanTokens, better: 'lower', format: count } },
  {
    label: 'Cost (mean, total)',
    value: (s) => (s.costUsd.mean === null ? 'not reported' : `${usd(s.costUsd.mean)} · ${usd(s.costUsd.total)} total`),
    difference: { of: (d) => d.meanCostUsd, better: 'lower', format: (v) => usd(v) },
  },
  {
    label: 'Time (mean)',
    value: (s) => (s.wallTimeMs.mean === null ? 'not reported' : duration(Math.round(s.wallTimeMs.mean))),
    difference: { of: (d) => d.meanWallTimeMs, better: 'lower', format: (v) => duration(Math.round(v)) },
  },
];

/** A difference in the colour of which way it went: better in the success colour, worse in the danger colour, none plain. */
function DifferenceCell({ value, better, format }: { value: number | null; better: Better; format: (value: number) => string }): JSX.Element {
  if (value === null) return <td className="scorecard__num dim">—</td>;
  if (value === 0) return <td className="scorecard__num dim">no change</td>;
  const improved = better === 'higher' ? value > 0 : value < 0;
  const sign = value > 0 ? '+' : '−';
  return (
    <td className={`scorecard__num ${improved ? 'scorecard__diff--better' : 'scorecard__diff--worse'}`} data-direction={improved ? 'better' : 'worse'}>
      {sign}
      {format(Math.abs(value))}
    </td>
  );
}

export function ScoreTable({ baseline, candidate, difference, label }: {
  baseline: VariantScoreView;
  candidate: VariantScoreView;
  difference: ScorecardDifferenceView;
  label: string;
}): JSX.Element {
  return (
    <table className="table scorecard" aria-label={label}>
      <thead>
        <tr>
          <th>Measure</th>
          <th className="scorecard__num">Baseline</th>
          <th className="scorecard__num">Candidate</th>
          <th className="scorecard__num">Difference</th>
        </tr>
      </thead>
      <tbody>
        {ROWS.map((row) => (
          <tr key={row.label} aria-label={row.label}>
            <td className="scorecard__label">{row.label}</td>
            <td className="scorecard__num">{row.value(baseline)}</td>
            <td className="scorecard__num">{row.value(candidate)}</td>
            {row.difference ? (
              <DifferenceCell value={row.difference.of(difference)} better={row.difference.better} format={row.difference.format} />
            ) : (
              <td className="scorecard__num dim">—</td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * An eval run's result (spec B4): the whole suite, then each case on its own
 * row that opens to the same table. Measured facts only; nothing here says
 * which variant "won".
 */
export function Scorecard({ scorecard }: { scorecard: ScorecardData }): JSX.Element {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const toggle = (caseId: string): void =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(caseId)) next.delete(caseId);
      else next.add(caseId);
      return next;
    });

  return (
    <section className="stack" aria-label="Scorecard" style={{ gap: 'var(--s3)' }}>
      <div className="row" style={{ gap: 'var(--s2)', alignItems: 'baseline' }}>
        <h2 className="section__title">Scorecard</h2>
        {scorecard.fewRepeats ? <span className="badge badge--blocked" aria-label="Few repeats">few repeats, differences may be noise</span> : null}
      </div>
      <div className="card card--flush">
        <ScoreTable baseline={scorecard.baseline} candidate={scorecard.candidate} difference={scorecard.difference} label="Whole suite" />
      </div>
      {scorecard.perCase.length > 0 ? (
        <div className="stack" style={{ gap: 'var(--s2)' }}>
          <h3 className="field__label" style={{ margin: 0 }}>By case</h3>
          <div className="list" aria-label="Cases">
            {scorecard.perCase.map((kase) => {
              const expanded = open.has(kase.caseId);
              return (
                <div key={kase.caseId} className="scorecard__case">
                  <button type="button" className="list__row scorecard__case-head" aria-expanded={expanded} onClick={() => toggle(kase.caseId)}>
                    <Icon name={expanded ? 'chevronDown' : 'chevronRight'} size={13} className="dim" />
                    <div className="list__main">
                      <div className="list__title truncate">{kase.name || 'Deleted case'}</div>
                    </div>
                    <span className="list__aside dim">
                      Gate {percent(kase.baseline.gatePassRate)} → {percent(kase.candidate.gatePassRate)}
                    </span>
                  </button>
                  {expanded ? (
                    <div className="scorecard__case-body">
                      <ScoreTable baseline={kase.baseline} candidate={kase.candidate} difference={kase.difference} label={`Case ${kase.name}`} />
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      ) : null}
    </section>
  );
}
