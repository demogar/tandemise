import { z } from 'zod';
import type { LifecycleComponent } from '@tandemise/kernel';
import type {
  BrainRecordRepositoryPort, EventBusPort, ExecutionTargetRepositoryPort, FeedbackRepositoryPort, Mission, MissionRepositoryPort,
  MissionTask, RoleRepositoryPort, RunEventRecord, RunRepositoryPort, RunScoreRepositoryPort, TaskRepositoryPort, WorkspaceRepositoryPort,
} from '@tandemise/domain';
import { isTrialMission } from '@tandemise/domain';
import type { FeedbackId, Logger, TaskId } from '@tandemise/shared';
import { asId, errorMessage, redactSecrets } from '@tandemise/shared';
import type { EventRecorder } from '../support/event-recorder.js';
import type { BrainService } from './brain-service.js';
import { HOLD_LONG_MS, REFLECTOR_EVIDENCE_CHARS, reflect, type ReflectorDeps, type ReflectorSignal } from './reflector.js';

/**
 * `task.hold_ended` as hold-and-interact (#50) records it. Parsed here by its
 * type, so the brain compiles before #50 lands and the signal is inert until
 * something publishes it.
 */
const holdEndedSchema = z.object({
  type: z.literal('task.hold_ended'),
  ending: z.enum(['continued', 'released']),
  durationMs: z.number().nonnegative().default(0),
  diffStat: z.object({ files: z.number(), insertions: z.number().optional(), deletions: z.number().optional() }).nullable().optional(),
}).passthrough();

/** `git diff` of a working directory, uncommitted changes included; bound by the daemon. */
export type WorktreeDiff = (directory: string) => Promise<string>;

export interface BrainSignalsDeps extends ReflectorDeps {
  readonly brain: BrainService;
  readonly bus: EventBusPort;
  readonly workspaces: Pick<WorkspaceRepositoryPort, 'get'>;
  readonly missions: Pick<MissionRepositoryPort, 'get'>;
  readonly tasks: Pick<TaskRepositoryPort, 'get'>;
  readonly runs: Pick<RunRepositoryPort, 'listByTask'>;
  readonly targets: Pick<ExecutionTargetRepositoryPort, 'get'>;
  readonly roles: Pick<RoleRepositoryPort, 'get'>;
  readonly feedback: Pick<FeedbackRepositoryPort, 'get'>;
  readonly runScores: Pick<RunScoreRepositoryPort, 'listByTask'>;
  readonly records: Pick<BrainRecordRepositoryPort, 'insertPass'>;
  readonly recorder: EventRecorder;
  readonly diff?: WorktreeDiff | null;
}

/**
 * Where lessons come from (#51 spec §6): a person's hold, a request for
 * changes, and a gate that failed then passed. Each one runs the reflector
 * once, whose structured output the brain validates, scrubs and appends.
 * Only for linked, non-trial missions. Learning never blocks the task.
 */
export class BrainSignals implements LifecycleComponent {
  readonly name = 'brain-signals';
  #unsubscribe: (() => void) | null = null;
  #queue: Promise<void> = Promise.resolve();
  readonly #log: Logger;

  constructor(private readonly deps: BrainSignalsDeps) {
    this.#log = deps.log.child({ component: 'brain-signals' });
  }

