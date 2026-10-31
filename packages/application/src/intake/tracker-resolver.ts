import { createHash } from 'node:crypto';
import type { IntakeConfigSource, PrimaryTracker, PrimaryTrackerFactory, SecretStorePort, TrackerConfig } from '@tandemise/domain';
import { stateMappingProblem } from '@tandemise/domain';
import type { Logger, WorkspaceId } from '@tandemise/shared';
import { TandemiseError } from '@tandemise/shared';

/**
 * The secret-store name of a project's tracker credential (plan Task 5; spec
 * §6: a permanent token per person, never in the brain repo).
 */
export function trackerSecretName(workspaceId: WorkspaceId): string {
  return `intake:${workspaceId}:tracker`;
}

export interface TrackerResolverDeps {
  readonly config: IntakeConfigSource;
  readonly secrets: SecretStorePort;
  /** Read when a tracker is built, so a provider module composed later still counts. */
  readonly factories: () => readonly PrimaryTrackerFactory[];
  readonly log: Logger;
}

/**
 * A project's primary tracker, built from its intake configuration (plan
 * Task 5). Every service that talks to the tracker gets it here, so the kind,
 * the place and the credential are read in one way: the configuration from
 * `IntakeConfigSource`, the credential from the local secret store.
 *
 * One tracker per project is kept, rebuilt when its configuration or its
 * credential changes.
 */
export class TrackerResolver {
  readonly #cache = new Map<WorkspaceId, { key: string; tracker: PrimaryTracker }>();

  constructor(private readonly deps: TrackerResolverDeps) {}

  async for(workspaceId: WorkspaceId): Promise<{ tracker: PrimaryTracker; config: TrackerConfig }> {
    const config = this.deps.config.read(workspaceId).tracker;
    if (config === null) throw new TandemiseError('CONFLICT', "Set this project's tracker first.");
    return { tracker: await this.#build(workspaceId, config), config };
  }

  /**
   * Why the project's state mapping cannot be used with its tracker, in the
   * words its settings show, or null (spec §6.2). Asks the tracker itself
   * (`describe()`), so it throws what the tracker throws.
   */
  async validate(workspaceId: WorkspaceId): Promise<string | null> {
    const { tracker, config } = await this.for(workspaceId);
    return stateMappingProblem(config, await tracker.describe());
  }

  /**
   * The same check for a configuration not saved yet (`PUT …/intake/config`).
   * Null as well when the tracker cannot be asked yet (no credential saved,
   * not reachable): the credential is saved on its own, so a person can set
   * the tracker first (RULINGS ruling 10). That is logged, not hidden.
   */
  async problemWith(workspaceId: WorkspaceId, config: TrackerConfig): Promise<string | null> {
    if (this.#factory(config) === undefined) return unknownKind(config);
    let described;
    try {
      described = await (await this.#build(workspaceId, config)).describe();
    } catch (e) {
      this.deps.log.warn('intake.tracker_unchecked', { workspaceId, kind: config.kind, error: e instanceof Error ? e.message : String(e) });
      return null;
    }
    return stateMappingProblem(config, described);
  }

  /**
   * Saves the project's tracker credential, replacing the one saved before,
   * and forgets the tracker built with the old one.
   */
  async saveCredential(workspaceId: WorkspaceId, value: string): Promise<void> {
    const old = await this.#credentialRefs(workspaceId);
    await this.deps.secrets.store(trackerSecretName(workspaceId), value);
    for (const ref of old) await this.deps.secrets.remove(ref);
    this.#cache.delete(workspaceId);
  }

  async #build(workspaceId: WorkspaceId, config: TrackerConfig): Promise<PrimaryTracker> {
    const factory = this.#factory(config);
    if (factory === undefined) throw new TandemiseError('PRECONDITION_FAILED', unknownKind(config));
    const credential = await this.#credential(workspaceId);
    // The credential is part of the key, hashed so the cache never holds it as text.
    const key = `${JSON.stringify(config)}\u0000${credential === undefined ? '' : createHash('sha256').update(credential).digest('hex')}`;
    const cached = this.#cache.get(workspaceId);
    if (cached !== undefined && cached.key === key) return cached.tracker;
    const tracker = factory.create(config, credential);
    this.#cache.set(workspaceId, { key, tracker });
    return tracker;
  }

  #factory(config: TrackerConfig): PrimaryTrackerFactory | undefined {
    return this.deps.factories().find((f) => f.kind === config.kind);
  }

  async #credential(workspaceId: WorkspaceId): Promise<string | undefined> {
    const refs = await this.#credentialRefs(workspaceId);
    // The last one listed is the newest: `saveCredential` removes the others.
    const ref = refs.at(-1);
    return ref === undefined ? undefined : this.deps.secrets.resolve(ref);
  }

  /**
   * The store hands back an opaque reference per secret, `<backend>:<name>:<id>`
   * in every backend the daemon has; intake keeps no table of its own for one
   * reference per project, so it finds its by name (RULINGS ruling 10).
   */
  async #credentialRefs(workspaceId: WorkspaceId): Promise<readonly string[]> {
    const needle = `:${trackerSecretName(workspaceId)}:`;
    return (await this.deps.secrets.list()).filter((ref) => ref.includes(needle));
  }
}

function unknownKind(config: TrackerConfig): string {
  return `Tandemise can't use '${config.kind}' as a tracker yet.`;
}
