import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import type { ProjectionTopic, RunEventRecord } from '@tandemise/domain';
import { useDaemon } from './connection.js';
import type { DaemonClient } from './daemon.js';

/**
 * Query keys, centralised.
 *
 * The daemon's `invalidate` messages arrive as coarse topics, so the key shape
 * has to line up with those topics exactly - `TOPIC_KEYS` below is the
 * translation, and it only stays correct if every key is minted here.
 */
export const keys = {
  system: ['system'] as const,
  home: ['home'] as const,
  workspaces: ['workspaces'] as const,
  missions: (filter?: string) => ['missions', filter ?? 'all'] as const,
  mission: (id: string) => ['mission', id] as const,
  missionEvents: (id: string) => ['mission-events', id] as const,
  approvals: ['approvals'] as const,
  artifacts: (q: string) => ['artifacts', q] as const,
  artifact: (id: string) => ['artifact', id] as const,
  runtimes: ['runtimes'] as const,
  roles: ['roles'] as const,
  integrations: ['integrations'] as const,
  settings: ['settings'] as const,
};

const TOPIC_KEYS: Readonly<Record<ProjectionTopic, readonly (readonly string[])[]>> = {
  missions: [['home'], ['missions'], ['mission']],
  tasks: [['mission'], ['home']],
  approvals: [['approvals'], ['home'], ['mission']],
  artifacts: [['artifacts'], ['mission'], ['artifact']],
  runtimes: [['runtimes'], ['home']],
  integrations: [['integrations']],
  targets: [['mission']],
  workspaces: [['workspaces'], ['home'], ['settings']],
  decisions: [['mission']],
  checks: [['mission'], ['home']],
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
  return useQuery({ queryKey: keys.home, queryFn: () => daemon.home() });
}

export function useWorkspaces() {
  const daemon = useDaemon();
  return useQuery({ queryKey: keys.workspaces, queryFn: () => daemon.workspaces(), staleTime: 30_000 });
}

export function useMissions(status?: string) {
  const daemon = useDaemon();
  return useQuery({
    queryKey: keys.missions(status),
    queryFn: () => daemon.missions(status ? { status: status as never } : undefined),
  });
}

export function useMission(id: string) {
  const daemon = useDaemon();
  return useQuery({ queryKey: keys.mission(id), queryFn: () => daemon.mission(id), enabled: id.length > 0 });
}

export function useMissionEvents(id: string): UseQueryResult<readonly RunEventRecord[]> {
  const daemon = useDaemon();
  return useQuery({
    queryKey: keys.missionEvents(id),
    queryFn: () => daemon.missionEvents(id, { limit: 500 }),
    enabled: id.length > 0,
  });
}

export function useApprovals() {
  const daemon = useDaemon();
  return useQuery({ queryKey: keys.approvals, queryFn: () => daemon.approvals() });
}

export function useArtifactSearch(query: string) {
  const daemon = useDaemon();
  return useQuery({ queryKey: keys.artifacts(query), queryFn: () => daemon.artifacts({ q: query || undefined }) });
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
  return useQuery({ queryKey: keys.runtimes, queryFn: () => daemon.runtimes() });
}

export function useRoles() {
  const daemon = useDaemon();
  return useQuery({ queryKey: keys.roles, queryFn: () => daemon.roles(), staleTime: 30_000 });
}

export function useIntegrations() {
  const daemon = useDaemon();
  return useQuery({ queryKey: keys.integrations, queryFn: () => daemon.integrations() });
}

export function useSettings() {
  const daemon = useDaemon();
  return useQuery({ queryKey: keys.settings, queryFn: () => daemon.settings(), staleTime: 30_000 });
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
