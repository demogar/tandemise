import type { MissionDetail } from '@tandemise/api-contract';
import { Icon } from '../../components/Icon.js';
import { SectionHead, Stat } from '../../components/primitives.js';
import { dateTime, duration, metric, money } from '../../lib/format.js';

/**
 * MVP.md §22.2: a value the runtime did not report is *unknown*. Rendering it
 * as 0 would be a quiet lie about cost and usage, so nulls stay "not reported"
 * and are visually de-emphasised rather than dressed up as data.
 */
export function MetricsPane({ detail }: { detail: MissionDetail }): JSX.Element {
  const m = detail.metrics;

  return (
    <div className="page">
      <div className="page__inner">
        <section className="section">
          <SectionHead title="Time" meta="Where the mission's clock went" />
          <div className="grid grid--4">
            <Stat label="Wall clock" value={duration(m.wallClockMs)} />
            <Stat label="Runtime active" value={duration(m.runtimeActiveMs)} note={sharePercent(m.runtimeActiveMs, m.wallClockMs)} />
            <Stat label="Waiting on a human" value={duration(m.humanWaitMs)} note={sharePercent(m.humanWaitMs, m.wallClockMs)} />
            <Stat label="Started" value={detail.mission.startedAt ? dateTime(detail.mission.startedAt) : 'Not started'} muted />
          </div>
        </section>

        <section className="section">
          <SectionHead title="Work produced" />
          <div className="grid grid--4">
            <Stat label="Files changed" value={metric(m.filesChanged)} />
            <Stat label="Commits" value={metric(m.commits)} />
            <Stat label="Review findings" value={metric(m.reviewFindings)} />
            <Stat label="QA defects" value={metric(m.qaDefects)} />
          </div>
        </section>

        <section className="section">
          <SectionHead title="Reliability" />
          <div className="grid grid--3">
            <Stat label="Retries" value={metric(m.retries)} />
            <Stat label="Failures" value={metric(m.failures)} />
            <Stat
              label="Runtime fallbacks"
              value={metric(m.runtimeFallbacks)}
              note={m.runtimeFallbacks > 0 ? 'A preferred runtime was unavailable or saturated' : undefined}
            />
          </div>
        </section>

        <section className="section">
          <SectionHead title="Usage and cost" meta="As observed, not as invoiced" />
          <div className="grid grid--3">
            <Stat label="Input tokens" value={metric(m.inputTokens)} muted={m.inputTokens === null} />
            <Stat label="Output tokens" value={metric(m.outputTokens)} muted={m.outputTokens === null} />
            <Stat label="Cost" value={money(m.costUsd)} muted={m.costUsd === null} />
          </div>
          {m.costUsd === null ? (
            <div className="banner" style={{ marginTop: 'var(--s3)' }}>
              <Icon name="info" size={14} className="dim" />
              <span className="muted">
                Subscription-based runtimes do not expose a trustworthy per-run cost, so Tandemise reports nothing rather than a guess.
              </span>
            </div>
          ) : null}
        </section>
      </div>
    </div>
  );
}

function sharePercent(part: number, whole: number): string | undefined {
  if (whole <= 0) return undefined;
  return `${Math.round((part / whole) * 100)}% of wall clock`;
}
