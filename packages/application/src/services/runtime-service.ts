import type {
  RuntimeProfile, RuntimeProfileRepositoryPort, WorkspaceRepositoryPort,
} from '@tandemise/domain';
import type { CreateRuntimeProfileRequest, RuntimeDiscoveryView, RuntimeView } from '@tandemise/api-contract';
import type { RuntimeManager } from '@tandemise/runtimes-core';
import type { Clock, RuntimeProfileId } from '@tandemise/shared';
import { TandemiseError, asId, ids } from '@tandemise/shared';
import type { RuntimeService } from '../services.js';
import { BUILT_IN_ROLES } from '../roles/built-in.js';

/**
 * Runtime profiles: discovery, CRUD, health (MVP.md §10.2, §23.6).
 *
 * Two behaviours are worth stating because they are the difference between a
 * usable onboarding and a dead end.
 *
 * **A new profile is routed by default.** A workspace whose routing lists
 * nothing for a role falls back to "any healthy runtime", so the first profile
 * a user creates is usable immediately. But a workspace that *has* expressed a
 * preference for a role gets the new profile appended as a fallback rather than
 * silently ignored - the alternative is a user who adds a second runtime and
 * cannot work out why it is never used.
 *
 * **Health is never inferred from the profile row.** It is asked of the adapter
 * (through the manager's short-lived cache), because "enabled" is a user
 * intention and "healthy" is a fact about the machine right now.
 */
export class RuntimeServiceImpl implements RuntimeService {
  constructor(
    private readonly profiles: RuntimeProfileRepositoryPort,
    private readonly workspaces: WorkspaceRepositoryPort,
    private readonly runtimes: RuntimeManager,
    private readonly clock: Clock,
  ) {}

  async list(workspaceId?: string): Promise<readonly RuntimeView[]> {
    const scope = workspaceId === undefined ? null : asId<'WorkspaceId'>(workspaceId);
    const profiles = this.profiles.list(scope);
    return Promise.all(profiles.map((p) => this.#view(p)));
  }

  async discover(): Promise<readonly RuntimeDiscoveryView[]> {
    const configured = new Set(this.profiles.list(null).map((p) => p.adapterId));
    const found = await this.runtimes.discoverAll();
    return found.map((d) => ({ ...d, configured: configured.has(d.adapterId) }));
  }

  async create(request: CreateRuntimeProfileRequest): Promise<RuntimeProfile> {
    const adapter = this.runtimes.registry.tryAdapter(request.adapterId);
    if (adapter === undefined) {
      throw TandemiseError.validation(
        `No runtime adapter '${request.adapterId}' is registered.`,
        { available: this.runtimes.registry.ids() },
      );
    }
    const now = this.clock.now();
    const profile: RuntimeProfile = {
      id: ids.runtimeProfile(),
      workspaceId: request.workspaceId ? asId<'WorkspaceId'>(request.workspaceId) : null,
      adapterId: request.adapterId,
      name: request.name,
      executablePath: request.executablePath ?? null,
      args: request.args ?? [],
      settings: request.settings ?? {},
      // Recorded from the adapter rather than left empty: routing reads this
      // when the profile is a candidate, and an empty list would make a fully
      // capable runtime look like it can do nothing.
      capabilities: adapter.baseCapabilities,
      enabled: request.enabled ?? true,
      maxConcurrent: request.maxConcurrent ?? 1,
      createdAt: now,
      updatedAt: now,
    };
    const created = this.profiles.create(profile);
    this.#routeByDefault(created);
    return created;
  }

  async update(id: RuntimeProfileId, patch: Partial<CreateRuntimeProfileRequest>): Promise<RuntimeProfile> {
    this.#require(id);
    const updated = this.profiles.update(id, {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.executablePath !== undefined ? { executablePath: patch.executablePath } : {}),
      ...(patch.args !== undefined ? { args: patch.args } : {}),
      ...(patch.settings !== undefined ? { settings: patch.settings } : {}),
      ...(patch.maxConcurrent !== undefined ? { maxConcurrent: patch.maxConcurrent } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      updatedAt: this.clock.now(),
    });
    // An edited executable path or setting invalidates whatever the last probe
    // concluded; keeping the cached answer would show a healthy badge for a
    // binary that no longer exists.
    this.runtimes.invalidateHealth(id);
    return updated;
  }

  remove(id: RuntimeProfileId): void {
    this.#require(id);
    this.profiles.remove(id);
    this.runtimes.invalidateHealth(id);
    for (const workspace of this.workspaces.list()) {
      const routing = Object.fromEntries(
        Object.entries(workspace.routing).map(([role, list]) => [role, list.filter((p) => p !== id)]),
      );
      this.workspaces.update(workspace.id, { routing, updatedAt: this.clock.now() });
    }
  }

  async checkHealth(id: RuntimeProfileId): Promise<RuntimeView> {
    const profile = this.#require(id);
    return this.#view(profile, { refresh: true });
  }

  async #view(profile: RuntimeProfile, options: { refresh?: boolean } = {}): Promise<RuntimeView> {
    const adapter = this.runtimes.registry.tryAdapter(profile.adapterId);
    return {
      profile,
      health: await this.runtimes.health(profile, options),
      adapterDisplayName: adapter?.displayName ?? profile.adapterId,
      activeRuns: this.runtimes.inFlight(profile.id),
      rolesRouted: this.#rolesRouted(profile),
    };
  }

  #rolesRouted(profile: RuntimeProfile): readonly string[] {
    const roles = new Set<string>();
    for (const workspace of this.workspaces.list()) {
      if (profile.workspaceId !== null && profile.workspaceId !== workspace.id) continue;
      for (const [role, list] of Object.entries(workspace.routing)) {
        if (list.includes(profile.id)) roles.add(role);
      }
    }
    return [...roles].sort();
  }

  /** Appends the profile to every role a workspace has already routed. */
  #routeByDefault(profile: RuntimeProfile): void {
    const known = new Set(BUILT_IN_ROLES.map((r) => r.id));
    for (const workspace of this.workspaces.list()) {
      if (profile.workspaceId !== null && profile.workspaceId !== workspace.id) continue;
      const routing: Record<string, readonly string[]> = { ...workspace.routing };
      let changed = false;
      for (const [role, list] of Object.entries(routing)) {
        if (!known.has(role) || list.includes(profile.id)) continue;
        routing[role] = [...list, profile.id];
        changed = true;
      }
      if (changed) this.workspaces.update(workspace.id, { routing, updatedAt: this.clock.now() });
    }
  }

  #require(id: RuntimeProfileId): RuntimeProfile {
    const profile = this.profiles.get(id);
    if (profile === undefined) throw TandemiseError.notFound('Runtime profile', id);
    return profile;
  }
}
