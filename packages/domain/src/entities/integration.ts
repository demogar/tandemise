import type { IntegrationId, Timestamp, WorkspaceId } from '@tandemise/shared';
import type { Capability, RiskClass } from '../capability.js';

/** MVP.md §12.2. Ordered by how deterministic each transport is. */
export const INTEGRATION_TRANSPORTS = ['cli', 'rest', 'mcp', 'browser', 'desktop', 'builtin'] as const;
export type IntegrationTransport = (typeof INTEGRATION_TRANSPORTS)[number];

export interface Integration {
  readonly id: IntegrationId;
  readonly workspaceId: WorkspaceId;
  /** Names a registered integration provider, e.g. `github`, `mcp`, `browser`. */
  readonly providerId: string;
  readonly name: string;
  readonly transport: IntegrationTransport;
  readonly config: Readonly<Record<string, unknown>>;
  /**
   * Opaque handle into the OS credential store, never the secret itself
   * (MVP.md §P8). Null when the integration reuses an already-authenticated CLI.
   */
  readonly credentialRef: string | null;
  /** Capabilities the workspace has enabled for this integration. */
  readonly enabledCapabilities: readonly Capability[];
  readonly enabled: boolean;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
}

export interface IntegrationHealth {
  readonly integrationId: IntegrationId;
  readonly state: 'healthy' | 'degraded' | 'unavailable' | 'unknown';
  readonly detail: string;
  readonly checkedAt: Timestamp;
}

/** A single invocable action exposed by an integration (MVP.md §12.3). */
export interface ToolDescriptor {
  readonly name: string;
  readonly integrationId: IntegrationId | null;
  readonly capability: Capability;
  readonly risk: RiskClass;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly outputSchema?: Record<string, unknown>;
}
