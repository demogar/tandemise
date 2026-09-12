import { defineModule, token, type TandemiseModule } from '@tandemise/kernel';
import type { Clock } from '@tandemise/shared';
import { systemClock } from '@tandemise/shared';
import { createCommandCheckRunner, type CheckRunnerPort, type CommandExecutor } from './checks.js';

export const CHECK_RUNNER = token<CheckRunnerPort>('CheckRunnerPort');
/**
 * Bound by the execution layer. `@tandemise/evaluation` may not spawn processes
 * itself (MVP.md §6.1), so the executor arrives as a dependency.
 */
export const COMMAND_EXECUTOR = token<CommandExecutor>('CommandExecutor');

export interface EvaluationModuleOptions {
  readonly clock?: Clock;
  readonly defaultTimeoutMs?: number;
}

export function createEvaluationModule(options: EvaluationModuleOptions = {}): TandemiseModule {
  const clock = options.clock ?? systemClock;
  return defineModule('evaluation', (container) => {
    container.bind(
      CHECK_RUNNER,
      (r) => createCommandCheckRunner({
        execute: r.resolve(COMMAND_EXECUTOR),
        clock,
        ...(options.defaultTimeoutMs !== undefined ? { defaultTimeoutMs: options.defaultTimeoutMs } : {}),
      }),
      { source: 'evaluation' },
    );
  });
}

export const evaluationModule: TandemiseModule = createEvaluationModule();
