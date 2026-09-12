import { useState } from 'react';
import { Link, useLocation } from 'wouter';
import type { MissionDetail as MissionDetailView } from '@tandemise/api-contract';
import type { MissionStatus } from '@tandemise/domain';
import { isTerminalMissionStatus } from '@tandemise/domain';
import { PageHeader } from '../../components/PageHeader.js';
import { Icon, type IconName } from '../../components/Icon.js';
import { ConfirmDialog } from '../../components/Modal.js';
import { Empty, ErrorState, Skeleton, SkeletonList, StatusBadge } from '../../components/primitives.js';
import { PlanPane } from './PlanPane.js';
import { TimelinePane } from './TimelinePane.js';
import { ArtifactsPane } from './ArtifactsPane.js';
import { ChecksPane } from './ChecksPane.js';
import { MetricsPane } from './MetricsPane.js';
import { useDaemonMutation, useMission } from '../../lib/queries.js';
import { missionTone, pluralize } from '../../lib/format.js';

const TABS = ['plan', 'timeline', 'artifacts', 'checks', 'metrics'] as const;
export type MissionTab = (typeof TABS)[number];

export function MissionDetail({ id, tab }: { id: string; tab: MissionTab }): JSX.Element {
  const mission = useMission(id);
  const [, navigate] = useLocation();
  const [confirming, setConfirming] = useState<'cancel' | 'delete' | null>(null);

  const act = useDaemonMutation(
    (daemon, args: { action: 'plan' | 'start' | 'pause' | 'resume' | 'cancel' }) => daemon.missionAction(id, args.action),
    ['missions', 'tasks'],
    id,
  );
  const remove = useDaemonMutation((daemon) => daemon.deleteMission(id), ['missions']);

  if (mission.isPending) return <MissionSkeleton />;
  if (mission.isError) {
    return (
      <>
        <PageHeader title="Mission" crumbs={[{ label: 'Missions', href: '/missions' }]} />
        <div className="page">
          <div className="page__inner">
            <ErrorState error={mission.error} onRetry={() => void mission.refetch()} />
          </div>
        </div>
      </>
    );
  }

  const detail = mission.data;
  const status = detail.mission.status;
  const tone = missionTone(status);
  const pendingApprovals = detail.approvals.filter((approval) => approval.status === 'PENDING');

  return (
    <>
      <PageHeader
        title={detail.mission.title}
        crumbs={[{ label: 'Missions', href: '/missions' }, { label: detail.mission.workflowPreset }]}
        subtitle={detail.mission.goal}
        actions={
          <>
            <StatusBadge status={status} tone={tone} />
            {actionsFor(status).map((action) => (
              <button
                key={action.id}
                type="button"
                className={`btn${action.primary ? ' btn--primary' : ''}`}
                disabled={act.isPending}
                onClick={() => (action.id === 'cancel' ? setConfirming('cancel') : act.mutate({ action: action.id }))}
              >
                <Icon name={action.icon} size={13} />
                {action.label}
              </button>
            ))}
            <button type="button" className="btn btn--icon btn--ghost" title="Delete mission" onClick={() => setConfirming('delete')}>
              <Icon name="trash" size={14} />
            </button>
          </>
        }
      />

      {act.isError ? (
        <div style={{ padding: 'var(--s3) var(--s7) 0' }}>
          <ErrorState error={act.error} />
        </div>
      ) : null}

      {pendingApprovals.length > 0 ? (
        <Link
          href="/approvals"
          className="banner banner--warn"
          style={{ margin: 'var(--s3) var(--s7) 0', textDecoration: 'none', color: 'inherit' }}
        >
          <Icon name="approvals" size={15} />
          <span style={{ flex: 1 }}>
            <strong>{pluralize(pendingApprovals.length, 'decision')} waiting on you.</strong>{' '}
            {pendingApprovals[0]?.title}
          </span>
          <span className="btn">Review</span>
        </Link>
      ) : null}

      {status === 'BLOCKED' && detail.mission.statusReason ? (
        <div className="banner banner--warn" style={{ margin: 'var(--s3) var(--s7) 0' }}>
          <Icon name="alert" size={15} />
          <span>{detail.mission.statusReason}</span>
        </div>
      ) : null}

      <div className="tabs" style={{ marginTop: 'var(--s3)' }}>
        <TabLink id={id} tab="plan" current={tab} label="Plan" count={detail.tasks.length} />
        <TabLink id={id} tab="timeline" current={tab} label="Timeline" />
        <TabLink id={id} tab="artifacts" current={tab} label="Artifacts" count={detail.artifacts.length} />
        <TabLink id={id} tab="checks" current={tab} label="Checks & Gates" count={detail.checks.length} />
        <TabLink id={id} tab="metrics" current={tab} label="Metrics" />
      </div>

      {renderPane(tab, detail)}

      {confirming === 'cancel' ? (
        <ConfirmDialog
          title="Cancel this mission?"
          confirmLabel="Cancel mission"
          destructive
          busy={act.isPending}
          onCancel={() => setConfirming(null)}
          onConfirm={() => {
            act.mutate({ action: 'cancel' });
            setConfirming(null);
          }}
          body={
            <>
              <p>
                Running tasks stop as soon as they reach a safe point. Work already committed to task branches stays where it is — nothing is
                deleted.
              </p>
              <p style={{ marginTop: 'var(--s3)' }}>A cancelled mission cannot be resumed, but you can duplicate it into a new one.</p>
            </>
          }
        />
      ) : null}

      {confirming === 'delete' ? (
        <ConfirmDialog
          title="Delete this mission?"
          confirmLabel="Delete permanently"
          destructive
          busy={remove.isPending}
          onCancel={() => setConfirming(null)}
          onConfirm={() =>
            remove.mutate(undefined, {
              onSuccess: () => {
                setConfirming(null);
                navigate('/missions');
              },
            })
          }
          body={
            <p>
              This removes the mission, its plan, its event log and its artifact manifests. Git branches and worktrees are left alone. This
              cannot be undone.
            </p>
          }
        />
      ) : null}
    </>
  );
}

