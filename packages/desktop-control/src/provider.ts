import { errorMessage, type Clock } from '@tandemise/shared';
import type { Integration, IntegrationHealth } from '@tandemise/domain';
import type {
  IntegrationHealthContext, IntegrationProvider, IntegrationTool,
} from '@tandemise/integrations-core';
import type { MacOSHelperClient } from './client.js';
import { DEFAULT_DESKTOP_CONFIG, desktopConfigSchema } from './config.js';
import { desktopTools } from './tools.js';

export const DESKTOP_PROVIDER_ID = 'desktop';

/**
 * Generic macOS application control (MVP.md §13.3).
 *
 * The provider owns no native code: it turns an `Integration` row into tools
 * that talk to `native/macos-helper` through `MacOSHelperClient`. That split is
 * why an app-specific driver (Xcode, the iOS Simulator - MVP.md §13.5) can be a
 * second provider reusing the same helper rather than a fork of this one.
 */
export class DesktopIntegrationProvider implements IntegrationProvider {
  readonly id = DESKTOP_PROVIDER_ID;
  readonly displayName = 'macOS Desktop';
  readonly transport = 'desktop' as const;
  readonly configSchema = desktopConfigSchema;
  readonly provides = [
    'desktop.apps', 'desktop.launch', 'desktop.inspect', 'desktop.click',
    'desktop.type', 'desktop.shortcut', 'desktop.screenshot',
  ];

  constructor(
    private readonly client: MacOSHelperClient,
    private readonly clock: Clock,
  ) {}

  tools(integration: Integration): readonly IntegrationTool[] {
    const parsed = this.configSchema.safeParse(integration.config);
    // The catalog validates config before calling this; reaching here with an
    // invalid one means a direct caller, and the defaults are the safe reading.
    return desktopTools({
      integrationId: integration.id,
      client: this.client,
      config: parsed.success ? parsed.data : DEFAULT_DESKTOP_CONFIG,
      clock: this.clock,
    });
  }

  /**
   * Answers three questions in one probe: is the helper there, can it run, and
   * has macOS granted it anything.
   *
   * Never throws. A missing binary and an ungranted permission are both ordinary
   * states of a developer's machine, and every `detail` names the exact action
   * that fixes it - "unavailable" with no instruction is barely better than
   * silence (MVP.md §12.5).
   */
  async healthCheck(
    integration: Integration,
    ctx: IntegrationHealthContext,
  ): Promise<IntegrationHealth> {
    const checkedAt = ctx.clock.now();
    const base = { integrationId: integration.id, checkedAt } as const;

    if (ctx.signal.aborted) {
      return { ...base, state: 'unknown', detail: 'The health check was cancelled before it ran' };
    }

    let version: string;
    try {
      version = (await this.client.ping()).version;
    } catch (e) {
      return {
        ...base,
        state: 'unavailable',
        detail:
          `The macOS helper at ${this.client.binaryPath} did not respond: ${errorMessage(e)}. `
            + 'Build it with `swift build -c release` in native/macos-helper.',
      };
    }

    let permissions;
    try {
      permissions = await this.client.permissions();
    } catch (e) {
      return {
        ...base,
        state: 'degraded',
        detail: `The macOS helper ${version} is running but could not report its permissions: ${errorMessage(e)}`,
      };
    }

    const blockers: string[] = [];
    if (!permissions.accessibility) {
      blockers.push(
        'Inspection, clicking and typing are unavailable without Accessibility. '
          + 'Grant it in System Settings → Privacy & Security → Accessibility '
          + `for ${permissions.executablePath || 'the helper'} (or for the application that launched it).`,
      );
    }
    if (!permissions.screenRecording) {
      blockers.push(
        'Screenshots are unavailable without Screen Recording. '
          + 'Grant it in System Settings → Privacy & Security → Screen Recording.',
      );
    }
    if (permissions.screenLocked) {
      blockers.push(
        'The screen is locked; macOS hides every application\'s user interface until the session is unlocked.',
      );
    }

    if (blockers.length === 0) {
      return { ...base, state: 'healthy', detail: `macOS helper ${version}; Accessibility and Screen Recording granted` };
    }
    return { ...base, state: 'degraded', detail: `macOS helper ${version}. ${blockers.join(' ')}` };
  }
}
