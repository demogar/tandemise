import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import type { ProjectionTopic, RunEventRecord } from '@tandemise/domain';
import type { TaskFeedbackView } from '@tandemise/api-contract';
import { useDaemon } from './connection.js';
import { useWorkspaceId } from './workspace.js';
import type { DaemonClient } from './daemon.js';

/**
 * Query keys, centralised.
 *
 * The daemon's `invalidate` messages arrive as coarse topics, so the key shape
 * has to line up with those topics exactly - `TOPIC_KEYS` below is the
 * translation, and it only stays correct if every key is minted here.
 */
/**
 * Workspace-scoped keys carry the workspace id last, so switching project
 * refetches instead of showing the previous one's data. The id goes last
 * because `invalidateTopic` matches on the key's first element.
 */
export const keys = {
  system: ['system'] as const,
  home: (ws?: string) => ['home', ws ?? 'all'] as const,
  workspaces: ['workspaces'] as const,
  missions: (filter?: string, ws?: string) => ['missions', filter ?? 'all', ws ?? 'all'] as const,
  // Under 'missions': every mission change, a pull included, refreshes it.
  backlog: (ws?: string) => ['missions', 'backlog', ws ?? 'all'] as const,
  // Under 'workspaces': a changed limit refreshes it; runs finishing are picked up by its interval.
  usage: (ws?: string) => ['workspaces', 'usage', ws ?? 'all'] as const,
  mission: (id: string) => ['mission', id] as const,
  // Under 'mission' and scoped by id, so the mission's own invalidations refresh it.
  missionArtifacts: (id: string, all: boolean) => ['mission', id, 'artifacts', all ? 'all' : 'live'] as const,
  // Under 'mission' too: a feed changes on exactly the topics the mission detail does.
  missionFeed: (id: string, doneLimit: number | 'all') => ['mission', id, 'feed', String(doneLimit)] as const,
  // Under 'mission' too: artifacts and tasks changing refresh it with the rest of the mission.
  missionCriteria: (id: string) => ['mission', id, 'criteria'] as const,
  missionRefinement: (id: string) => ['mission', id, 'refinement'] as const,
  missionEvents: (id: string) => ['mission-events', id] as const,
  // Not under 'mission': the drawer and the reader read it outside a mission's screen, so it is refreshed with every task change.
  taskFeedback: (id: string) => ['mission-task-feedback', id] as const,
  approvals: (ws?: string) => ['approvals', ws ?? 'all'] as const,
  inbox: (ws?: string) => ['inbox', ws ?? 'all'] as const,
  artifacts: (q: string, ws?: string) => ['artifacts', q, ws ?? 'all'] as const,
  artifact: (id: string) => ['artifact', id] as const,
  runtimes: (ws?: string) => ['runtimes', ws ?? 'all'] as const,
  roles: (ws?: string) => ['roles', ws ?? 'all'] as const,
  integrations: (ws?: string) => ['integrations', ws ?? 'all'] as const,
  workflows: (ws?: string) => ['workflows', ws ?? 'all'] as const,
  settings: ['settings'] as const,
  me: ['me'] as const,
  team: (ws?: string) => ['team', ws ?? 'all'] as const,
  staffing: (ws?: string) => ['staffing', ws ?? 'all'] as const,
};

const TOPIC_KEYS: Readonly<Record<ProjectionTopic, readonly (readonly string[])[]>> = {
  // A mission's status alone can make it stalled, which is an Inbox row (P9).
  missions: [['home'], ['missions'], ['mission'], ['inbox']],
  tasks: [['mission'], ['home'], ['inbox'], ['mission-task-feedback']],
  // A decided review card or check can record a note, so a task's thread follows approvals too.
  approvals: [['approvals'], ['home'], ['mission'], ['inbox'], ['mission-task-feedback']],
  artifacts: [['artifacts'], ['mission'], ['artifact']],
  runtimes: [['runtimes'], ['home']],
  integrations: [['integrations']],
  targets: [['mission']],
  // Members and staffing have no topic of their own; they change with the workspace.
  workspaces: [['workspaces'], ['home'], ['settings'], ['workflows'], ['team'], ['staffing'], ['me']],
  decisions: [['mission']],
  checks: [['mission'], ['home']],
  criteria: [['mission']],
  // A refinement decision changes the mission's readiness and the inbox row that asks for it.
  // The backlog shows each draft's readiness too.
  refinement: [['mission'], ['inbox'], ['home'], ['missions']],
};

export function invalidateTopic(
  queryClient: ReturnType<typeof useQueryClient>,
  topic: ProjectionTopic,
  missionId?: string,
): void {
  for (const key of TOPIC_KEYS[topic] ?? []) {
    const scoped = missionId && (key[0] === 'mission' || key[0] === 'mission-events') ? [...key, missionId] : key;
    void queryClient.invalidateQueries({ queryKey: scoped });
  }
}

// ------------------------------------------------------------------ queries

