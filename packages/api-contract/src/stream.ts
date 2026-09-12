import type { ProjectionTopic, RunEventRecord } from '@tandemise/domain';

/**
 * WebSocket protocol (MVP.md §7.2).
 *
 * Two kinds of push: the append-only event stream, and coarse invalidation
 * signals for projected views. Events carry their `sequence`, so a client that
 * misses frames re-reads by sequence from the HTTP endpoint rather than asking
 * for a full resync - the log is the source of truth, the socket is only the
 * notification edge.
 */
export type ServerMessage =
  | { readonly type: 'hello'; readonly apiVersion: string; readonly daemonVersion: string; readonly serverTime: string }
  | { readonly type: 'event'; readonly record: RunEventRecord }
  | { readonly type: 'invalidate'; readonly topic: ProjectionTopic; readonly missionId?: string }
  | { readonly type: 'pong'; readonly t: number }
  | { readonly type: 'error'; readonly code: string; readonly message: string };

export type ClientMessage =
  | { readonly type: 'subscribe'; readonly missionId?: string }
  | { readonly type: 'unsubscribe'; readonly missionId?: string }
  | { readonly type: 'ping'; readonly t: number };

export const STREAM_PATH = '/v1/stream';
