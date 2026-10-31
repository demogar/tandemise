import type { InboxIntakeDecisionView, IntakeDecision } from '@tandemise/api-contract';
import { ErrorState } from '../../components/primitives.js';
import { useDaemonMutation } from '../../lib/queries.js';
import { relativeTime } from '../../lib/format.js';
import '../Board.css';

/**
 * An Inbox card for a signal intake was unsure about (intake spec §5 step 4,
 * plan Task 14): is it the same as an existing task? Same task links it, New
 * task files it, Not work dismisses it. Without a candidate there is nothing
 * to be the same as, so only New task and Not work are offered.
 */
export function IntakeDecisionRow({ view }: { view: InboxIntakeDecisionView }): JSX.Element {
  const decide = useDaemonMutation((d, decision: IntakeDecision) => d.decideSignal(view.signalId, decision), ['intake']);
  return (
    <div className="list__row inbox__row intake-decision" data-intake-decision={view.signalId}>
      <span className="dot dot--blocked" />
      <div className="list__main">
        <div className="list__title">{view.question || 'Is this new work?'}</div>
        <div className="list__subtitle truncate">
          {view.title}
          <span className="sep">·</span>
          From {view.sourceLabel}
        </div>
        {view.candidate ? (
          <div className="list__subtitle intake-decision__candidate">
            <button type="button" className="intake-decision__link" onClick={() => void window.tandemise.openExternal(view.candidate!.url)}>
              <span className="mono">{view.candidate.key}</span> {view.candidate.title}
            </button>
          </div>
        ) : null}
        {decide.isError ? <ErrorState error={decide.error} /> : null}
      </div>
      <div className="list__aside intake-decision__actions">
        <span className="dim intake-decision__when">{relativeTime(view.receivedAt)}</span>
        {view.candidate ? (
          <button type="button" className="btn btn--primary" disabled={decide.isPending} onClick={() => decide.mutate('same')}>Same task</button>
        ) : null}
        <button type="button" className="btn" disabled={decide.isPending} onClick={() => decide.mutate('new')}>New task</button>
        <button type="button" className="btn btn--ghost" disabled={decide.isPending} onClick={() => decide.mutate('not_work')}>Not work</button>
      </div>
    </div>
  );
}
