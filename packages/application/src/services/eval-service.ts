import type {
  ArtifactManifest, ArtifactRepositoryPort, ArtifactStorePort, DecisionRepositoryPort, EvalBlobPort, EvalCandidate, EvalCase,
  EvalCaseCriterion, EvalCaseInput, EvalCaseProvenance, EvalCaseSnapshot, EvalRepositoryPort, EvalRoleVariant, EvalRun, EvalSuite,
  EvalTrial, GateExpression, Mission, MissionCriteriaRepositoryPort, MissionQuestionRepositoryPort, MissionRepositoryPort,
  MissionTask, RepoRepositoryPort, Repository, RoleRepositoryPort, Run, RunInputRepositoryPort, RunRepositoryPort,
  RunScoreRepositoryPort, SkillPin, SkillRef, TaskRepositoryPort, WorkspaceRepositoryPort,
} from '@tandemise/domain';
import { EMPTY_KNOWLEDGE, NO_ROLE_MODELS } from '@tandemise/domain';
import { summarizeRunScores, type RoleModelSummary } from '@tandemise/evaluation';
import type { CommandExecutor } from '@tandemise/integrations-core';
import type { Clock, EvalCaseId, EvalRunId, EvalSuiteId, TaskId, WorkspaceId } from '@tandemise/shared';
import { TandemiseError, errorMessage, ids } from '@tandemise/shared';
import { evalSpend, scorecardFor } from '../engine/eval-runner.js';
import { readSetup } from '../setup/codec.js';
import type { Caller } from '../support/identity.js';
import { liveArtifacts, upstreamTaskIds } from '../support/lineage.js';
import type { SkillService } from './skill-service.js';

/** Eval-specific refusals (P3b spec Part B). `EvalErrorCode`s beyond this task's own belong to later work (runs, trials). */
export type EvalErrorCode =
  | 'not_succeeded' | 'no_run' | 'no_gate' | 'base_unresolved' | 'input_missing' | 'role_missing'
  | 'skill_unknown' | 'setup_invalid' | 'cap_required' | 'repeats_range' | 'suite_empty' | 'already_running' | 'not_running';

/**
 * An eval refusal in words the person can act on. Its own class rather than a
 * `TandemiseError` because the HTTP layer (Task 7) maps each code to its own
 * response, the way `ContributionError` is mapped today.
 */
export class EvalError extends Error {
  constructor(readonly code: EvalErrorCode, message: string) {
    super(message);
    this.name = 'EvalError';
  }
}

/** How long a `git rev-parse` may take before a case's base commit gives up looking. */
const GIT_TIMEOUT_MS = 30_000;

const NO_GATE_MESSAGE = 'Only a step with a completion gate can be an eval case, because the gate is what scores it.';
const BASE_UNRESOLVED_MESSAGE = "The branch this step started from no longer exists, so this step can't be saved as a case.";
const ALREADY_RUNNING_MESSAGE = 'A run on this suite is still going. Cancel it first.';

/** Repeats when the person names none, and the range they may name (Global Constraints). */
const DEFAULT_REPEATS = 3;
const MAX_REPEATS = 10;

/** A run as the Evals screen reads it: its trials, and what it has spent so far. */
export interface EvalRunDetail {
  readonly run: EvalRun;
  readonly trials: readonly EvalTrial[];
  /** Null when any finished trial's cost is unknown: unknown is never $0. */
  readonly spentUsd: number | null;
  /** True when a finished trial reported no cost, so the cap cannot stop this run. */
  readonly costUnmeasured: boolean;
}

/** What the service asks of the eval runner; resolved lazily, since the runner is composed from the executor. */
export interface EvalRunnerControl {
  wake(): void;
  cancel(runId: EvalRunId): void;
}

