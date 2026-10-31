import { z } from 'zod';
import { TandemiseError } from '@tandemise/shared';
import type { CommandExecutor, ToolExecResult } from '@tandemise/integrations-core';
import type { BrainHostPort, BrainPrState } from '@tandemise/domain';
import { gh, ghJson } from './gh.js';

const prStateSchema = z.object({ state: z.string() });
const prListSchema = z.array(z.object({ url: z.string(), state: z.string() }));

function stateOf(raw: string): BrainPrState | null {
  const s = raw.toUpperCase();
  return s === 'OPEN' ? 'open' : s === 'MERGED' ? 'merged' : s === 'CLOSED' ? 'closed' : null;
}

/**
 * The brain's host through `gh` (#51 spec §3, §8): creating the private
 * repository, and the pull requests promotions and conflicting edits open.
 * Like the rest of the GitHub integration, it uses the session `gh` already
 * holds and stores no credential.
 */
export class GhBrainHost implements BrainHostPort {
  constructor(private readonly exec: CommandExecutor) {}

  async available(): Promise<{ ok: true } | { ok: false; reason: string }> {
    try {
      const result = await this.exec.run({ command: 'gh', args: ['auth', 'status'], timeoutMs: 20_000, env: { GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' } });
      return result.exitCode === 0 ? { ok: true } : { ok: false, reason: 'GitHub CLI is not connected.' };
    } catch {
      return { ok: false, reason: 'GitHub CLI is not connected.' };
    }
  }

  async createRepo(owner: string, name: string): Promise<{ remote: string }> {
    await gh({ exec: this.exec }, ['repo', 'create', `${owner}/${name}`, '--private'], { timeoutMs: 60_000 });
    return { remote: `https://github.com/${owner}/${name}.git` };
  }

  async openPr(input: { clone: string; head: string; base: string; title: string; body: string; draft: boolean }): Promise<{ url: string }> {
    const result: ToolExecResult = await this.exec.run({
      command: 'gh',
      args: ['pr', 'create', '--head', input.head, '--base', input.base, '--title', input.title, '--body-file', '-', ...(input.draft ? ['--draft'] : [])],
      cwd: input.clone,
      stdin: input.body,
      timeoutMs: 60_000,
      env: { GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' },
    });
    if (result.exitCode !== 0) {
      throw new TandemiseError('INTEGRATION_FAILED', `Couldn't open the pull request: ${(result.stderr.trim() || result.stdout.trim()).split('\n').pop() ?? ''}`);
    }
    const url = result.stdout.split('\n').map((l) => l.trim()).filter((l) => /^https?:\/\//.test(l)).pop();
    if (url === undefined) throw new TandemiseError('INTEGRATION_FAILED', 'gh opened a pull request but printed no address.');
    return { url };
  }

  async findPr(clone: string, head: string): Promise<{ url: string; state: BrainPrState } | null> {
    const list = await ghJson({ exec: this.exec, workingDirectory: clone }, ['pr', 'list', '--head', head, '--state', 'all', '--json', 'url,state'], prListSchema);
    for (const pr of list) {
      const state = stateOf(pr.state);
      if (state !== null) return { url: pr.url, state };
    }
    return null;
  }

  async prState(clone: string, url: string): Promise<BrainPrState | null> {
    const view = await ghJson({ exec: this.exec, workingDirectory: clone }, ['pr', 'view', url, '--json', 'state'], prStateSchema);
    return stateOf(view.state);
  }
}
