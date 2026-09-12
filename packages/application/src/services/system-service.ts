import type { SystemInfo } from '@tandemise/api-contract';
import { API_VERSION } from '@tandemise/api-contract';
import type { SettingsStorePort, SystemEnvironmentPort } from '../ports.js';
import type { SystemService } from '../services.js';

/** Everything the developer pane needs to answer "what is actually wired in?". */
export interface DiagnosticsSource {
  bindings(): ReadonlyArray<{ token: string; lifetime: string; source: string; instantiated: boolean }>;
  runtimeAdapters(): readonly string[];
  targetKinds(): readonly string[];
  integrationProviders(): readonly string[];
  artifactRoot(): string;
}

/**
 * Facts about the daemon, and the handful of preferences it stores
 * (MVP.md §23.7).
 *
 * `diagnostics` exists because the whole architecture is "everything is a
 * module bound by one composition root" - and an architecture like that is only
 * trustworthy if you can see the resulting table. A missing runtime adapter or
 * an unbound port should be one screen away, not something inferred from a
 * mission that will not start.
 */
export class SystemServiceImpl implements SystemService {
  constructor(
    private readonly environment: SystemEnvironmentPort,
    private readonly settingsStore: SettingsStorePort,
    private readonly diagnosticsSource: DiagnosticsSource,
  ) {}

  info(): SystemInfo {
    return {
      daemonVersion: this.environment.daemonVersion,
      apiVersion: API_VERSION,
      schemaVersion: this.environment.schemaVersion,
      startedAt: this.environment.startedAt,
      pid: this.environment.pid,
      home: this.environment.home,
      platform: this.environment.platform,
      nodeVersion: this.environment.nodeVersion,
    };
  }

  settings(): Record<string, unknown> {
    return this.settingsStore.read();
  }

  updateSettings(patch: Record<string, unknown>): Record<string, unknown> {
    return this.settingsStore.write(patch);
  }

  diagnostics(): Record<string, unknown> {
    const source = this.diagnosticsSource;
    return {
      system: this.info(),
      artifactRoot: source.artifactRoot(),
      runtimeAdapters: source.runtimeAdapters(),
      targetKinds: source.targetKinds(),
      integrationProviders: source.integrationProviders(),
      bindings: source.bindings(),
    };
  }
}
