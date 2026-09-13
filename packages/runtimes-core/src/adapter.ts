import type { Capability, RuntimeCapability, RuntimeDiscovery, RuntimeHealth, RuntimeProfile, RuntimeSettingField } from '@tandemise/domain';
import type { AgentEvent } from '@tandemise/domain';
import type { Logger, RunId } from '@tandemise/shared';
import { multiToken } from '@tandemise/kernel';
import type { Descriptor } from '@tandemise/kernel';

/**
 * The failure code an adapter emits when a resume handle no longer names a
 * session its runtime holds.
 *
 * It is canonical rather than per-vendor because the caller acts on it: this is
 * the one run failure that says nothing about the work, only about a lost
 * continuity, so the right response is to run the attempt again from scratch -
 * not to spend a retry, and certainly not to block the task. Every vendor
 * phrases it differently ("No conversation found with session ID: …"); the
 * adapter is where that phrasing stops.
 */
export const SESSION_NOT_FOUND = 'SESSION_NOT_FOUND';

/**
 * Everything an adapter needs to execute one attempt (MVP.md §10.1).
 *
 * Note what is *absent*: no credentials, no repository handle, no mission. The
 * adapter launches an already-authenticated local tool (MVP.md §10.3) and is
 * told only what this one run may touch. `grants` is descriptive input to the
 * adapter's own flag mapping - Tandemise's policy layer remains the real gate,
 * because a CLI flag is advice and a policy decision is enforcement.
 */
export interface RunRequest {
  readonly runId: RunId;
  readonly profile: RuntimeProfile;
  /** Already compiled and trust-labelled by the context builder (MVP.md §14.1). */
  readonly prompt: string;
  readonly workingDirectory: string;
  readonly grants: readonly Capability[];
  /** Filesystem roots this run may read/write, beyond `workingDirectory`. */
  readonly allowedRoots: readonly string[];
  readonly mcpConfigPath: string | null;
  readonly maxWallTimeMs: number;
  /** Aborting must terminate the child process, not merely stop iteration. */
  readonly signal: AbortSignal;
  readonly log: Logger;
}

/**
 * The single seam between Tandemise and any agent runtime (MVP.md §10.1).
 *
 * `start`/`resume` return an `AsyncIterable` rather than taking a callback so
 * that back-pressure is the consumer's: a slow event writer slows the reader
 * instead of growing an unbounded in-memory queue.
 */
export interface AgentRuntimeAdapter {
  /** Stable adapter id, e.g. `claude-code`. Profiles reference this, never a vendor. */
  readonly id: string;
  readonly displayName: string;
  /**
   * Capabilities the adapter can offer before any profile exists. Used for
   * registry-level routing queries (`Registry.providing('shell')`); the
   * per-profile `capabilities()` is authoritative once a profile is chosen.
   */
  readonly baseCapabilities: readonly RuntimeCapability[];

  /**
   * What a profile of this adapter may configure, for the UI to render.
   *
   * Optional: an adapter with no settings simply omits it, and the settings
   * form then offers nothing rather than guessing.
   */
  readonly settingsSchema?: readonly RuntimeSettingField[];

  /**
   * Reject settings this adapter cannot honour, before a profile is saved.
   *
   * Without it a malformed setting is only discovered when a run spawns, which
   * is both far from the mistake and after a mission has already started.
   * Throws; returning normally means accepted.
   */
  validateSettings?(settings: Readonly<Record<string, unknown>>): void;

  discover(): Promise<RuntimeDiscovery>;
  healthCheck(profile: RuntimeProfile): Promise<RuntimeHealth>;
  capabilities(profile: RuntimeProfile): readonly RuntimeCapability[];

  start(request: RunRequest): AsyncIterable<AgentEvent>;
  /**
   * Continues a run from a handle a previous run produced.
   *
   * A handle can go stale - the runtime prunes its session store, the session
   * was never written because the process died first, or the profile now runs
   * under a different config directory. An adapter that discovers this MUST
   * fail with {@link SESSION_NOT_FOUND} rather than passing its vendor's own
   * error code through, because that is the one failure the caller can undo by
   * simply starting fresh.
   */
  resume?(sessionRef: string, request: RunRequest): AsyncIterable<AgentEvent>;
  cancel(runId: RunId): Promise<void>;

  /**
   * The OS process this run is using, or null when there is none (an in-process
   * runtime) or the run has ended. The supervisor records it so that after a
   * daemon crash it can ask whether the child is still alive before deciding
   * between resume and retry (MVP.md §21.1, §21.2).
   */
  pid(runId: RunId): number | null;
}

export interface RuntimeAdapterDescriptor extends Descriptor {
  readonly adapter: AgentRuntimeAdapter;
}

export function describeAdapter(adapter: AgentRuntimeAdapter): RuntimeAdapterDescriptor {
  return {
    id: adapter.id,
    displayName: adapter.displayName,
    provides: adapter.baseCapabilities,
    adapter,
  };
}

/**
 * The plugin seam. Every runtime package contributes here; nothing in the core
 * ever imports a runtime package (MVP.md §26.1).
 */
export const RUNTIME_ADAPTERS = multiToken<AgentRuntimeAdapter>('RuntimeAdapter');