export interface EvalServiceDeps {
  readonly evals: EvalRepositoryPort;
  readonly runScores: RunScoreRepositoryPort;
  /** Content-addressed bytes for a case's inputs, so it outlives its mission. */
  readonly blobs: EvalBlobPort;
  readonly artifacts: ArtifactRepositoryPort;
  readonly artifactStore: ArtifactStorePort;
  readonly runs: RunRepositoryPort;
  readonly runInputs: RunInputRepositoryPort;
  readonly tasks: TaskRepositoryPort;
  readonly missions: MissionRepositoryPort;
  readonly repositories: RepoRepositoryPort;
  readonly workspaces: WorkspaceRepositoryPort;
  readonly decisions: DecisionRepositoryPort;
  readonly questions: MissionQuestionRepositoryPort;
  readonly criteria: MissionCriteriaRepositoryPort;
  /** Raw git, the way `ContributionDeps.exec` runs it; null in a build without one. */
  readonly exec?: CommandExecutor | null;
  readonly clock: Clock;
  /** Today's roles, frozen into a run's baseline. */
  readonly roles: RoleRepositoryPort;
  /** Role pins for the baseline, the library for a skills candidate, and the store a setup's pins must be in. */
  readonly skills: Pick<SkillService, 'catalog' | 'pinsFor' | 'missing'>;
  /** A `.tandemise` folder's files, for a setup candidate (`SetupService.readFolder`). */
  readonly readSetupFolder: (path: string) => Promise<{ readonly files: Readonly<Record<string, string>> }>;
  readonly runner: () => EvalRunnerControl;
}

/**
 * Eval suites, saving a finished step as a case, and the run-score summary
 * (P3b spec Part B, §B2, §B6). Trials, candidates and the eval run itself
 * are later tasks; this service only freezes what a case needs to be replayed.
 */
export class EvalService {
  constructor(private readonly deps: EvalServiceDeps) {}

  // `caller` is carried on every mutation for the authorization a later task adds; `EvalSuite` itself records no owner.
  createSuite(workspaceId: WorkspaceId, caller: Caller, name: string): EvalSuite {
    const trimmed = name.trim();
    if (trimmed.length === 0) throw TandemiseError.validation('Name the suite.');
    if (this.deps.evals.listSuites(workspaceId).some((s) => s.name === trimmed)) {
      throw new TandemiseError('CONFLICT', 'A suite with that name already exists.');
    }
    const now = this.deps.clock.now();
    return this.deps.evals.createSuite({ id: ids.evalSuite(), workspaceId, name: trimmed, createdAt: now, updatedAt: now });
  }

  listSuites(workspaceId: WorkspaceId): readonly (EvalSuite & { readonly cases: number })[] {
    return this.deps.evals.listSuites(workspaceId);
  }

  deleteSuite(suiteId: EvalSuiteId, caller: Caller): void {
    if (this.deps.evals.getSuite(suiteId) === undefined) throw TandemiseError.notFound('Eval suite', suiteId);
    this.#refuseIfActive(suiteId);
    this.deps.evals.deleteSuite(suiteId);
  }

