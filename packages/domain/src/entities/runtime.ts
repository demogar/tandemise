import type { RuntimeProfileId, Timestamp, WorkspaceId } from '@tandemise/shared';
import type { RuntimeCapability } from '../capability.js';

/**
 * A configured agent runtime.
 *
 * `adapterId` names a registered adapter, never a vendor: swapping Claude Code
 * for another worker is a change of profile, not of mission, role, or artifact
 * (MVP.md §P2).
 */
export interface RuntimeProfile {
  readonly id: RuntimeProfileId;
  readonly workspaceId: WorkspaceId | null;
  readonly adapterId: string;
  readonly name: string;
  readonly executablePath: string | null;
  readonly args: readonly string[];
  /** Adapter-specific settings (model, permission mode, sandbox flags…). */
  readonly settings: Readonly<Record<string, unknown>>;
  readonly capabilities: readonly RuntimeCapability[];
  readonly enabled: boolean;
  readonly maxConcurrent: number;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
}

/**
 * One setting an adapter understands, described so a UI can offer it.
 *
 * Without this the desktop would have to know that `claude-code` takes a
 * `model` and a `configDir` while some other adapter takes neither - putting
 * vendor knowledge in the renderer, which is precisely what `adapterId` exists
 * to avoid (MVP.md §P2). An adapter describes its own settings; the UI renders
 * whatever it is told and stores the result in `RuntimeProfile.settings`.
 *
 * Deliberately a small, closed set of kinds. A settings form is not a place for
 * arbitrary widgets, and every field here has to round-trip through a plain
 * JSON record.
 */
export interface RuntimeSettingField {
  /** Key within `RuntimeProfile.settings`. */
  readonly key: string;
  readonly label: string;
  readonly kind: 'text' | 'select' | 'number';
  /** Shown under the field. The place to explain what the setting is for. */
  readonly hint?: string;
  readonly placeholder?: string;
  /** Required for `select`, ignored otherwise. */
  readonly options?: readonly { readonly value: string; readonly label: string }[];
  readonly min?: number;
  readonly max?: number;
}

export const RUNTIME_HEALTH_STATES = ['healthy', 'degraded', 'unavailable', 'unknown'] as const;
export type RuntimeHealthState = (typeof RUNTIME_HEALTH_STATES)[number];

export interface RuntimeHealth {
  readonly profileId: RuntimeProfileId;
  readonly state: RuntimeHealthState;
  readonly version: string | null;
  readonly detail: string;
  readonly checkedAt: Timestamp;
  /** Set when the runtime reported a quota/rate limit (MVP.md §22.2). */
  readonly quotaWarning: string | null;
}

/** What an adapter found on the machine, before the user configures a profile. */
export interface RuntimeDiscovery {
  readonly adapterId: string;
  readonly displayName: string;
  readonly detected: boolean;
  readonly executablePath: string | null;
  readonly version: string | null;
  readonly capabilities: readonly RuntimeCapability[];
  readonly detail: string;
  /** Suggested settings for a profile created from this discovery. */
  readonly suggestedSettings: Readonly<Record<string, unknown>>;
  /** What this adapter lets a profile configure. Absent means nothing. */
  readonly settingsSchema?: readonly RuntimeSettingField[];
}
