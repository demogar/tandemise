import { useEffect, useState } from 'react';
import { Link, useLocation, useSearch } from 'wouter';
import type { EvalCandidate } from '@tandemise/domain';
import { PageHeader } from '../../components/PageHeader.js';
import { ErrorState, SkeletonList } from '../../components/primitives.js';
import { useEvalSuites } from '../../lib/queries.js';
import { FromYourRuns } from './FromYourRuns.js';
import { RunsTab } from './RunsTab.js';
import { SuitesTab } from './SuitesTab.js';
import { evalsHref, parseEvalsQuery, type EvalsQuery, type EvalsTab } from './link.js';

/**
 * Evals (P3b): steps saved as cases, runs that try a change against them,
 * and how real work has been scoring.
 *
 * Which tab, suite and run are open lives in the query, so another screen can
 * link straight to a prefilled new run ("Try on evals") without the Evals
 * screen having to be open first.
 */
export function Evals(): JSX.Element {
  const query = parseEvalsQuery(useSearch());
  const [, navigate] = useLocation();
  const suites = useEvalSuites();
  const list = suites.data ?? [];
  // A suite named by an old link may have been deleted since: fall back to the first.
  const suiteId = list.some((s) => s.id === query.suite) ? query.suite : list[0]?.id ?? null;
  const go = (next: Partial<EvalsQuery>, replace = false): void => navigate(evalsHref(next), { replace });

  // A new-run form, open, and the candidate a link seeded it with. It lives here rather than in the
  // query: the hash router keeps a query until something replaces it, so a candidate left there would
  // reopen the form every time the screen is visited again, even after a reload.
  const [draft, setDraft] = useState<{ readonly candidate: EvalCandidate | null } | null>(null);
  const linked = query.compose ? { candidate: query.candidate } : null;
  useEffect(() => {
    if (!query.compose) return;
    setDraft({ candidate: query.candidate });
    navigate(evalsHref({ tab: query.tab, suite: query.suite, run: query.run }), { replace: true });
  }, [query.compose, query.candidate, query.tab, query.suite, query.run, navigate]);
  const form = linked ?? draft;

  return (
    <>
      <PageHeader title="Evals" subtitle="Replay finished steps with a different model, skill or setup, and compare what was measured." />

      <div className="tabs" role="tablist">
        <TabLink tab="suites" current={query.tab} label="Suites" suite={suiteId} />
        <TabLink tab="runs" current={query.tab} label="Runs" suite={suiteId} />
        <TabLink tab="yours" current={query.tab} label="From your runs" suite={suiteId} />
      </div>

      {query.tab === 'yours' ? (
        <div className="page">
          <div className="page__inner">
            <FromYourRuns />
          </div>
        </div>
      ) : suites.isError || suites.isPending ? (
        <div className="page">
          <div className="page__inner">
            {suites.isError ? <ErrorState error={suites.error} onRetry={() => void suites.refetch()} /> : <SkeletonList rows={3} />}
          </div>
        </div>
      ) : query.tab === 'suites' ? (
        <SuitesTab suites={list} suiteId={suiteId} onSuite={(id) => go({ tab: 'suites', suite: id }, true)} />
      ) : (
        <RunsTab
          suites={list}
          suiteId={suiteId}
          runId={query.run}
          compose={form !== null}
          candidate={form?.candidate ?? null}
          onSuite={(id) => go({ tab: 'runs', suite: id }, true)}
          onRun={(suite, run) => { setDraft(null); go({ tab: 'runs', suite, run }); }}
          onCompose={() => setDraft({ candidate: null })}
          onCloseForm={() => setDraft(null)}
        />
      )}
    </>
  );
}

function TabLink({ tab, current, label, suite }: { tab: EvalsTab; current: EvalsTab; label: string; suite: string | null }): JSX.Element {
  return (
    <Link href={evalsHref({ tab, suite })} className="tab" role="tab" aria-selected={tab === current}>
      {label}
    </Link>
  );
}
