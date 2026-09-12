import type { Logger, WorkerAssignmentId } from '@tandemise/shared';
import type { WorkerAssignment } from '@tandemise/domain';
import { DomainAllowlist } from './allowlist.js';
import { BrowserProfileManager, profileDirectory } from './profiles.js';
import { BrowserSession } from './session.js';
import type { BrowserConfig, BrowserOptions } from './options.js';

/**
 * One browser session per worker assignment, created on first use.
 *
 * Lazily, because most runs never touch a browser and launching Chromium costs
 * a second and a hundred megabytes; per assignment, because the allowlist and
 * the console/network history are properties of one piece of work, not of the
 * profile it borrowed.
 */
export class BrowserSessionManager {
  readonly #sessions = new Map<WorkerAssignmentId, {
    session: BrowserSession;
    directory: string;
  }>();
  /** Serialises concurrent first-use for the same assignment. */
  readonly #opening = new Map<WorkerAssignmentId, Promise<BrowserSession>>();

  constructor(
    private readonly profiles: BrowserProfileManager,
    private readonly options: BrowserOptions,
    private readonly log: Logger,
  ) {}

  async acquire(assignment: WorkerAssignment, config: BrowserConfig): Promise<BrowserSession> {
    const existing = this.#sessions.get(assignment.id);
    if (existing) return existing.session;
    const opening = this.#opening.get(assignment.id);
    if (opening) return opening;

    const promise = this.#open(assignment, config);
    this.#opening.set(assignment.id, promise);
    try {
      return await promise;
    } finally {
      this.#opening.delete(assignment.id);
    }
  }

  current(assignmentId: WorkerAssignmentId): BrowserSession | undefined {
    return this.#sessions.get(assignmentId)?.session;
  }

  async release(assignmentId: WorkerAssignmentId): Promise<void> {
    const entry = this.#sessions.get(assignmentId);
    if (!entry) return;
    this.#sessions.delete(assignmentId);
    await entry.session.close();
    await this.profiles.release(entry.directory);
  }

  async closeAll(): Promise<void> {
    for (const id of [...this.#sessions.keys()]) await this.release(id);
    await this.profiles.closeAll();
  }

  async #open(assignment: WorkerAssignment, config: BrowserConfig): Promise<BrowserSession> {
    const allowlist = DomainAllowlist.forAssignment(assignment);
    if (allowlist.unrestricted) {
      // An unrestricted browser is a decision someone made when they wrote the
      // grant. It should look like one in the log rather than pass unremarked.
      this.log.warn('browser.allowlist_unrestricted', {
        assignmentId: assignment.id,
        missionId: assignment.missionId,
      });
    }
    const directory = profileDirectory(
      this.options.profileRoot(assignment.workspaceId),
      config.profile,
    );
    const downloadDirectory = this.options.downloadDirectory(
      assignment.workspaceId,
      assignment.missionId,
    );
    const context = await this.profiles.acquire(directory, {
      headless: config.headless,
      downloadDirectory,
      ...(config.viewport ? { viewport: config.viewport } : {}),
    });
    const session = await BrowserSession.open(context, {
      profileName: config.profile,
      allowlist,
      downloadDirectory,
      defaultTimeoutMs: config.defaultTimeoutMs,
      log: this.log.child({ assignmentId: assignment.id, profile: config.profile }),
    });
    this.#sessions.set(assignment.id, { session, directory });
    this.log.info('browser.session_opened', {
      assignmentId: assignment.id,
      profile: config.profile,
      allowlist: allowlist.describe(),
    });
    return session;
  }
}
