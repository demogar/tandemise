import { existsSync } from 'node:fs';
import { errorMessage } from '@tandemise/shared';
import type { Integration, IntegrationHealth } from '@tandemise/domain';
import type {
  IntegrationHealthContext, IntegrationProvider, IntegrationTool,
} from '@tandemise/integrations-core';
import { chromium } from 'playwright';
import { browserConfigSchema, type BrowserConfig } from './options.js';
import type { BrowserSessionManager } from './session-manager.js';
import { browserTools } from './tools.js';

export const BROWSER_PROVIDER_ID = 'browser';

/** The one command that fixes the common failure. Worth stating verbatim. */
export const INSTALL_HINT = 'Run `npx playwright install chromium`.';

/**
 * Browser automation over Playwright (MVP.md §13.2).
 *
 * Second in the automation priority order (MVP.md §13.1): reach for it when no
 * API, CLI or MCP server can do the job. That is why the tools it publishes are
 * semantic - snapshot, click by role, wait for text - and why the pixel-level
 * ones (screenshot, evaluate) are the exceptions rather than the interface.
 */
export class BrowserIntegrationProvider implements IntegrationProvider {
  readonly id = BROWSER_PROVIDER_ID;
  readonly displayName = 'Browser';
  readonly transport = 'browser' as const;
  readonly configSchema = browserConfigSchema;
  readonly provides = ['browser.navigate', 'browser.read', 'browser.interact', 'browser.evaluate'];

  constructor(private readonly sessions: BrowserSessionManager) {}

  tools(integration: Integration): readonly IntegrationTool[] {
    const config = this.configSchema.safeParse(integration.config);
    return browserTools(
      integration.id,
      config.success ? config.data : this.configSchema.parse({}) as BrowserConfig,
      this.sessions,
    );
  }

  /**
   * Playwright ships a client library, not a browser. A fresh machine has the
   * dependency installed and nothing to drive, which fails at the worst moment
   * - mid-run, as an unrecognisable launch error - unless it is detected here
   * and reported with the command that fixes it.
   */
  async healthCheck(
    integration: Integration,
    ctx: IntegrationHealthContext,
  ): Promise<IntegrationHealth> {
    const checkedAt = ctx.clock.now();
    const config = this.configSchema.safeParse(integration.config);
    if (!config.success) {
      return {
        integrationId: integration.id,
        state: 'unavailable',
        detail: `Invalid configuration: ${config.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
        checkedAt,
      };
    }
    try {
      const executable = chromium.executablePath();
      if (!executable || !existsSync(executable)) {
        return {
          integrationId: integration.id,
          state: 'unavailable',
          detail: `Chromium is not installed for this Playwright version. ${INSTALL_HINT}`,
          checkedAt,
        };
      }
      return {
        integrationId: integration.id,
        state: 'healthy',
        detail: `Chromium available at ${executable}`,
        checkedAt,
      };
    } catch (e) {
      // `executablePath()` throws when the browser was never downloaded.
      return {
        integrationId: integration.id,
        state: 'unavailable',
        detail: `${errorMessage(e)} ${INSTALL_HINT}`,
        checkedAt,
      };
    }
  }
}
