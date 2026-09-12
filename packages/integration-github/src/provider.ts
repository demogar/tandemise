import { errorMessage } from '@tandemise/shared';
import type { Integration, IntegrationHealth } from '@tandemise/domain';
import type {
  IntegrationHealthContext, IntegrationProvider, IntegrationTool,
} from '@tandemise/integrations-core';
import { githubConfigSchema, type GitHubConfig } from './config.js';
import { githubTools } from './tools.js';
import { isMissingCli } from './gh.js';

export const GITHUB_PROVIDER_ID = 'github';

/**
 * GitHub over the `gh` CLI (MVP.md §12.5).
 *
 * The CLI is the MVP transport precisely because it is already authenticated:
 * Tandemise inherits a session it never sees, so there is no credential in the
 * database, the logs or the event stream (MVP.md §P8). A GitHub App with its
 * own OAuth flow is the later upgrade, and it slots in as a second provider
 * without any caller changing.
 */
export class GitHubIntegrationProvider implements IntegrationProvider {
  readonly id = GITHUB_PROVIDER_ID;
  readonly displayName = 'GitHub';
  readonly transport = 'cli' as const;
  readonly configSchema = githubConfigSchema;
  readonly provides = ['github.read', 'github.pr.create', 'github.pr.comment', 'github.issue.create'];

  tools(integration: Integration): readonly IntegrationTool[] {
    const config = this.configSchema.safeParse(integration.config);
    // The catalog validates config before calling this, so an invalid config
    // here means a direct caller; empty config is the safe reading of it.
    return githubTools(integration.id, config.success ? config.data : ({} as GitHubConfig));
  }

  /**
   * `gh auth status` is the whole health check.
   *
   * It must never throw: a missing binary and an expired login are ordinary
   * states of a developer machine, and a provider that threw here would take
   * the entire integration registry down at startup. Each state gets a detail
   * string that names the command that fixes it - an unavailable integration
   * the user cannot act on is only marginally better than a silent one.
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
      const result = await ctx.exec.run({
        command: 'gh',
        args: ['auth', 'status', ...(config.data.hostname ? ['--hostname', config.data.hostname] : [])],
        timeoutMs: 15_000,
        signal: ctx.signal,
        env: { GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' },
      });
      if (result.exitCode === 0) {
        return {
          integrationId: integration.id,
          state: 'healthy',
          // gh prints the account and scopes on stderr; that line is the useful
          // part of the answer, and redaction upstream masks the token in it.
          detail: firstMeaningfulLine(result.stderr || result.stdout) || 'gh is authenticated',
          checkedAt,
        };
      }
      if (isMissingCli(result)) return this.#missing(integration, checkedAt);
      return {
        integrationId: integration.id,
        state: 'unavailable',
        detail: 'The GitHub CLI is not authenticated. Run `gh auth login`.',
        checkedAt,
      };
    } catch (e) {
      // The executor itself failed - most often because `gh` does not exist.
      const message = errorMessage(e);
      if (/ENOENT|not found/i.test(message)) return this.#missing(integration, checkedAt);
      return {
        integrationId: integration.id,
        state: 'unknown',
        detail: `Could not run \`gh auth status\`: ${message}`,
        checkedAt,
      };
    }
  }

  #missing(integration: Integration, checkedAt: string): IntegrationHealth {
    return {
      integrationId: integration.id,
      state: 'unavailable',
      detail: 'The GitHub CLI (gh) is not installed. Install it from https://cli.github.com, then run `gh auth login`.',
      checkedAt,
    };
  }
}

function firstMeaningfulLine(text: string): string {
  return text.split('\n').map((l) => l.trim()).find((l) => l.length > 0 && !l.startsWith('---')) ?? '';
}