  async start(): Promise<void> {
    if (this.#unsubscribe !== null) return;
    this.#unsubscribe = this.deps.bus.subscribe((record) => {
      const type = (record.body as { type: string }).type;
      if (type !== 'task.hold_ended' && type !== 'task.round_started' && type !== 'gate.evaluated') return;
      // One at a time: a reflector pass holds a runtime slot, and order keeps the ledger readable.
      this.#queue = this.#queue.then(() => this.#handle(record)).catch((e) => this.#log.warn('brain.signal_failed', { error: errorMessage(e) }));
    });
  }

  async stop(): Promise<void> {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    await this.#queue;
  }

  /** Resolves when every signal seen so far has been handled. */
  async idle(): Promise<void> {
    let seen: Promise<void>;
    do {
      seen = this.#queue;
      await seen;
    } while (seen !== this.#queue);
  }

  async #handle(record: RunEventRecord): Promise<void> {
    if (record.taskId === null || record.taskId === undefined) return;
    const mission = this.deps.missions.get(record.missionId);
    if (mission === undefined || isTrialMission(mission)) return;
    if (this.deps.brain.linkOf(mission.workspaceId) === undefined) return;
    const task = this.deps.tasks.get(record.taskId);
    if (task === undefined) return;
    const body = record.body as { type: string } & Record<string, unknown>;
    if (body.type === 'task.hold_ended') {
      const hold = holdEndedSchema.safeParse(body);
      if (!hold.success) return;
      const changed = hold.data.ending === 'continued' && (hold.data.diffStat?.files ?? 0) > 0;
      if (!changed && hold.data.durationMs <= HOLD_LONG_MS) return;
      const stat = hold.data.diffStat;
      const diff = await this.#worktreeDiff(task.id);
      const evidence = [
        stat === null || stat === undefined ? 'No diff stat was recorded.' : `Changed while held: ${stat.files} files, +${stat.insertions ?? 0} -${stat.deletions ?? 0}.`,
        `The hold lasted ${Math.round(hold.data.durationMs / 1000)} seconds and ended: ${hold.data.ending}.`,
        diff === '' ? '' : `\nThe diff:\n${diff}`,
      ].join('\n');
      await this.#reflect(mission, task, 'hold', evidence);
      return;
    }
    if (body.type === 'task.round_started') {
      const idsList = Array.isArray(body['feedbackIds']) ? (body['feedbackIds'] as unknown[]).filter((x): x is string => typeof x === 'string') : [];
      const notes = idsList.flatMap((id) => {
        const item = this.deps.feedback.get(asId<'FeedbackId'>(id) as FeedbackId);
        return item === undefined || item.text.trim() === '' ? [] : [item.text.trim()];
      });
      if (notes.length === 0) return;
      await this.#reflect(mission, task, 'rejection', notes.map((n) => `- ${n}`).join('\n'));
      return;
    }
    if (body.type === 'gate.evaluated' && body['passed'] === true) {
      const scores = [...this.deps.runScores.listByTask(task.id)].sort((a, b) => a.attempt - b.attempt);
      const failed = scores.filter((s) => !s.gatePassed);
      if (failed.length === 0) return;
      const last = failed.at(-1)!;
      const diff = await this.#worktreeDiff(task.id);
      const evidence = [
        `The gate failed: ${last.gateDetail}`,
        `Facts it measured: ${JSON.stringify(last.facts)}`,
        diff === '' ? '' : `\nThe passing attempt's change:\n${diff}`,
      ].join('\n');
      await this.#reflect(mission, task, 'gate', evidence);
    }
  }

  async #worktreeDiff(taskId: TaskId): Promise<string> {
    if (this.deps.diff === undefined || this.deps.diff === null) return '';
    const run = this.deps.runs.listByTask(taskId).at(-1);
    const target = run === undefined ? undefined : this.deps.targets.get(asId<'ExecutionTargetId'>(run.executionTargetId));
    if (target === undefined) return '';
    try {
      return (await this.deps.diff(target.workingDirectory)).slice(0, REFLECTOR_EVIDENCE_CHARS);
    } catch (e) {
      this.#log.warn('brain.diff_failed', { taskId, error: errorMessage(e) });
      return '';
    }
  }

  async #reflect(mission: Mission, task: MissionTask, signal: ReflectorSignal, evidence: string): Promise<void> {
    const workspace = this.deps.workspaces.get(mission.workspaceId);
    const role = this.deps.roles.get(task.roleId, mission.workspaceId);
    if (workspace === undefined || role === undefined) return;
    const link = this.deps.brain.linkOf(mission.workspaceId);
    if (link === undefined) return;
    const run = this.deps.runs.listByTask(task.id).at(-1);
    const loadedIds = run?.brain?.loaded.map((l) => l.id) ?? [];
    const memory = this.deps.brain.memory(mission.workspaceId);
    const loaded = loadedIds.flatMap((id) => {
      const e = memory.entries.find((x) => x.id === (memory.aliases[id] ?? id));
      return e === undefined ? [] : [{ id: e.id, text: e.text }];
    });
    // Evidence is redacted before any model sees it; what comes back is scrubbed again on the way in.
    const pass = await reflect(this.deps, { workspace, role }, {
      objective: task.objective, roleName: role.name, signal, evidence: redactSecrets(evidence), loaded,
    });
    const failed = 'problem' in pass.result ? pass.result.problem : null;
    this.deps.records.insertPass({
      id: pass.passId, workspaceId: mission.workspaceId, missionId: mission.id, taskId: task.id, kind: 'reflect', signal,
      runtimeProfileId: pass.profileId, model: pass.model, status: failed === null ? 'ok' : 'failed', reason: failed,
      usage: pass.usage, createdAt: this.deps.clock.now(),
    });
    if ('problem' in pass.result) {
      this.#log.warn('brain.reflector_failed', { taskId: task.id, signal, reason: pass.result.problem });
      return;
    }
    const output = pass.result.output;
    const state = signal === 'gate' ? 'candidate' as const : 'active' as const;
    const known = new Set(loaded.map((l) => l.id));
    const added = await this.deps.brain.append(mission.workspaceId, [
      ...output.lessons.map((l) => ({
        op: 'add' as const,
        entry: {
          kind: 'lesson' as const, text: l.text, scope: { ...l.scope }, state,
          source: { signal, mission: mission.title, ...(run === undefined ? {} : { run: { daemon: link.writerId, runId: run.id } }) },
        },
      })),
      ...output.tags.filter((t) => t.tag !== 'unused' && known.has(t.id)).map((t) => ({
        op: 'vote' as const, id: t.id, vote: t.tag as 'helpful' | 'harmful', why: 'reflector' as const, mission: mission.title,
      })),
    ], { actor: 'reflector', missionId: mission.id });
    if (signal === 'gate') return;
    for (const event of added) {
      if (event.op !== 'add') continue;
      this.deps.recorder.record({ workspaceId: mission.workspaceId, missionId: mission.id, taskId: task.id }, {
        type: 'brain.learned', entryId: event.id, text: event.entry.text, signal,
      });
    }
  }
}
