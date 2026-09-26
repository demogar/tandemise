import type { Limit, LimitMetric } from '@tandemise/domain';
import { Field } from './primitives.js';
import { DEFAULT_WARN_PERCENT, LIMIT_METRICS, limitMetricLabel } from '../lib/domain.js';

/**
 * The limit editor (P8): one number per metric, blank for none, and the
 * warning level. Shared by New mission, the mission's Metrics tab and the
 * project's Limits section, so a limit reads the same wherever it is set.
 */
export interface LimitDraft {
  readonly amounts: Readonly<Record<LimitMetric, string>>;
  readonly warn: string;
}

const HINTS: Readonly<Record<LimitMetric, string>> = {
  agent_minutes: 'Time agents spend working, as each runtime reports it or as timed by Tandemise.',
  tokens: 'Input plus output tokens, where the runtime reports them.',
  usd: 'Only where the runtime reports cost. Subscription runtimes do not, and then this limit cannot stop anything.',
};

export function limitDraft(limits: readonly Limit[] | null | undefined): LimitDraft {
  const amounts = Object.fromEntries(LIMIT_METRICS.map((m) => [m, ''])) as Record<LimitMetric, string>;
  let warn = String(DEFAULT_WARN_PERCENT);
  for (const l of limits ?? []) {
    amounts[l.metric] = String(l.amount);
    warn = String(l.warnPercent);
  }
  return { amounts, warn };
}

/** The limits a draft says, or what is wrong with it. Blank amounts are "no limit". */
export function limitsFromDraft(draft: LimitDraft): { limits: { metric: LimitMetric; amount: number; warnPercent: number }[]; error: string | null } {
  const warn = Number(draft.warn);
  if (!Number.isInteger(warn) || warn < 1 || warn > 99) return { limits: [], error: 'Warn at a whole percent between 1 and 99.' };
  const limits: { metric: LimitMetric; amount: number; warnPercent: number }[] = [];
  for (const metric of LIMIT_METRICS) {
    const text = draft.amounts[metric].trim();
    if (text === '') continue;
    const amount = Number(text);
    if (!Number.isFinite(amount) || amount <= 0) return { limits: [], error: `${limitMetricLabel(metric)}: give a number above zero, or leave it blank for no limit.` };
    limits.push({ metric, amount, warnPercent: warn });
  }
  return { limits, error: null };
}

export function LimitFields({
  draft,
  onChange,
  suffix,
}: {
  draft: LimitDraft;
  onChange: (next: LimitDraft) => void;
  /** Said after each label, so two editors on one screen stay apart: "per month". */
  suffix: string;
}): JSX.Element {
  return (
    <div className="grid grid--4">
      {LIMIT_METRICS.map((metric) => (
        <Field key={metric} label={`${limitMetricLabel(metric)} ${suffix}`} hint={HINTS[metric]}>
          <input
            className="input"
            type="number"
            min={0}
            step="any"
            placeholder="No limit"
            value={draft.amounts[metric]}
            onChange={(event) => onChange({ ...draft, amounts: { ...draft.amounts, [metric]: event.target.value } })}
          />
        </Field>
      ))}
      <Field label={`Warn at (%) ${suffix}`} hint="You are told at this share of a limit; work stops at 100%.">
        <input
          className="input"
          type="number"
          min={1}
          max={99}
          value={draft.warn}
          onChange={(event) => onChange({ ...draft, warn: event.target.value })}
        />
      </Field>
    </div>
  );
}
