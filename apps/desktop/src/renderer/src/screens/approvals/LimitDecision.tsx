import { useState } from 'react';
import type { ApprovalView } from '@tandemise/api-contract';
import { ErrorState } from '../../components/primitives.js';
import { useDaemonMutation } from '../../lib/queries.js';
import { KEEP_PAUSED_OPTION, RAISE_LIMIT_OPTION } from '../../lib/domain.js';

/**
 * The answer to a limit card (P8): a number to raise the limit to, then
 * "Raise limit and resume", or "Keep paused". The daemon refuses a number that
 * would stop the work again at once, and says which number would not.
 */
export function LimitDecision({ view }: { view: ApprovalView }): JSX.Element {
  const { approval } = view;
  const suggested = parseAmount(approval.evidence.find((e) => e.label === 'Suggested')?.value ?? '');
  const [value, setValue] = useState(suggested === null ? '' : String(suggested.amount));
  const [problem, setProblem] = useState<string | null>(null);
  const decide = useDaemonMutation(
    (daemon, body: { optionId: string; raiseTo?: number }) => daemon.decideApproval(approval.id, body),
    ['approvals', 'missions', 'workspaces'],
    approval.missionId ?? undefined,
  );
  const unit = suggested?.unit ?? '';
  const decided = approval.status !== 'PENDING';

  const raise = (): void => {
    const amount = Number(value);
    if (!Number.isFinite(amount) || amount <= 0) {
      setProblem('Give the new limit as a number above zero.');
      return;
    }
    setProblem(null);
    decide.mutate({ optionId: RAISE_LIMIT_OPTION, raiseTo: amount });
  };

  if (decided) {
    return <p className="muted">{approval.selectedOptionId === RAISE_LIMIT_OPTION ? 'The limit was raised and the work resumed.' : 'Kept paused.'}</p>;
  }

  return (
    <div className="decide-inline">
      <div className="decide-inline__row">
        <label className="field" style={{ flex: 'none' }}>
          <span className="field__label">Raise limit to{unit === '' ? '' : ` (${unit})`}</span>
          <input
            className="input"
            type="number"
            min={0}
            step="any"
            style={{ width: 140 }}
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
        </label>
        <button type="button" className="btn btn--primary" disabled={decide.isPending} onClick={raise}>
          Raise limit and resume
        </button>
        <button type="button" className="btn" disabled={decide.isPending} onClick={() => decide.mutate({ optionId: KEEP_PAUSED_OPTION })}>
          Keep paused
        </button>
      </div>
      <span className="decide-inline__hint" data-warn={problem !== null || decide.isError}>
        {problem ?? 'The work resumes where it stopped. Keep paused and nothing more runs; you can raise the limit later.'}
      </span>
      {decide.isError ? <ErrorState error={decide.error} /> : null}
    </div>
  );
}

/** "30 agent minutes" → 30 agent minutes; "$12.00" → 12 USD; "24,000 tokens" → 24000 tokens. */
function parseAmount(text: string): { amount: number; unit: string } | null {
  const match = /^\$?([\d,.]+)\s*(.*)$/.exec(text.trim());
  if (match === null) return null;
  const amount = Number(match[1]!.replace(/,/g, ''));
  if (!Number.isFinite(amount)) return null;
  return { amount, unit: text.trim().startsWith('$') ? 'USD' : match[2]!.trim() };
}