function renderPane(tab: MissionTab, detail: MissionDetailView): JSX.Element {
  switch (tab) {
    case 'plan':
      return <PlanPane detail={detail} />;
    case 'timeline':
      return <TimelinePane detail={detail} />;
    case 'artifacts':
      return <ArtifactsPane detail={detail} />;
    case 'checks':
      return <ChecksPane detail={detail} />;
    case 'metrics':
      return <MetricsPane detail={detail} />;
  }
}

function TabLink({
  id,
  tab,
  current,
  label,
  count,
}: {
  id: string;
  tab: MissionTab;
  current: MissionTab;
  label: string;
  count?: number;
}): JSX.Element {
  return (
    <Link href={`/missions/${id}/${tab}`} className="tab" aria-selected={current === tab}>
      {label}
      {count !== undefined && count > 0 ? <span className="tab__count">{count}</span> : null}
    </Link>
  );
}

interface MissionAction {
  readonly id: 'plan' | 'start' | 'pause' | 'resume' | 'cancel';
  readonly label: string;
  readonly icon: IconName;
  readonly primary?: boolean;
}

/**
 * Which controls make sense is a function of the mission's state machine, not
 * of what the user might want - offering Start on a running mission is how a
 * UI teaches people that its buttons are unreliable.
 */
function actionsFor(status: MissionStatus): readonly MissionAction[] {
  if (isTerminalMissionStatus(status)) return [];
  switch (status) {
    case 'DRAFT':
      return [{ id: 'plan', label: 'Plan', icon: 'sparkle', primary: true }];
    case 'PLANNING':
      return [{ id: 'cancel', label: 'Cancel', icon: 'x' }];
    case 'AWAITING_PLAN_APPROVAL':
      return [
        { id: 'start', label: 'Start', icon: 'play', primary: true },
        { id: 'cancel', label: 'Cancel', icon: 'x' },
      ];
    case 'PAUSED':
      return [
        { id: 'resume', label: 'Resume', icon: 'play', primary: true },
        { id: 'cancel', label: 'Cancel', icon: 'x' },
      ];
    case 'BLOCKED':
      return [
        { id: 'resume', label: 'Resume', icon: 'play', primary: true },
        { id: 'cancel', label: 'Cancel', icon: 'x' },
      ];
    default:
      return [
        { id: 'pause', label: 'Pause', icon: 'pause' },
        { id: 'cancel', label: 'Cancel', icon: 'x' },
      ];
  }
}

function MissionSkeleton(): JSX.Element {
  return (
    <>
      <div className="topbar">
        <div className="topbar__titles" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <Skeleton height={11} width={160} />
          <Skeleton height={20} width={320} />
        </div>
      </div>
      <div className="page">
        <div className="page__inner">
          <SkeletonList rows={4} />
        </div>
      </div>
    </>
  );
}

export function MissionNotFound(): JSX.Element {
  return (
    <>
      <PageHeader title="Mission not found" crumbs={[{ label: 'Missions', href: '/missions' }]} />
      <div className="page">
        <div className="page__inner">
          <div className="card">
            <Empty
              icon="search"
              title="That mission no longer exists"
              body="It may have been deleted from another window."
              action={
                <Link href="/missions" className="btn">
                  Back to missions
                </Link>
              }
            />
          </div>
        </div>
      </div>
    </>
  );
}
