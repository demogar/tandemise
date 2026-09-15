import { useEffect, useRef, useState } from 'react';
import { Link } from 'wouter';
import type { FeedCard, MissionDetail } from '@tandemise/api-contract';
import { Drawer } from '../../components/Modal.js';
import { HandoffCard } from '../../components/HandoffCard.js';
import { Empty, ErrorState, SkeletonList } from '../../components/primitives.js';
import { useDaemonMutation, useMissionFeed } from '../../lib/queries.js';
import { useActors, type Actors } from '../../lib/team.js';
import { pluralize } from '../../lib/format.js';
import { ArtifactReader } from '../artifacts/ArtifactReader.js';
import { TaskDetail } from './TaskDetail.js';

/** Finished cards shown before "Show N more"; the daemon's default, named here so the button can count past it. */
const DONE_SHOWN = 5;

/**
 * What a mission is doing, in the order a person needs it: what waits on me,
 * what is moving, what is finished.
 *
 * Each card is a handoff, a few lines long, so the whole mission can be taken
 * in without opening a document. "Full doc" and the task drawer are there for
 * the one card that needs more.
 *
 * `focusNeeds` is set when the mission header's "waiting on you" banner is
 * clicked: "Needs you" is brought into view once it has rendered, and
 * `onFocused` clears the request so a later visit does not scroll again.
 */
export function FeedPane({ detail, focusNeeds, onFocused }: { detail: MissionDetail; focusNeeds: boolean; onFocused: () => void }): JSX.Element {
  const missionId = detail.mission.id;
  const [showAllDone, setShowAllDone] = useState(false);
  const feed = useMissionFeed(missionId, showAllDone ? 'all' : DONE_SHOWN);
  const actors = useActors();
  const [reading, setReading] = useState<FeedCard | null>(null);
  const [doing, setDoing] = useState<string | null>(null);
  const needsRef = useRef<HTMLElement>(null);
  const replan = useDaemonMutation((daemon) => daemon.missionAction(missionId, 'plan'), ['missions', 'tasks', 'approvals'], missionId);

  const hasNeeds = (feed.data?.needsYou.length ?? 0) > 0;
  useEffect(() => {
    if (!focusNeeds || !hasNeeds) return;
    needsRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    onFocused();
  }, [focusNeeds, hasNeeds, onFocused]);

  const objectives = new Map(detail.tasks.map((t) => [t.id as string, t.objective]));
  // Looked up live, so the drawer follows the task when someone claims or completes it.
  const doingTask = doing === null ? undefined : detail.tasks.find((t) => t.id === doing);

  const body = ((): JSX.Element => {
    if (feed.isPending) return <SkeletonList rows={4} />;
    if (feed.isError) return <ErrorState error={feed.error} onRetry={() => void feed.refetch()} />;
    const { needsYou, inProgress, done, doneTotal } = feed.data;

    if (needsYou.length + inProgress.length + doneTotal === 0) {
      return (
        <div className="card">
          <Empty
            icon="sparkle"
            title="Nothing has run yet"
            body="Cards appear here as tasks start: what needs you, what is moving, and what is done."
            action={
              <Link href={`/missions/${missionId}/plan`} className="btn">
                See the plan
              </Link>
            }
          />
        </div>
      );
    }

    const card = (c: FeedCard): JSX.Element => (
      <HandoffCard
        key={c.key}
        card={c}
        missionId={missionId}
        actors={actors}
        onFullDoc={setReading}
        onDoIt={(target) => setDoing(target.taskId)}
        onReplan={c.key === 'plan' ? () => replan.mutate(undefined) : undefined}
        replanning={replan.isPending}
        objective={c.taskId === null ? undefined : objectives.get(c.taskId)}
        waitingFor={c.section === 'in_progress' ? waitingFor(c, detail, actors) : undefined}
      />
    );

    return (
      <>
        {needsYou.length > 0 ? (
          <section className="section feed__section" ref={needsRef} id="feed-needs-you" aria-label="Needs you">
            <div className="section__head">
              <h2 className="section__title">Needs you</h2>
              <span className="section__meta">{pluralize(needsYou.length, 'item')}</span>
            </div>
            {replan.isError ? <ErrorState error={replan.error} /> : null}
            <div className="feed__cards">{needsYou.map(card)}</div>
          </section>
        ) : null}

        {inProgress.length > 0 ? (
          <section className="section feed__section" aria-label="In progress">
            <div className="section__head">
              <h2 className="section__title">In progress</h2>
              <span className="section__meta">{pluralize(inProgress.length, 'task')}</span>
            </div>
            <div className="feed__cards">{inProgress.map(card)}</div>
          </section>
        ) : null}

        {doneTotal > 0 ? (
          <section className="section feed__section" aria-label="Done">
            <div className="section__head">
              <h2 className="section__title">Done</h2>
              <span className="section__meta">{doneTotal}</span>
            </div>
            <div className="feed__cards">{done.map(card)}</div>
            {showAllDone && doneTotal > done.length ? (
              // "Show all" asks for the daemon's maximum (FEED_ALL_DONE_LIMIT); past it, say so rather than offer a button that fetches the same list again.
              <p className="section__meta feed__more">
                Showing the latest {done.length} of {doneTotal}; the Plan tab lists every task.
              </p>
            ) : doneTotal > done.length ? (
              <button type="button" className="btn btn--ghost feed__more" onClick={() => setShowAllDone(true)} disabled={feed.isFetching}>
                Show {doneTotal - done.length} more
              </button>
            ) : showAllDone && doneTotal > DONE_SHOWN ? (
              <button type="button" className="btn btn--ghost feed__more" onClick={() => setShowAllDone(false)}>
                Show fewer
              </button>
            ) : null}
          </section>
        ) : null}
      </>
    );
  })();

  return (
    <div className="page">
      {/* Left-aligned with the tabs above it, at a reading measure rather than the page's full width. */}
      <div className="page__inner">
        <div className="feed">{body}</div>
      </div>

      {reading && reading.artifactId ? (
        <Drawer title={reading.title} wide onClose={() => setReading(null)}>
          <ArtifactReader id={reading.artifactId} />
        </Drawer>
      ) : null}

      {doingTask ? <TaskDetail task={doingTask} detail={detail} onClose={() => setDoing(null)} /> : null}
    </div>
  );
}

/**
 * "Waiting for Ana Ruiz" for a card whose open request is addressed to someone
 * else. The feed only carries requests that are mine, and the request's own
 * title ("Approve the output of design?") reads as if it were asking me.
 */
function waitingFor(card: FeedCard, detail: MissionDetail, actors: Actors): string | undefined {
  const open = detail.approvals.find(
    (a) => a.status === 'PENDING' && a.kind !== 'check' && (card.taskId === null ? a.kind === 'plan' : a.taskId === card.taskId),
  );
  const addressees = open?.addressees ?? [];
  if (addressees.length === 0 || (actors.meId !== null && addressees.includes(actors.meId))) return undefined;
  // The latest addressee is where an escalated request sits now.
  return `Waiting for ${actors.name(addressees[addressees.length - 1]!)}`;
}
