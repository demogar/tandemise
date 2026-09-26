import { Link, useLocation } from 'wouter';
import type { HomeView, MissionSummary } from '@tandemise/api-contract';
import { PageHeader } from '../components/PageHeader.js';
import { Icon } from '../components/Icon.js';
import { Empty, ErrorState, SectionHead, SkeletonCards, SkeletonList, StatusBadge, StatusDot } from '../components/primitives.js';
import { ApprovalPreviewCard } from './approvals/ApprovalCard.js';
import { useHome, useRoles } from '../lib/queries.js';
import { useInbox, type InboxItem } from '../lib/inbox.js';
import { buildTimeline } from '../lib/events.js';
import { useActors } from '../lib/team.js';
import { healthTone, missionTone, pluralize, relativeTime } from '../lib/format.js';

export function Home(): JSX.Element {
  const home = useHome();
  const roles = useRoles();
  // The same inbox read as the nav badge. The badge counts everything for me;
  // Home leaves out checks, which nothing waits on.
  const needsMe = useInbox().needsMe;
  const [, navigate] = useLocation();

  const roleNames = new Map((roles.data ?? []).map((role) => [role.id, role.name]));
  const actors = useActors();
  const data = home.data;

  return (
    <>
      <PageHeader
        title={headline(data, needsMe.length)}
        subtitle={data?.workspace ? `${data.workspace.name} workspace` : 'Your agent workforce at a glance'}
        actions={
          <button type="button" className="btn btn--primary" onClick={() => navigate('/missions/new')}>
            <Icon name="plus" size={14} />
            New mission
          </button>
        }
      />

      <div className="page">
        <div className="page__inner">
          {home.isError ? <ErrorState error={home.error} onRetry={() => void home.refetch()} /> : null}

          <section className="section">
            <SectionHead
              title="Needs you now"
              meta={data ? describeAttention(needsMe.length, data.blockedMissions.length) : undefined}
            />
            {home.isPending ? (
              <SkeletonCards count={2} />
            ) : needsMe.length === 0 && (data?.blockedMissions.length ?? 0) === 0 ? (
              <div className="card">
                <Empty
                  icon="check"
                  title="Nothing is waiting on you"
                  body="Every mission is either running on its own or finished. New approvals will land here the moment an agent needs a decision."
                />
              </div>
            ) : (
              <div className="stack">
                {needsMe.slice(0, 2).map((item) =>
                  item.kind === 'approval' ? (
                    <ApprovalPreviewCard key={item.id} view={item.view} />
                  ) : item.kind === 'task' ? (
                    <HumanTaskRow key={item.id} item={item} />
                  ) : (
                    <RefinementRow key={item.id} item={item} />
                  ),
                )}
                {needsMe.length > 2 ? (
                  <Link href="/inbox" className="btn btn--ghost" style={{ alignSelf: 'flex-start' }}>
                    {pluralize(needsMe.length - 2, 'more request')} in your inbox
                    <Icon name="chevronRight" size={13} />
                  </Link>
                ) : null}
                {(data?.blockedMissions ?? []).map((summary) => (
                  <MissionRow key={summary.mission.id} summary={summary} />
                ))}
              </div>
            )}
          </section>

          <div className="split">
            <section className="section">
              <SectionHead
                title="Active missions"
                meta={data ? pluralize(data.activeMissions.length, 'mission') : undefined}
                action={
                  <Link href="/missions" className="btn btn--ghost">
                    All missions
                    <Icon name="chevronRight" size={13} />
                  </Link>
                }
              />
              {home.isPending ? (
                <SkeletonList rows={3} />
              ) : (data?.activeMissions.length ?? 0) === 0 ? (
                <div className="card">
                  <Empty
                    icon="flag"
                    title="No missions running"
                    body="Describe an outcome in one sentence and Tandemise will plan the work, route it to your runtimes, and bring you the decisions."
                    action={
                      <button type="button" className="btn btn--primary" onClick={() => navigate('/missions/new')}>
                        <Icon name="plus" size={14} />
                        Start a mission
                      </button>
                    }
                  />
                </div>
              ) : (
                <div className="list">
                  {(data?.activeMissions ?? []).map((summary) => (
                    <MissionListRow key={summary.mission.id} summary={summary} />
                  ))}
                </div>
              )}
            </section>

            <section className="section">
              <SectionHead title="Runtime health" action={<Link href="/runtimes" className="btn btn--ghost">Manage</Link>} />
              {home.isPending ? (
                <SkeletonList rows={2} />
              ) : (data?.runtimes.length ?? 0) === 0 ? (
                <div className="card">
                  <Empty
                    icon="runtimes"
                    title="No runtimes configured"
                    body="Tandemise needs at least one agent runtime to do any work. Discovery finds the CLIs already installed on this machine."
                    action={
                      <Link href="/runtimes" className="btn">
                        Discover runtimes
                      </Link>
                    }
                  />
                </div>
              ) : (
                <div className="list">
                  {(data?.runtimes ?? []).map((runtime) => (
                    <div key={runtime.profile.id} className="list__row">
                      <StatusDot tone={healthTone(runtime.health.state)} />
                      <div className="list__main">
                        <div className="list__title">{runtime.profile.name}</div>
                        <div className="list__subtitle truncate" title={runtime.health.detail}>
                          {runtime.health.version ? `v${runtime.health.version}` : 'version unknown'}
                          <span className="sep">·</span>
                          {runtime.health.detail}
                        </div>
                      </div>
                      <div className="list__aside">
                        {runtime.activeRuns > 0 ? (
                          <span className="badge badge--running">
                            {runtime.activeRuns}/{runtime.profile.maxConcurrent} active
                          </span>
                        ) : (
                          <span className="chip chip--muted">idle</span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <div style={{ marginTop: 'var(--s6)' }}>
                <SectionHead title="Recent activity" />
                {home.isPending ? (
                  <SkeletonList rows={3} />
                ) : (data?.recentEvents.length ?? 0) === 0 ? (
                  <div className="card">
                    <Empty icon="pulse" title="Quiet so far" body="Semantic events from every mission appear here as work happens." />
                  </div>
                ) : (
                  <div className="card">
                    <div className="timeline">
                      {buildTimeline(data?.recentEvents ?? [], roleNames, actors.name)
                        .slice(-7)
                        .reverse()
                        .map((item) => (
                          <div key={item.key} className="tlitem" data-tone={item.tone}>
                            <span className="tlitem__node">
                              <Icon name={item.icon} size={12} />
                            </span>
                            <div className="tlitem__body">
                              <div className="tlitem__title">{item.title}</div>
                              <div className="tlitem__meta">{relativeTime(item.at)}</div>
                            </div>
                          </div>
                        ))}
                    </div>
                  </div>
                )}
              </div>
            </section>
          </div>

          {(data?.recentMissions.length ?? 0) > 0 ? (
            <section className="section">
              <SectionHead title="Recently finished" />
              <div className="list">
                {(data?.recentMissions ?? []).map((summary) => (
                  <MissionListRow key={summary.mission.id} summary={summary} />
                ))}
              </div>
            </section>
          ) : null}
        </div>
      </div>
    </>
  );
}

function MissionListRow({ summary }: { summary: MissionSummary }): JSX.Element {
  const tone = missionTone(summary.mission.status);
  const { progress } = summary;
  const percent = progress.totalTasks === 0 ? 0 : Math.round((progress.completed / progress.totalTasks) * 100);

  return (
    <Link href={`/missions/${summary.mission.id}`} className="list__row">
      <StatusDot tone={tone} live={tone === 'running'} />
      <div className="list__main">
        <div className="list__title">{summary.mission.title}</div>
        <div className="list__subtitle truncate" title={summary.currentActivity ?? summary.mission.goal}>
          {summary.currentActivity ?? summary.mission.goal}
          {summary.repositoryName ? (
            <>
              <span className="sep">·</span>
              <span className="dim">{summary.repositoryName}</span>
            </>
          ) : null}
        </div>
      </div>
      <div className="list__aside">
        {progress.totalTasks > 0 ? (
          <div style={{ width: 76 }}>
            <div className="meter">
              <div className={`meter__fill`} style={{ width: `${percent}%`, background: `var(--status-${tone})` }} />
            </div>
            <div className="dim" style={{ fontSize: 'var(--fs-micro)', marginTop: 3, textAlign: 'right' }}>
              {progress.completed}/{progress.totalTasks} tasks
            </div>
          </div>
        ) : null}
        <StatusBadge status={summary.mission.status} tone={tone} />
        <span className="dim" style={{ fontSize: 'var(--fs-xs)', width: 62, textAlign: 'right' }}>
          {relativeTime(summary.lastEventAt ?? summary.mission.updatedAt)}
        </span>
      </div>
    </Link>
  );
}

/** A blocked mission gets a full card, not a row: it is asking for something. */
function MissionRow({ summary }: { summary: MissionSummary }): JSX.Element {
  return (
    <Link href={`/missions/${summary.mission.id}`} className="card" style={{ display: 'block', textDecoration: 'none', color: 'inherit' }}>
      <div className="row">
        <span className="badge badge--blocked">
          <Icon name="alert" size={12} />
          Blocked
        </span>
        <span style={{ fontWeight: 560 }}>{summary.mission.title}</span>
        <div className="spacer" />
        <span className="dim" style={{ fontSize: 'var(--fs-xs)' }}>{relativeTime(summary.lastEventAt)}</span>
      </div>
      <p className="muted" style={{ marginTop: 'var(--s2)', fontSize: 'var(--fs-sm)', lineHeight: 1.55 }}>
        {summary.mission.statusReason ?? summary.currentActivity ?? 'This mission stopped and needs a human to move it forward.'}
      </p>
    </Link>
  );
}

/** A task parked for me, on the one line the Inbox gives it; opening it goes to its mission. */
function HumanTaskRow({ item }: { item: Extract<InboxItem, { kind: 'task' }> }): JSX.Element {
  return (
    <Link href={`/missions/${item.task.missionId}`} className="list__row list__row--bordered" style={{ textDecoration: 'none', color: 'inherit' }}>
      <StatusDot tone="blocked" />
      <div className="list__main">
        <div className="list__title">{item.task.title}</div>
        <div className="list__subtitle truncate">Yours to do · {item.task.missionTitle}</div>
      </div>
      <Icon name="chevronRight" size={13} className="dim" />
    </Link>
  );
}

function RefinementRow({ item }: { item: Extract<InboxItem, { kind: 'refinement' }> }): JSX.Element {
  return (
    <Link href={`/missions/${item.refinement.missionId}`} className="list__row list__row--bordered" style={{ textDecoration: 'none', color: 'inherit' }}>
      <StatusDot tone="blocked" />
      <div className="list__main">
        <div className="list__title">Refinement: {item.refinement.toDecide} to decide</div>
        <div className="list__subtitle truncate">Get it ready to plan · {item.refinement.missionTitle}</div>
      </div>
      <Icon name="chevronRight" size={13} className="dim" />
    </Link>
  );
}

function describeAttention(waiting: number, blocked: number): string {
  const parts: string[] = [];
  if (waiting > 0) parts.push(pluralize(waiting, 'request'));
  if (blocked > 0) parts.push(`${pluralize(blocked, 'mission')} blocked`);
  return parts.length > 0 ? parts.join(' · ') : 'all clear';
}

/**
 * The title states what the workforce needs, in priority order. A time-of-day
 * greeting looked friendly but told the user nothing they could act on - and
 * "Still up" at 2am read as a judgement rather than a status.
 */
function headline(data: HomeView | undefined, waiting: number): string {
  if (!data) return 'Home';
  const blocked = data.blockedMissions.length;
  const running = data.activeMissions.length;
  if (waiting > 0) return `${pluralize(waiting, 'request')} waiting on you`;
  if (blocked > 0) return `${pluralize(blocked, 'mission')} blocked`;
  if (running > 0) return `${pluralize(running, 'mission')} running`;
  return 'Nothing needs you';
}