  /**
   * Freezes a finished, gated step as a replayable case (spec B2), in two
   * phases: first everything is read and validated - including reading each
   * input's bytes, but never storing them - and only once every refusal has
   * had its chance does anything get written: each input into the blob
   * store, then the suite (if new), then the case itself. A case that failed
   * halfway through - inputs copied, name rejected - would leave a blob no
   * case ever points to and, worse, a suite nobody asked for.
   */
  async saveCase(
    taskId: TaskId,
    caller: Caller,
    req: { readonly suiteId?: EvalSuiteId; readonly newSuiteName?: string; readonly name: string },
  ): Promise<EvalCase> {
    const task = this.deps.tasks.get(taskId);
    if (task === undefined) throw TandemiseError.notFound('Task', taskId);
    if (task.status !== 'SUCCEEDED' || task.executor !== 'agent') {
      throw new EvalError('not_succeeded', 'Only a finished step can be saved as a case.');
    }
    const gate = task.completionGate;
    if (gate === null) throw new EvalError('no_gate', NO_GATE_MESSAGE);
    const mission = this.deps.missions.get(task.missionId);
    if (mission === undefined) throw TandemiseError.notFound('Mission', task.missionId);

    const firstRun = this.#firstRun(task);

    const repositoryId = task.repositoryId ?? mission.repositoryId;
    const repository = repositoryId === null ? undefined : this.deps.repositories.get(repositoryId);
    if (repository === undefined) throw new EvalError('base_unresolved', BASE_UNRESOLVED_MESSAGE);
    const baseSha = await this.#resolveBaseSha(task, mission, repository);

    // Phase (a): read every input's manifest and bytes. Nothing is written yet.
    const pendingInputs = await this.#readInputs(firstRun.id);
    const step = this.#buildStep(task, gate);
    const missionContext = this.#missionContext(mission);
    const criteria = this.#criteriaList(mission);
    const referenceOutputs = this.#referenceOutputs(mission, task);

    // Phase (b): validate the name and the suite choice. Still nothing written.
    const name = req.name.trim();
    if (name.length < 1 || name.length > 80) throw TandemiseError.validation('Name the case 1-80 characters.');
    const newSuiteName = req.newSuiteName?.trim();
    if (req.suiteId === undefined && (newSuiteName === undefined || newSuiteName.length === 0)) {
      throw TandemiseError.validation('Pick a suite or name a new one.');
    }
    let existingSuite: EvalSuite | undefined;
    if (req.suiteId !== undefined) {
      existingSuite = this.#requireSuite(req.suiteId);
      // A suite from another workspace is not this workspace's to pick.
      if (existingSuite.workspaceId !== mission.workspaceId) throw TandemiseError.notFound('Eval suite', req.suiteId);
    } else if (this.deps.evals.listSuites(mission.workspaceId).some((s) => s.name === newSuiteName)) {
      throw new TandemiseError('CONFLICT', 'A suite with that name already exists.');
    }

    // Only now, once every refusal above has had its chance, does anything get written.
    const inputs = await this.#storeInputs(pendingInputs);
    const suite = existingSuite ?? this.createSuite(mission.workspaceId, caller, newSuiteName!);
    const snapshot: EvalCaseSnapshot = {
      repositoryId: repository.id, baseSha, inputs, step, mission: missionContext, criteria,
    };
    const provenance: EvalCaseProvenance = {
      missionId: mission.id, missionTitle: mission.title, taskId: task.id, runId: firstRun.id,
      inputArtifactIds: this.deps.runInputs.listByRun(firstRun.id), referenceOutputs,
    };
    const kase: EvalCase = {
      id: ids.evalCase(), suiteId: suite.id, name, snapshot, provenance,
      createdBy: caller.personId, createdAt: this.deps.clock.now(),
    };
    return this.deps.evals.insertCase(kase);
  }

  listCases(suiteId: EvalSuiteId): readonly EvalCase[] {
    return this.deps.evals.listCases(suiteId);
  }

  deleteCase(caseId: EvalCaseId, caller: Caller): void {
    const kase = this.deps.evals.getCase(caseId);
    if (kase === undefined) throw TandemiseError.notFound('Eval case', caseId);
    this.#refuseIfActive(kase.suiteId);
    this.deps.evals.deleteCase(caseId);
  }

  // ------------------------------------------------------------------- runs

