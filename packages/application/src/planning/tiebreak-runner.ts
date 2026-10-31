import type { RuntimeProfileRepositoryPort, WorkspaceRepositoryPort } from '@tandemise/domain';
import type { RuntimeManager } from '@tandemise/runtimes-core';
import { asId, ids, type Logger, type TandemisePaths } from '@tandemise/shared';
import { TIEBREAK_TIMEOUT_MS, type TiebreakRunnerPort } from './tiebreak.js';

/**
 * The tiebreak on a real runtime: the planner role's runtime (or any enabled
 * one), given no grants, in the Tandemise home. It reads the prompt and answers;
 * it can't touch a repository.
 */
export function runtimeTiebreakRunner(deps: {
  readonly runtimeManager: RuntimeManager;
  readonly runtimeProfiles: RuntimeProfileRepositoryPort;
  readonly workspaces: WorkspaceRepositoryPort;
  readonly paths: TandemisePaths;
  readonly log: Logger;
}): TiebreakRunnerPort {
  return {
    async run({ prompt, model, signal, workspaceId }) {
      const ws = workspaceId === undefined ? undefined : deps.workspaces.get(asId<'WorkspaceId'>(workspaceId));
      const all = deps.runtimeProfiles.list(ws?.id).filter((p) => p.enabled);
      const routed = ws?.routing['architecture'] ?? [];
      const candidates = routed.length === 0 ? all : routed.flatMap((id) => all.filter((p) => p.id === id));
      const selected = await deps.runtimeManager.select(candidates, ['reasoning']);
      if (!selected.ok) throw new Error('no runtime was free to ask');
      const chunks: string[] = [];
      let costUsd: number | null = null;
      try {
        for await (const event of deps.runtimeManager.start({
          runId: ids.run(),
          profile: selected.value.profile,
          prompt,
          workingDirectory: deps.paths.root,
          grants: [],
          allowedRoots: [],
          mcpConfigPath: null,
          model,
          maxWallTimeMs: TIEBREAK_TIMEOUT_MS,
          reservation: selected.value.reservation,
          signal,
          log: deps.log.child({ component: 'tiebreak' }),
        })) {
          if (event.type === 'message') chunks.push(event.text);
          if (event.type === 'completed' && event.summary !== undefined) chunks.push(event.summary);
          if (event.type === 'usage' && event.costUsd !== null && event.costUsd !== undefined) costUsd = (costUsd ?? 0) + event.costUsd;
          if (event.type === 'failed') throw new Error(event.message);
        }
      } finally {
        selected.value.reservation.release();
      }
      return { text: chunks.join('\n'), costUsd, model };
    },
  };
}
