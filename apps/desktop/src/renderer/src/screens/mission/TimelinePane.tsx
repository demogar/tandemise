import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'wouter';
import type { MissionDetail } from '@tandemise/api-contract';
import { Icon } from '../../components/Icon.js';
import { Empty, ErrorState, Skeleton } from '../../components/primitives.js';
import { useMissionEvents, useRoles } from '../../lib/queries.js';
import { buildTimeline, rawLines } from '../../lib/events.js';
import { clockTime, relativeTime } from '../../lib/format.js';

/**
 * The live semantic feed (MVP.md §23.3).
 *
 * Default view: what happened, in product language. The raw log is one toggle
 * away and deliberately secondary - it exists for debugging a runtime, not for
 * following a mission.
 */
export function TimelinePane({ detail }: { detail: MissionDetail }): JSX.Element {
  const events = useMissionEvents(detail.mission.id);
  const roles = useRoles();
  const [raw, setRaw] = useState(false);
  const [follow, setFollow] = useState(true);
  const scroller = useRef<HTMLDivElement>(null);

  const roleNames = useMemo(() => new Map((roles.data ?? []).map((role) => [role.id, role.name])), [roles.data]);
  const items = useMemo(() => buildTimeline(events.data ?? [], roleNames), [events.data, roleNames]);
  const lines = useMemo(() => rawLines(events.data ?? []), [events.data]);
  const latestSequence = items[items.length - 1]?.sequence ?? 0;

  // Auto-follow, but stop the moment the user scrolls up to read something.
  useEffect(() => {
    if (!follow) return;
    const element = scroller.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [latestSequence, follow, raw]);

  const onScroll = (): void => {
    const element = scroller.current;
    if (!element) return;
    const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
    setFollow(atBottom);
  };

  return (
    <>
      <div className="row" style={{ padding: 'var(--s3) var(--s7)', borderBottom: '1px solid var(--border)' }}>
        <span className="dim" style={{ fontSize: 'var(--fs-xs)' }}>
          {events.isPending ? 'Loading events…' : `${items.length} events · latest ${relativeTime(items[items.length - 1]?.at)}`}
        </span>
        <div className="spacer" />
        {!follow ? (
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => {
              setFollow(true);
              const element = scroller.current;
              if (element) element.scrollTop = element.scrollHeight;
            }}
          >
            <Icon name="arrowDown" size={13} />
            Jump to latest
          </button>
        ) : (
          <span className="badge badge--running">
            <span className="dot dot--running dot--pulse" />
            Following
          </span>
        )}
        <button type="button" className={`btn${raw ? ' btn--primary' : ' btn--ghost'}`} onClick={() => setRaw((value) => !value)}>
          <Icon name="terminal" size={13} />
          Raw log
        </button>
      </div>

      <div className="page" ref={scroller} onScroll={onScroll}>
        <div className="page__inner">
          {events.isError ? <ErrorState error={events.error} onRetry={() => void events.refetch()} /> : null}

          {events.isPending ? (
            <div className="stack" style={{ gap: 'var(--s4)' }}>
              {Array.from({ length: 5 }, (_, index) => (
                <div key={index} className="row" style={{ gap: 'var(--s3)' }}>
                  <Skeleton height={23} width={23} radius={999} />
                  <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <Skeleton height={13} width={`${35 + ((index * 19) % 40)}%`} />
                    <Skeleton height={11} width={`${20 + ((index * 11) % 30)}%`} />
                  </div>
                </div>
              ))}
            </div>
          ) : raw ? (
            <div className="rawlog">
              {lines.length === 0 ? (
                <span className="dim">No events yet.</span>
              ) : (
                lines.map((line) => (
                  <div key={line.seq} className="rawlog__line">
                    <span className="rawlog__seq">{line.seq}</span>
                    <span>{line.text}</span>
                  </div>
                ))
              )}
            </div>
          ) : items.length === 0 ? (
            <div className="card">
              <Empty
                icon="pulse"
                title="Nothing has happened yet"
                body="When the mission starts, each step appears here in plain language — who did what, which checks ran, and what needs you."
              />
            </div>
          ) : (
            <div className="timeline">
              {items.map((item) => (
                <div key={item.key} className="tlitem" data-tone={item.tone}>
                  <span className="tlitem__node">
                    <Icon name={item.icon} size={12} />
                  </span>
                  <div className="tlitem__body">
                    <div className="tlitem__title">{item.title}</div>
                    {item.detail ? <div className="tlitem__detail">{item.detail}</div> : null}
                    <div className="tlitem__meta">
                      <span>{clockTime(item.at)}</span>
                      {item.role ? (
                        <>
                          <span className="sep">·</span>
                          <span>{item.role}</span>
                        </>
                      ) : null}
                      {item.link?.kind === 'approval' ? (
                        <>
                          <span className="sep">·</span>
                          <Link href="/approvals">Review decision</Link>
                        </>
                      ) : null}
                      {item.link?.kind === 'artifact' ? (
                        <>
                          <span className="sep">·</span>
                          <Link href={`/missions/${detail.mission.id}/artifacts`}>Open artifact</Link>
                        </>
                      ) : null}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