  /**
   * Starts trying a suite against a candidate (spec B4): the baseline is
   * today's setup for every role the suite's cases use, frozen now, and the
   * candidate is that baseline with the person's change applied. Every
   * refusal is checked before the run or any trial is written.
   */
  async startRun(
    suiteId: EvalSuiteId,
    caller: Caller,
    req: { readonly candidate: EvalCandidate; readonly repeats?: number; readonly spendCapUsd?: number },
  ): Promise<EvalRun> {
    const cap = req.spendCapUsd;
    if (cap === undefined || !Number.isFinite(cap) || cap <= 0) throw new EvalError('cap_required', 'Set a spend cap for this run.');
    const repeats = req.repeats ?? DEFAULT_REPEATS;
    if (!Number.isInteger(repeats) || repeats < 1 || repeats > MAX_REPEATS) {
      throw new EvalError('repeats_range', `Repeats must be between 1 and ${MAX_REPEATS}.`);
    }
    const suite = this.#requireSuite(suiteId);
    const workspaceId = suite.workspaceId;
    const cases = this.deps.evals.listCases(suiteId);
    if (cases.length === 0) throw new EvalError('suite_empty', 'This suite has no cases yet.');
    // One run per project at a time: trials share its runtimes, and two runs' spend would blur.
    if (this.deps.evals.activeRuns().some((r) => r.workspaceId === workspaceId)) {
      throw new EvalError('already_running', 'Another eval run is still going in this project.');
    }

    const baseline: Record<string, EvalRoleVariant> = {};
    for (const kase of cases) {
      const roleId = kase.snapshot.step.roleId;
      const role = this.deps.roles.get(roleId, workspaceId);
      if (role === undefined) throw new EvalError('role_missing', `The role ${roleId} used by case ${kase.name} no longer exists.`);
      for (const input of kase.snapshot.inputs) {
        if (!(await this.deps.blobs.has(input.sha256))) {
          throw new EvalError('input_missing', `An input of case ${kase.name} is missing from the eval store.`);
        }
      }
      if (baseline[roleId] !== undefined) continue;
      // No step refs: only the role's own pins belong to the role; a step's pins travel with its case.
      const pins = this.deps.skills.pinsFor(workspaceId, role, { key: '' }).pins.filter((p) => p.from !== 'step');
      baseline[roleId] = { role: structuredClone(role), pins };
    }
    const candidate = await this.#candidateRoles(workspaceId, baseline, req.candidate);

    const now = this.deps.clock.now();
    const run = this.deps.evals.insertRun({
      id: ids.evalRun(), suiteId, workspaceId, status: 'queued', reason: null, repeats, spendCapUsd: cap,
      candidate: req.candidate,
      variants: { baseline: { label: 'baseline', roles: baseline }, candidate: { label: 'candidate', roles: candidate } },
      scorecard: null, startedBy: caller.personId, createdAt: now, startedAt: null, finishedAt: null,
    });
    // Case by case, repeat by repeat, baseline then candidate: a run stopped early still holds pairs.
    const trials: EvalTrial[] = [];
    for (const kase of cases) {
      for (let repeat = 1; repeat <= repeats; repeat += 1) {
        for (const variant of ['baseline', 'candidate'] as const) {
          trials.push({
            id: ids.evalTrial(), runId: run.id, caseId: kase.id, variant, repeat, seq: trials.length + 1,
            missionId: null, status: 'queued', reason: null, score: null, startedAt: null, finishedAt: null,
          });
        }
      }
    }
    this.deps.evals.insertTrials(trials);
    this.deps.runner().wake();
    return run;
  }

  getRun(runId: EvalRunId): EvalRunDetail {
    const run = this.deps.evals.getRun(runId);
    if (run === undefined) throw TandemiseError.notFound('Eval run', runId);
    const trials = this.deps.evals.listTrials(runId);
    return { run, trials, ...evalSpend(this.deps.runs, trials) };
  }

  listRuns(suiteId: EvalSuiteId): readonly EvalRun[] {
    return this.deps.evals.listRuns(suiteId);
  }