export function useSystem() {
  const daemon = useDaemon();
  return useQuery({ queryKey: keys.system, queryFn: () => daemon.system(), staleTime: 60_000 });
}

export function useHome() {
  const daemon = useDaemon();
  const workspaceId = useWorkspaceId();
  return useQuery({ queryKey: keys.home(workspaceId), queryFn: () => daemon.home(workspaceId) });
}

export function useWorkspaces() {
  const daemon = useDaemon();
  return useQuery({ queryKey: keys.workspaces, queryFn: () => daemon.workspaces(), staleTime: 30_000 });
}

export function useMissions(status?: string) {
  const daemon = useDaemon();
  const workspaceId = useWorkspaceId();
  return useQuery({
    queryKey: keys.missions(status, workspaceId),
    queryFn: () => daemon.missions({ workspaceId, ...(status ? { status: status as never } : {}) }),
  });
}

/** This month's usage against the project's monthly limits (P8). */
export function useWorkspaceUsage() {
  const daemon = useDaemon();
  const workspaceId = useWorkspaceId();
  return useQuery({
    queryKey: keys.usage(workspaceId),
    queryFn: () => daemon.workspaceUsage(workspaceId ?? ''),
    enabled: Boolean(workspaceId),
    refetchInterval: 5_000,
    placeholderData: (previous) => previous,
  });
}

/** The project's backlog and work-in-progress limit (P7). */
export function useBacklog() {
  const daemon = useDaemon();
  const workspaceId = useWorkspaceId();
  return useQuery({
    queryKey: keys.backlog(workspaceId),
    queryFn: () => daemon.backlog(workspaceId ?? ''),
    enabled: Boolean(workspaceId),
    placeholderData: (previous) => previous,
  });
}

export function useMission(id: string) {
  const daemon = useDaemon();
  return useQuery({ queryKey: keys.mission(id), queryFn: () => daemon.mission(id), enabled: id.length > 0 });
}

/**
 * The most finished cards one feed request may ask for: the daemon refuses a
 * larger `doneLimit`. "Show all" asks for this many, so a mission with more
 * finished work than this shows the latest ones and says so.
 */
/** The Done-when ledger of a mission: criteria, what covers them, and what QA found. */
export function useMissionCriteria(id: string) {
  const daemon = useDaemon();
  return useQuery({
    queryKey: keys.missionCriteria(id),
    queryFn: () => daemon.missionCriteria(id),
    enabled: id.length > 0,
    placeholderData: (previous) => previous,
  });
}

/** A DRAFT mission's refinement: proposals, questions and whether it is ready to plan. */
export function useMissionRefinement(id: string, enabled = true) {
  const daemon = useDaemon();
  return useQuery({
    queryKey: keys.missionRefinement(id),
    queryFn: () => daemon.missionRefinement(id),
    enabled: enabled && id.length > 0,
    placeholderData: (previous) => previous,
    // The stream says when a pass lands; polling while one runs covers a dropped frame.
    refetchInterval: (query) => (query.state.data?.state === 'running' ? 2_000 : false),
  });
}

export const FEED_ALL_DONE_LIMIT = 500;

/**
 * A mission's feed of short cards. `doneLimit: 'all'` lists finished cards up to
 * `FEED_ALL_DONE_LIMIT`, for "Show N more"; the default keeps the list to the daemon's latest few.
 */
export function useMissionFeed(id: string, doneLimit: number | 'all' = 5) {
  const daemon = useDaemon();
  return useQuery({
    queryKey: keys.missionFeed(id, doneLimit),
    queryFn: () => daemon.missionFeed(id, doneLimit === 'all' ? { doneLimit: FEED_ALL_DONE_LIMIT } : { doneLimit }),
    enabled: id.length > 0,
    // Keeps the cards on screen while "Show N more" fetches the longer list, instead of flashing a skeleton.
    placeholderData: (previous) => previous,
  });
}

export function useMissionEvents(id: string): UseQueryResult<readonly RunEventRecord[]> {
  const daemon = useDaemon();
  return useQuery({
    queryKey: keys.missionEvents(id),
    queryFn: () => daemon.missionEvents(id, { limit: 500 }),
    enabled: id.length > 0,
  });
}

/** A task's feedback thread and the round its open notes wait on. */
export function useTaskFeedback(taskId: string | null): UseQueryResult<TaskFeedbackView> {
  const daemon = useDaemon();
  return useQuery({
    queryKey: keys.taskFeedback(taskId ?? ''),
    queryFn: () => daemon.taskFeedback(taskId as string),
    enabled: Boolean(taskId),
  });
}

export function useApprovals() {
  const daemon = useDaemon();
  const workspaceId = useWorkspaceId();
  return useQuery({ queryKey: keys.approvals(workspaceId), queryFn: () => daemon.approvals(workspaceId) });
}

