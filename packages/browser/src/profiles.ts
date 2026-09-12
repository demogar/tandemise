import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { slugify, type Logger } from '@tandemise/shared';
import { chromium, type BrowserContext } from 'playwright';

export interface ProfileLaunchOptions {
  readonly headless: boolean;
  readonly viewport?: { readonly width: number; readonly height: number };
  readonly downloadDirectory: string;
}

/** `<paths.browserProfiles(workspaceId)>/<profile>`. Names reach the filesystem, so they are slugified. */
export function profileDirectory(root: string, profileName: string): string {
  return join(root, slugify(profileName));
}

/**
 * Isolated, persistent browser profiles (MVP.md §13.2).
 *
 * A profile is a directory of cookies and local storage, named by purpose -
 * `qa`, `product`, `finance`. Two properties follow, and both are the point:
 *
 *  - a `qa` login survives across missions, so a worker does not re-authenticate
 *    on every run;
 *  - `qa` and `finance` cannot see each other's sessions, so a QA worker holding
 *    a browser is not also holding the finance tool's credentials.
 *
 * Chromium will not open the same user-data directory twice, so one context is
 * shared per profile directory and reference-counted. Per-assignment isolation
 * happens one level down, on the page: each session installs its own route
 * interception and therefore its own domain allowlist.
 */
export class BrowserProfileManager {
  readonly #contexts = new Map<string, { context: BrowserContext; refs: number }>();

  constructor(private readonly log: Logger) {}

  async acquire(directory: string, options: ProfileLaunchOptions): Promise<BrowserContext> {
    const existing = this.#contexts.get(directory);
    if (existing) {
      existing.refs += 1;
      return existing.context;
    }
    await mkdir(directory, { recursive: true });
    await mkdir(options.downloadDirectory, { recursive: true });
    const context = await chromium.launchPersistentContext(directory, {
      headless: options.headless,
      acceptDownloads: true,
      downloadsPath: options.downloadDirectory,
      ...(options.viewport ? { viewport: { ...options.viewport } } : {}),
    });
    this.#contexts.set(directory, { context, refs: 1 });
    this.log.info('browser.profile_opened', { directory, headless: options.headless });
    return context;
  }

  async release(directory: string): Promise<void> {
    const entry = this.#contexts.get(directory);
    if (!entry) return;
    entry.refs -= 1;
    if (entry.refs > 0) return;
    this.#contexts.delete(directory);
    await entry.context.close();
    this.log.debug('browser.profile_closed', { directory });
  }

  async closeAll(): Promise<void> {
    const entries = [...this.#contexts.values()];
    this.#contexts.clear();
    for (const entry of entries) {
      try {
        await entry.context.close();
      } catch {
        // Shutdown must not be blocked by a context that is already gone.
      }
    }
  }

  openProfiles(): readonly string[] {
    return [...this.#contexts.keys()];
  }
}