  /**
   * Ends a run now. Trials not yet started are cancelled, the live one is
   * aborted (the runner ends it cancelled and cleans it up), and the
   * scorecard is written over the trials that did finish.
   */
  cancelRun(runId: EvalRunId, caller: Caller): void {
    const run = this.deps.evals.getRun(runId);
    if (run === undefined) throw TandemiseError.notFound('Eval run', runId);
    if (run.status !== 'queued' && run.status !== 'running') throw new EvalError('not_running', 'This run has already finished.');
    const now = this.deps.clock.now();
    for (const trial of this.deps.evals.listTrials(runId)) {
      if (trial.status === 'queued') this.deps.evals.updateTrial(trial.id, { status: 'cancelled', finishedAt: now });
    }
    this.deps.runner().cancel(runId);
    this.deps.evals.updateRun(runId, { status: 'cancelled', scorecard: scorecardFor(this.deps.evals, run), finishedAt: now });
  }

  /** The baseline with the person's change applied; roles the suite does not use are ignored. */
  async #candidateRoles(
    workspaceId: WorkspaceId,
    baseline: Readonly<Record<string, EvalRoleVariant>>,
    candidate: EvalCandidate,
  ): Promise<Record<string, EvalRoleVariant>> {
    const roles: Record<string, EvalRoleVariant> = structuredClone(baseline);
    if (candidate.kind === 'models') {
      for (const [roleId, model] of Object.entries(candidate.roles)) {
        const current = roles[roleId];
        if (current === undefined) continue;
        roles[roleId] = { ...current, role: { ...current.role, models: { ...(current.role.models ?? NO_ROLE_MODELS), model } } };
      }
      return roles;
    }
    if (candidate.kind === 'skills') {
      const catalog = this.deps.skills.catalog(workspaceId);
      for (const [roleId, refs] of Object.entries(candidate.roles)) {
        const current = roles[roleId];
        if (current === undefined) continue;
        const pins = refs.map((ref) => resolveRef(ref, catalog.versionsOf(ref.name)));
        roles[roleId] = { role: { ...current.role, skills: pins.map((p) => ({ name: p.name, version: p.version })) }, pins };
      }
      return roles;
    }

    let files: Readonly<Record<string, string>>;
    try {
      files = (await this.deps.readSetupFolder(candidate.folder)).files;
    } catch (e) {
      throw new EvalError('setup_invalid', errorMessage(e));
    }
    const { snapshot, problems } = readSetup(files);
    const problem = problems[0];
    if (problem !== undefined) throw new EvalError('setup_invalid', problem.message);
    for (const setup of snapshot.roles ?? []) {
      const current = roles[setup.id];
      if (current === undefined) continue;
      const pins: SkillPin[] = setup.skills.map((p) => ({ name: p.name, version: p.version, hash: p.hash, from: 'role' }));
      const missing = (await this.deps.skills.missing(pins))[0];
      if (missing !== undefined) {
        throw new EvalError('skill_unknown', `This setup pins ${missing.name} v${missing.version}, which isn't in your skill library yet.`);
      }
      roles[setup.id] = {
        role: {
          ...current.role,
          instructions: setup.instructions,
          defaultCapabilities: setup.capabilities,
          outputContract: setup.outputContract,
          defaultIsolation: setup.isolation,
          models: { model: setup.model, escalate: setup.escalate, economyModel: setup.economyModel },
          skills: setup.skills.map((p) => ({ name: p.name, version: p.version })),
        },
        pins,
      };
    }
    return roles;
  }

  runScoreSummary(workspaceId: WorkspaceId, windowDays: 7 | 30 | 90): readonly RoleModelSummary[] {
    const since = new Date(this.deps.clock.epochMs() - windowDays * 24 * 60 * 60 * 1000).toISOString();
    // Trials are left out by the repository's own default (spec B1): a
    // candidate's trial runs must never leak into "From your runs".
    return summarizeRunScores(this.deps.runScores.list(workspaceId, since));
  }

  // ------------------------------------------------------------------ suites

  #requireSuite(id: EvalSuiteId): EvalSuite {
    const suite = this.deps.evals.getSuite(id);
    if (suite === undefined) throw TandemiseError.notFound('Eval suite', id);
    return suite;
  }

  #refuseIfActive(suiteId: EvalSuiteId): void {
    if (this.deps.evals.activeRuns().some((r) => r.suiteId === suiteId)) {
      throw new EvalError('already_running', ALREADY_RUNNING_MESSAGE);
    }
  }

  // -------------------------------------------------------------- saveCase

  /** The passing round's first run: lowest attempt among runs that actually ran. */
  #firstRun(task: MissionTask): Run {
    const round = task.round ?? 1;
    const first = this.deps.runs.listByTask(task.id)
      .filter((r) => (r.round ?? 1) === round && r.status !== 'STARTING')
      .sort((a, b) => a.attempt - b.attempt)[0];
    if (first === undefined) throw new EvalError('no_run', 'This step has no run to replay.');
    return first;
  }

  /**
   * The commit a candidate replays this case from: the newest live upstream
   * `ChangeSet`'s recorded commit when one exists, else the repository ref
   * the mission itself started from.
   */
  async #resolveBaseSha(task: MissionTask, mission: Mission, repository: Repository): Promise<string> {
    const upstream = this.#upstreamChangeCommit(task, mission, repository);
    if (upstream !== null) {
      // A recorded ref that is not a real commit hash is no more usable than none at all.
      if (!/^[0-9a-f]{40}$/.test(upstream)) throw new EvalError('base_unresolved', BASE_UNRESOLVED_MESSAGE);
      return upstream;
    }

    const exec = this.deps.exec;
    if (exec === undefined || exec === null) throw new EvalError('base_unresolved', BASE_UNRESOLVED_MESSAGE);
    const ref = mission.baseBranch ?? repository.defaultBranch;
    try {
      const result = await exec.run({
        command: 'git', args: ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`],
        cwd: repository.path, timeoutMs: GIT_TIMEOUT_MS, env: { GIT_TERMINAL_PROMPT: '0' },
      });
      const sha = result.stdout.trim();
      if (result.exitCode === 0 && /^[0-9a-f]{40}$/.test(sha)) return sha;
    } catch {
      // Falls through to the refusal below - a runner that could not even start git is no different.
    }
    throw new EvalError('base_unresolved', BASE_UNRESOLVED_MESSAGE);
  }

  /** The commit of the newest live `ChangeSet` among `task`'s transitive dependencies in its own repository, if any. */
  #upstreamChangeCommit(task: MissionTask, mission: Mission, repository: Repository): string | null {
    const all = this.deps.tasks.listByMission(mission.id);
    const upstream = upstreamTaskIds(task, all);
    if (upstream.size === 0) return null;
    const byId = new Map<string, MissionTask>(all.map((t) => [t.id, t]));
    const upstreamIds = new Set(
      [...upstream].filter((id) => (byId.get(id)?.repositoryId ?? mission.repositoryId) === repository.id),
    );
    if (upstreamIds.size === 0) return null;

    const changeSets = liveArtifacts(this.deps.artifacts, mission.id, 'ChangeSet')
      .filter((a) => a.taskId !== null && upstreamIds.has(a.taskId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    for (const artifact of changeSets) {
      const commit = artifact.sourceRefs.find((r) => r.kind === 'git.commit')?.value;
      if (commit !== undefined) return commit;
    }
    return null;
  }

  /** Every run input's manifest and bytes, read but not yet stored anywhere; a source that can no longer be read refuses the whole save before anything is written. */
  async #readInputs(runId: Run['id']): Promise<readonly { readonly manifest: ArtifactManifest; readonly bytes: Uint8Array }[]> {
    const pending: { manifest: ArtifactManifest; bytes: Uint8Array }[] = [];
    for (const id of this.deps.runInputs.listByRun(runId)) {
      const manifest = this.deps.artifacts.get(id);
      try {
        if (manifest === undefined) throw new Error('missing artifact manifest');
        const bytes = await this.deps.artifactStore.readBinary(id);
        pending.push({ manifest, bytes });
      } catch {
        throw new EvalError('input_missing', `An input of this step can no longer be read: ${manifest?.title ?? id}.`);
      }
    }
    return pending;
  }

  /** Writes every already-read input into the eval blob store. Called only once every refusal above has had its chance. */
  async #storeInputs(pending: readonly { readonly manifest: ArtifactManifest; readonly bytes: Uint8Array }[]): Promise<readonly EvalCaseInput[]> {
    const inputs: EvalCaseInput[] = [];
    for (const { manifest, bytes } of pending) {
      // The blob store is the source of truth for the hash it stored the bytes under.
      const sha256 = await this.deps.blobs.put(bytes);
      inputs.push({ type: manifest.type, sha256, mediaType: manifest.mediaType, title: manifest.title, handoff: manifest.handoff ?? null });
    }
    return inputs;
  }

  #buildStep(task: MissionTask, gate: GateExpression): EvalCaseSnapshot['step'] {
    const modelPolicy = task.modelPolicy;
    const { model: _model, pinned: _pinned, ...restModelPolicy } = modelPolicy ?? {};
    return {
      key: task.key,
      title: task.title,
      roleId: task.roleId,
      objective: task.objective,
      expectedOutputs: task.expectedOutputs,
      inputArtifacts: task.inputArtifacts,
      requiredCapabilities: task.requiredCapabilities,
      completionGate: gate,
      retryPolicy: task.retryPolicy,
      maxWallTimeMs: task.executionPolicy.maxWallTimeMs,
      modelPolicy: modelPolicy == null ? null : restModelPolicy,
      stepModel: modelPolicy?.model ?? null,
      stepSkills: (task.skills ?? []).filter((p) => p.from === 'step'),
    };
  }

  /** Mission context frozen the same way `#compilePrompt` reads it today: accepted decisions, answered questions, current knowledge. */
  #missionContext(mission: Mission): EvalCaseSnapshot['mission'] {
    const knowledge = this.deps.workspaces.get(mission.workspaceId)?.knowledge ?? EMPTY_KNOWLEDGE;
    const decisions = this.deps.decisions.listByMission(mission.id).filter((d) => d.status === 'accepted');
    const answers = this.deps.questions.listByMission(mission.id)
      .flatMap((q) => (q.status === 'answered' && q.answer !== null ? [{ key: q.key, text: q.text, answer: q.answer }] : []));
    return { title: mission.title, goal: mission.goal, constraints: mission.constraints, knowledge, decisions, answers };
  }

  #criteriaList(mission: Mission): readonly EvalCaseCriterion[] {
    return this.deps.criteria.listActive(mission.id).map((c) => ({ key: c.key, statement: c.statement, source: c.source, covers: c.covers }));
  }

  /** The step's own live outputs, by type and hash - what a candidate's run is judged against. */
  #referenceOutputs(mission: Mission, task: MissionTask): EvalCaseProvenance['referenceOutputs'] {
    return task.expectedOutputs
      .flatMap((type) => liveArtifacts(this.deps.artifacts, mission.id, type).filter((a) => a.taskId === task.id))
      .map((a) => ({ type: a.type, sha256: a.sha256 }));
  }
}

/** A skills candidate's ref made concrete against the library: `latest` is the highest version. */
function resolveRef(ref: SkillRef, versions: readonly { readonly version: number; readonly hash: string }[] | undefined): SkillPin {
  const found = ref.version === 'latest'
    ? [...(versions ?? [])].sort((a, b) => b.version - a.version)[0]
    : versions?.find((v) => v.version === ref.version);
  if (found === undefined) {
    throw new EvalError('skill_unknown', ref.version === 'latest'
      ? `No skill ${ref.name} in your library.`
      : `No skill ${ref.name} v${ref.version} in your library.`);
  }
  return { name: ref.name, version: found.version, hash: found.hash, from: 'role' };
}
