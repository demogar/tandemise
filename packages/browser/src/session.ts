import { join } from 'node:path';
import { TandemiseError, errorMessage, type Logger } from '@tandemise/shared';
import type { BrowserContext, Page } from 'playwright';
import type { DomainAllowlist } from './allowlist.js';

/** Ring-buffer bound. A long QA session must not turn into a memory leak. */
const MAX_LOG_ENTRIES = 500;

export interface ConsoleEntry {
  readonly level: string;
  readonly text: string;
  readonly at: number;
}

export interface NetworkEntry {
  readonly method: string;
  readonly url: string;
  readonly status: number | null;
  readonly resourceType: string;
  readonly at: number;
}

export interface BlockedEntry {
  readonly url: string;
  readonly resourceType: string;
  readonly at: number;
}

export interface BrowserSessionOptions {
  readonly profileName: string;
  readonly allowlist: DomainAllowlist;
  readonly downloadDirectory: string;
  readonly defaultTimeoutMs: number;
  readonly log: Logger;
}

/**
 * One assignment's browser: a page, its allowlist, and what it has observed.
 *
 * The allowlist is enforced by route interception on the *page*, not by
 * checking URLs before navigating. Both are done - the pre-check gives a useful
 * error message - but only the interception is a boundary: a page can navigate
 * itself through a redirect, a meta refresh, a form post or a script, and none
 * of those pass through a tool call where a URL could be inspected.
 */
export class BrowserSession {
  readonly #console: ConsoleEntry[] = [];
  readonly #network: NetworkEntry[] = [];
  readonly #blocked: BlockedEntry[] = [];
  readonly #downloads: string[] = [];

  private constructor(
    readonly page: Page,
    readonly options: BrowserSessionOptions,
  ) {}

  static async open(
    context: BrowserContext,
    options: BrowserSessionOptions,
  ): Promise<BrowserSession> {
    const page = await context.newPage();
    page.setDefaultTimeout(options.defaultTimeoutMs);
    const session = new BrowserSession(page, options);
    await session.#install();
    return session;
  }

  get allowlist(): DomainAllowlist {
    return this.options.allowlist;
  }

  /**
   * Pre-flight check for an explicit navigation. Route interception would catch
   * this too, but as an opaque `net::ERR_FAILED`; an agent that is told which
   * hosts it may reach can correct itself instead of retrying.
   */
  assertAllowed(url: string): void {
    if (this.options.allowlist.allows(url)) return;
    throw TandemiseError.permissionDenied(
      `Navigation to '${url}' is outside this assignment's domain allowlist`,
      { url, allowlist: this.options.allowlist.describe() },
    );
  }

  consoleLogs(limit = 100): readonly ConsoleEntry[] {
    return this.#console.slice(-limit);
  }

  networkLog(limit = 100): readonly NetworkEntry[] {
    return this.#network.slice(-limit);
  }

  blockedRequests(limit = 100): readonly BlockedEntry[] {
    return this.#blocked.slice(-limit);
  }

  downloads(): readonly string[] {
    return [...this.#downloads];
  }

  async close(): Promise<void> {
    try {
      await this.page.close();
    } catch {
      // Closing an already-closed page is not a failure worth propagating.
    }
  }

  async #install(): Promise<void> {
    const { log, allowlist } = this.options;

    await this.page.route('**/*', async (route) => {
      const request = route.request();
      const url = request.url();
      if (allowlist.allows(url)) {
        await route.continue();
        return;
      }
      push(this.#blocked, { url, resourceType: request.resourceType(), at: Date.now() });
      log.warn('browser.request_blocked', { url, resourceType: request.resourceType() });
      await route.abort('blockedbyclient');
    });

    this.page.on('console', (message) => {
      push(this.#console, { level: message.type(), text: message.text(), at: Date.now() });
    });
    this.page.on('pageerror', (error) => {
      push(this.#console, { level: 'pageerror', text: errorMessage(error), at: Date.now() });
    });
    this.page.on('requestfinished', (request) => {
      void request.response().then((response) => {
        push(this.#network, {
          method: request.method(),
          url: request.url(),
          status: response?.status() ?? null,
          resourceType: request.resourceType(),
          at: Date.now(),
        });
      }).catch(() => { /* a response that never arrived is already in `blocked` */ });
    });
    this.page.on('requestfailed', (request) => {
      push(this.#network, {
        method: request.method(),
        url: request.url(),
        status: null,
        resourceType: request.resourceType(),
        at: Date.now(),
      });
    });

    // Downloads land in a mission-scoped directory (MVP.md §13.2) rather than
    // the user's Downloads folder, so a run's side effects stay inside the run.
    this.page.on('download', (download) => {
      const target = join(this.options.downloadDirectory, download.suggestedFilename());
      void download.saveAs(target)
        .then(() => {
          this.#downloads.push(target);
          log.info('browser.download_saved', { path: target });
        })
        .catch((e: unknown) => log.warn('browser.download_failed', { error: errorMessage(e) }));
    });
  }
}

function push<T>(buffer: T[], entry: T): void {
  buffer.push(entry);
  if (buffer.length > MAX_LOG_ENTRIES) buffer.splice(0, buffer.length - MAX_LOG_ENTRIES);
}
