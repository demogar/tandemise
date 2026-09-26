import { useMemo, useState } from 'react';
import { Link, useLocation } from 'wouter';
import type { MissionStatus } from '@tandemise/domain';
import { PageHeader } from '../components/PageHeader.js';
import { Icon } from '../components/Icon.js';
import { Empty, ErrorState, IdChip, SkeletonList, StatusBadge, StatusDot } from '../components/primitives.js';
import { useMissions } from '../lib/queries.js';
import { useListNavigation } from '../lib/keyboard.js';
import { missionTone, pluralize, relativeTime } from '../lib/format.js';
import { Backlog } from './missions/Backlog.js';

type Filter = 'backlog' | 'active' | 'blocked' | 'finished' | 'all';

// Drafts live in the Backlog tab: they are waiting to be planned, not being worked on.
const ACTIVE: readonly MissionStatus[] = ['PLANNING', 'EXECUTING', 'REVIEWING', 'QA', 'READY_TO_SHIP', 'OBSERVING'];
const BLOCKED: readonly MissionStatus[] = ['BLOCKED', 'AWAITING_PLAN_APPROVAL', 'PAUSED'];
const FINISHED: readonly MissionStatus[] = ['COMPLETE', 'RELEASED', 'FAILED', 'CANCELLED'];

const FILTERS: readonly { value: Filter; label: string }[] = [
  { value: 'backlog', label: 'Backlog' },
  { value: 'active', label: 'Active' },
  { value: 'blocked', label: 'Needs attention' },
  { value: 'finished', label: 'Finished' },
  { value: 'all', label: 'All' },
];

export function Missions(): JSX.Element {
  const [filter, setFilter] = useState<Filter>('active');
  const [query, setQuery] = useState('');
  const [, navigate] = useLocation();
  const missions = useMissions();

  const counts = useMemo(() => {
    const all = missions.data ?? [];
    return {
      backlog: all.filter((m) => m.mission.status === 'DRAFT').length,
      active: all.filter((m) => ACTIVE.includes(m.mission.status)).length,
      blocked: all.filter((m) => BLOCKED.includes(m.mission.status)).length,
      finished: all.filter((m) => FINISHED.includes(m.mission.status)).length,
      all: all.length,
    };
  }, [missions.data]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (missions.data ?? [])
      .filter((summary) => {
        if (filter === 'backlog') return false;
        if (filter === 'active') return ACTIVE.includes(summary.mission.status);
        if (filter === 'blocked') return BLOCKED.includes(summary.mission.status);
        if (filter === 'finished') return FINISHED.includes(summary.mission.status);
        return true;
      })
      .filter(
        (summary) =>
          needle.length === 0 ||
          summary.mission.title.toLowerCase().includes(needle) ||
          summary.mission.goal.toLowerCase().includes(needle),
      );
  }, [missions.data, filter, query]);

  // The Backlog tab has its own keys (it moves rows as well as selecting them).
  const focused = useListNavigation(filter === 'backlog' ? 0 : visible.length, (index) => {
    const target = visible[index];
    if (target) navigate(`/missions/${target.mission.id}`);
  });

  return (
    <>
      <PageHeader
        title="Missions"
        subtitle="Every outcome the workforce is pursuing, past and present."
        actions={
          <>
            <div className="search" style={{ width: 220 }}>
              <Icon name="search" size={14} className="search__icon" />
              <input
                className="input"
                placeholder="Filter missions…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            <Link href="/missions/new" className="btn btn--primary">
              <Icon name="plus" size={14} />
              New mission
            </Link>
          </>
        }
      />

      <div className="tabs">
        {FILTERS.map((option) => (
          <button
            key={option.value}
            type="button"
            className="tab"
            aria-selected={filter === option.value}
            onClick={() => setFilter(option.value)}
          >
            {option.label}
            <span className="tab__count">{counts[option.value]}</span>
          </button>
        ))}
      </div>

      <div className="page">
        <div className="page__inner">
          {missions.isError ? <ErrorState error={missions.error} onRetry={() => void missions.refetch()} /> : null}

          {filter === 'backlog' ? (
            <Backlog />
          ) : missions.isPending ? (
            <SkeletonList rows={5} />
          ) : visible.length === 0 ? (
            <div className="card">
              {query.length > 0 ? (
                <Empty icon="search" title={`Nothing matches “${query}”`} body="Try a shorter phrase, or clear the filter to see every mission." />
              ) : (
                <Empty
                  icon="flag"
                  title={filter === 'active' ? 'No active missions' : 'Nothing here yet'}
                  body="A mission starts with one sentence describing the outcome you want. Tandemise plans the work, picks the runtimes, and brings you only the decisions that need a human."
                  action={
                    <Link href="/missions/new" className="btn btn--primary btn--lg">
                      <Icon name="plus" size={14} />
                      New mission
                    </Link>
                  }
                />
              )}
            </div>
          ) : (
            <>
              <div className="list">
                {visible.map((summary, index) => {
                  const tone = missionTone(summary.mission.status);
                  const { progress } = summary;
                  const percent = progress.totalTasks === 0 ? 0 : Math.round((progress.completed / progress.totalTasks) * 100);
                  return (
                    <Link
                      key={summary.mission.id}
                      href={`/missions/${summary.mission.id}`}
                      className="list__row"
                      data-active={index === focused}
                    >
                      <StatusDot tone={tone} live={tone === 'running'} />
                      <div className="list__main">
                        <div className="list__title" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                          <span className="truncate">{summary.mission.title}</span>
                          <IdChip id={summary.mission.id} />
                        </div>
                        <div className="list__subtitle truncate" title={summary.currentActivity ?? summary.mission.goal}>
                          {summary.currentActivity ?? summary.mission.goal}
                        </div>
                      </div>
                      <div className="list__aside">
                        {progress.pendingApprovals > 0 ? (
                          <span className="badge badge--blocked">
                            <Icon name="approvals" size={11} />
                            {progress.pendingApprovals}
                          </span>
                        ) : null}
                        {summary.repositoryName ? <span className="chip chip--muted">{summary.repositoryName}</span> : null}
                        {progress.totalTasks > 0 ? (
                          <div style={{ width: 84 }}>
                            <div className="meter">
                              <div className="meter__fill" style={{ width: `${percent}%`, background: `var(--status-${tone})` }} />
                            </div>
                            <div className="dim" style={{ fontSize: 'var(--fs-micro)', marginTop: 3, textAlign: 'right' }}>
                              {progress.completed}/{progress.totalTasks}
                            </div>
                          </div>
                        ) : null}
                        <StatusBadge status={summary.mission.status} tone={tone} />
                        <span className="dim" style={{ fontSize: 'var(--fs-xs)', width: 64, textAlign: 'right' }}>
                          {relativeTime(summary.lastEventAt ?? summary.mission.updatedAt)}
                        </span>
                      </div>
                    </Link>
                  );
                })}
              </div>
              <p className="dim" style={{ marginTop: 'var(--s3)', fontSize: 'var(--fs-xs)' }}>
                {pluralize(visible.length, 'mission')} · <kbd>j</kbd> <kbd>k</kbd> to move, <kbd>↵</kbd> to open
              </p>
            </>
          )}
        </div>
      </div>
    </>
  );
}
