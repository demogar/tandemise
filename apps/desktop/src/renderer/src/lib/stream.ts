import { useEffect, useRef, useState } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { ServerMessage } from '@tandemise/api-contract';
import type { RunEventRecord } from '@tandemise/domain';
import { useConnection } from './connection.js';
import { invalidateTopic, keys } from './queries.js';
import type { DaemonClient } from './daemon.js';

export type StreamState = 'idle' | 'connecting' | 'open' | 'reconnecting';

const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 15_000;
const HEARTBEAT_MS = 20_000;

/**
 * The live edge of the daemon.
 *
 * The socket is a notification channel, not a source of truth (MVP.md §7.2):
 * `event` frames are appended to the timeline cache optimistically, but on every
 * reconnect we re-read by `afterSequence` from HTTP, so a dropped connection
 * loses nothing. `invalidate` frames are translated into query invalidations,
 * which is exactly what TanStack Query wants.
 */
export function useDaemonStream(): StreamState {
  const { client } = useConnection();
  const queryClient = useQueryClient();
  const [state, setState] = useState<StreamState>('idle');

  // Ref, not state: the reconnect loop must read the latest sequence without
  // being torn down and recreated every time an event arrives.
  const lastSequenceByMission = useRef(new Map<string, number>());

  useEffect(() => {
    if (!client) {
      setState('idle');
      return;
    }

    let socket: WebSocket | null = null;
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    let disposed = false;

    const connect = (): void => {
      if (disposed) return;
      setState(attempt === 0 ? 'connecting' : 'reconnecting');
      socket = new WebSocket(client.streamUrl);

      socket.onopen = () => {
        attempt = 0;
        setState('open');
        socket?.send(JSON.stringify({ type: 'subscribe' }));
        // Resync anything we may have missed while the socket was down.
        void resyncMissions(client, queryClient, lastSequenceByMission.current);
        heartbeat = setInterval(() => socket?.send(JSON.stringify({ type: 'ping', t: Date.now() })), HEARTBEAT_MS);
      };

      socket.onmessage = (frame) => {
        const message = parse(frame.data);
        if (message) handle(message, queryClient, lastSequenceByMission.current);
      };

      socket.onclose = () => {
        if (heartbeat) clearInterval(heartbeat);
        heartbeat = null;
        if (disposed) return;
        setState('reconnecting');
        const delay = Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
        attempt += 1;
        // Jitter: several windows reconnecting in lockstep would hammer the daemon.
        retryTimer = setTimeout(connect, delay + Math.random() * 250);
      };

      socket.onerror = () => socket?.close();
    };

    connect();

    return () => {
      disposed = true;
      if (heartbeat) clearInterval(heartbeat);
      if (retryTimer) clearTimeout(retryTimer);
      socket?.close();
    };
  }, [client, queryClient]);

  return state;
}

function parse(data: unknown): ServerMessage | null {
  if (typeof data !== 'string') return null;
  try {
    const value: unknown = JSON.parse(data);
    if (typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string') {
      return value as ServerMessage;
    }
  } catch {
    /* A malformed frame is a daemon bug, not a reason to drop the socket. */
  }
  return null;
}

function handle(message: ServerMessage, queryClient: QueryClient, sequences: Map<string, number>): void {
  switch (message.type) {
    case 'event': {
      appendEvent(queryClient, message.record, sequences);
      return;
    }
    case 'invalidate': {
      invalidateTopic(queryClient, message.topic, message.missionId);
      return;
    }
    default:
      return;
  }
}

function appendEvent(queryClient: QueryClient, record: RunEventRecord, sequences: Map<string, number>): void {
  const missionId = record.missionId;
  sequences.set(missionId, Math.max(sequences.get(missionId) ?? 0, record.sequence));

  queryClient.setQueryData<readonly RunEventRecord[]>(keys.missionEvents(missionId), (existing) => {
    if (!existing) return existing;
    // The daemon may replay on reconnect; sequence is the dedupe key.
    if (existing.some((event) => event.sequence === record.sequence)) return existing;
    return [...existing, record];
  });
}

async function resyncMissions(client: DaemonClient, queryClient: QueryClient, sequences: Map<string, number>): Promise<void> {
  const cached = queryClient.getQueryCache().findAll({ queryKey: ['mission-events'] });
  await Promise.all(
    cached.map(async (query) => {
      const missionId = query.queryKey[1];
      if (typeof missionId !== 'string' || missionId.length === 0) return;
      const known = (query.state.data as readonly RunEventRecord[] | undefined) ?? [];
      const after = Math.max(sequences.get(missionId) ?? 0, ...known.map((event) => event.sequence), 0);
      try {
        const missed = await client.missionEvents(missionId, { afterSequence: after, limit: 500 });
        if (missed.length === 0) return;
        queryClient.setQueryData<readonly RunEventRecord[]>(keys.missionEvents(missionId), (existing) => {
          const seen = new Set((existing ?? []).map((event) => event.sequence));
          return [...(existing ?? []), ...missed.filter((event) => !seen.has(event.sequence))];
        });
      } catch {
        // The daemon is not answering yet; the socket's own retry will come back.
      }
    }),
  );
}