/** Everything waiting on a person in this project. Behind the always-mounted nav badge, so one request. */
export function useInboxView() {
  const daemon = useDaemon();
  const workspaceId = useWorkspaceId();
  return useQuery({
    queryKey: keys.inbox(workspaceId),
    queryFn: () => daemon.inbox(workspaceId as string),
    enabled: workspaceId !== undefined,
  });
}

export function useArtifactSearch(query: string) {
  const daemon = useDaemon();
  const workspaceId = useWorkspaceId();
  return useQuery({
    queryKey: keys.artifacts(query, workspaceId),
    queryFn: () => daemon.artifacts({ workspaceId, q: query || undefined }),
  });
}

/** A mission's artifacts: live versions only, or every version when `includeSuperseded`. */
export function useMissionArtifacts(missionId: string, includeSuperseded: boolean) {
  const daemon = useDaemon();
  return useQuery({
    queryKey: keys.missionArtifacts(missionId, includeSuperseded),
    queryFn: () => daemon.missionArtifacts(missionId, includeSuperseded ? { includeSuperseded: true } : undefined),
    // Keeps the rows on screen while the toggle fetches the other set, instead of flashing a skeleton.
    placeholderData: (previous) => previous,
  });
}

export function useArtifact(id: string | null) {
  const daemon = useDaemon();
  return useQuery({
    queryKey: keys.artifact(id ?? ''),
    queryFn: () => daemon.artifact(id as string),
    enabled: Boolean(id),
  });
}

export function useRuntimes() {
  const daemon = useDaemon();
  const workspaceId = useWorkspaceId();
  return useQuery({ queryKey: keys.runtimes(workspaceId), queryFn: () => daemon.runtimes(workspaceId) });
}

export function useRoles() {
  const daemon = useDaemon();
  const workspaceId = useWorkspaceId();
  return useQuery({ queryKey: keys.roles(workspaceId), queryFn: () => daemon.roles(workspaceId), staleTime: 30_000 });
}

/** The one-click catalog. It changes only when the daemon does. */
export function useConnectors() {
  const daemon = useDaemon();
  return useQuery({ queryKey: ['integrations', 'connectors'], queryFn: () => daemon.connectors(), staleTime: 5 * 60_000 });
}

export function useIntegrations() {
  const daemon = useDaemon();
  const workspaceId = useWorkspaceId();
  return useQuery({ queryKey: keys.integrations(workspaceId), queryFn: () => daemon.integrations(workspaceId) });
}

/**
 * What this project can run.
 *
 * Its own workflow files come first; the built-in presets fill in behind them.
 * Refetched on a short stale time because a workflow is a file the user edits
 * in another window - waiting for a restart to see a change they just saved is
 * exactly the friction that makes an authoring format feel dead.
 */
export function useWorkflows() {
  const daemon = useDaemon();
  const workspaceId = useWorkspaceId();
  return useQuery({
    queryKey: keys.workflows(workspaceId),
    queryFn: () => daemon.workflows(workspaceId as string),
    enabled: workspaceId !== undefined,
    staleTime: 5_000,
  });
}

export function useSettings() {
  const daemon = useDaemon();
  return useQuery({ queryKey: keys.settings, queryFn: () => daemon.settings(), staleTime: 30_000 });
}

// ------------------------------------------------------------ team and people

export function useMe() {
  const daemon = useDaemon();
  return useQuery({ queryKey: keys.me, queryFn: () => daemon.me(), staleTime: 60_000 });
}

/** The principal's member id in the selected project; "for me" is judged against it. */
export function useMyMemberId(): string | null {
  const workspaceId = useWorkspaceId();
  return useMe().data?.memberships.find((m) => m.workspaceId === workspaceId)?.memberId ?? null;
}

export function useTeam() {
  const daemon = useDaemon();
  const workspaceId = useWorkspaceId();
  return useQuery({
    queryKey: keys.team(workspaceId),
    queryFn: () => daemon.team(workspaceId as string),
    enabled: workspaceId !== undefined,
    // No stream topic covers members yet, so a screen that shows the team refetches on open.
    staleTime: 0,
  });
}

export function useStaffing() {
  const daemon = useDaemon();
  const workspaceId = useWorkspaceId();
  return useQuery({
    queryKey: keys.staffing(workspaceId),
    queryFn: () => daemon.getStaffing(workspaceId as string),
    enabled: workspaceId !== undefined,
  });
}

// ---------------------------------------------------------------- mutations

/**
 * A mutation that refreshes whatever the daemon would have invalidated anyway.
 * The socket will usually beat this, but a user who acts while the socket is
 * reconnecting still sees their change land.
 */
export function useDaemonMutation<TArgs, TResult>(
  run: (daemon: DaemonClient, args: TArgs) => Promise<TResult>,
  topics: readonly ProjectionTopic[],
  missionId?: string,
) {
  const daemon = useDaemon();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: TArgs) => run(daemon, args),
    onSuccess: () => {
      for (const topic of topics) invalidateTopic(queryClient, topic, missionId);
    },
  });
}
