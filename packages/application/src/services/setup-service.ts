import { join, sep } from 'node:path';
import type {
  IssueRepositoryPort, RepoRepositoryPort, Repository, RoleTemplate, RoutineRepositoryPort, RuntimeProfileRepositoryPort, SkillFile,
  UnitOfWork, WorkspaceKnowledge,
} from '@tandemise/domain';
import type {
  ApplySetupRequest, SetupApplyView, SetupExportRecord, SetupExportView, SetupPreviewView, SetupStatusView, UpdateWorkspaceRequest,
} from '@tandemise/api-contract';
import type { Clock, Logger, RoutineId, WorkspaceId } from '@tandemise/shared';
import { TandemiseError, asId } from '@tandemise/shared';
import type { SettingsStorePort, SetupFolderPort, WorkflowSourcePort } from '../ports.js';
import type { RoleService, WorkspaceService } from '../services.js';
import type { EventRecorder } from '../support/event-recorder.js';
import type { Caller } from '../support/identity.js';
import type { RoutineService } from './routine-service.js';
import type { SkillService } from './skill-service.js';
import type { IssueService } from './issue-service.js';
import {
  IMPORTED_ROUTINE_NOTE, SETUP_DIR, SETUP_ROLES_DIR, SETUP_WORKFLOWS_DIR, diffSetup, readSetup, renderSetup, setupCounts, setupHash,
  skillAvailability, skillItemId,
  type IssueSetup, type ProjectSetup, type RoleSetup, type RoutineSetup, type SetupChoice, type SetupDiffContext, type SetupItem,
  type SetupSnapshot, type SkillLockEntry, type SkillPinSetup, type WorkflowSetup,
} from '../setup/codec.js';

export interface SetupDeps {
  readonly workspaces: Pick<WorkspaceService, 'view' | 'update'>;
  readonly repositories: Pick<RepoRepositoryPort, 'listByWorkspace' | 'get'>;
  readonly roles: Pick<RoleService, 'list' | 'upsert' | 'remove'>;
  readonly runtimeProfiles: Pick<RuntimeProfileRepositoryPort, 'list'>;
  readonly routines: Pick<RoutineRepositoryPort, 'list' | 'update'>;
  readonly routineService: Pick<RoutineService, 'create' | 'update' | 'remove' | 'problemWith'>;
  /** The skills library (P13): pins by content hash, and files another project already brought to this machine. */
  readonly skills: Pick<SkillService, 'library' | 'versionFor' | 'adoptStored' | 'content'>;
  /** GitHub issue settings (P14), per repository. */
  readonly issueSettings: Pick<IssueRepositoryPort, 'listSettings'>;
  readonly issues: Pick<IssueService, 'importSettings'>;
  readonly workflows: WorkflowSourcePort;
  readonly folder: SetupFolderPort;
  readonly settings: SettingsStorePort;
  readonly unitOfWork: UnitOfWork;
  readonly recorder: EventRecorder;
  readonly clock: Clock;
  readonly log: Logger;
}

/** Settings key holding each project's last export from this machine. */
const EXPORTS_KEY = 'setupExports';

const KNOWLEDGE_KEYS: readonly (keyof WorkspaceKnowledge)[] = [
  'architecturePrinciples', 'codingStandards', 'designSystem', 'glossary', 'productVision',
];

/**
 * Setup as code (P15): the project's setup written to, and read back from, a
 * repository's `.tandemise/` folder.
 *
 * The codec decides what the files say and what differs; this service only
 * gathers rows into a snapshot and applies the person's choices. Applying is
 * one transaction through the same services the screens use - a role saved
 * from a file is saved exactly as the role editor saves it - and workflow
 * files, which are not rows, are staged beside their destination and renamed
 * into place only once that transaction has committed.
 *
 * An import never starts work: every routine it adds or changes is saved off,
 * and so are a repository's GitHub issue settings. A skill is only ever
 * pinned when its files are on this machine: one whose files are missing is
 * shown as "Needs import", never applied, because its runs would refuse.
 */
export class SetupService {
  constructor(private readonly deps: SetupDeps) {}

  status(workspaceId: WorkspaceId): SetupStatusView {
    this.deps.workspaces.view(workspaceId);
    return { lastExport: this.#exports()[workspaceId] ?? null };
  }

  async export(workspaceId: WorkspaceId, repositoryId: string): Promise<SetupExportView> {
    const repository = this.#repository(workspaceId, repositoryId);
    const { snapshot, workflowSources } = await this.#snapshot(workspaceId);
    const rendered = renderSetup(snapshot);
    const root = join(repository.path, SETUP_DIR);

    // A workflow already in this repository is already code: rewriting it
    // would only lose its comments. Every other file is Tandemise's to write.
    const write: Record<string, string> = {};
    const files: SetupExportView['files'][number][] = [];
    for (const file of rendered.files) {
      const destination = join(root, file.path);
      const source = file.path.startsWith(`${SETUP_WORKFLOWS_DIR}/`) ? workflowSources.get(file.path.slice(SETUP_WORKFLOWS_DIR.length + 1)) : undefined;
      const kept = source !== undefined && source === destination;
      if (!kept) write[destination] = file.content;
      files.push({ path: `${SETUP_DIR}/${file.path}`, bytes: Buffer.byteLength(file.content, 'utf8'), status: kept ? 'kept' : 'written' });
    }
    // A role deleted since the last export would come back on the next import.
    const existing = await this.deps.folder.read(root);
    const removed = Object.keys(existing?.files ?? {})
      .filter((path) => path.startsWith(`${SETUP_ROLES_DIR}/`) && path.endsWith('.md') && !rendered.files.some((f) => f.path === path))
      .sort();

    const staged = await this.deps.folder.stage({ write, remove: removed.map((path) => join(root, path)) });
    await staged.commit();
    const warnings = await this.deps.folder.gitWarnings(repository.path, files.map((f) => f.path));

    const record: SetupExportRecord = { hash: rendered.hash, repositoryName: repository.name, files: files.length, at: this.deps.clock.now() };
    this.deps.settings.write({ [EXPORTS_KEY]: { ...this.#exports(), [workspaceId]: record } });
    this.deps.log.info('setup.exported', { workspaceId, repository: repository.name, hash: rendered.hash, files: files.length });
    this.deps.recorder.invalidate('workspaces');
    return {
      repositoryName: repository.name,
      folder: root,
      files,
      removed: removed.map((path) => `${SETUP_DIR}/${path}`),
      hash: rendered.hash,
      secrets: rendered.secrets.map((s) => ({ file: `${SETUP_DIR}/${s.file}`, name: s.name })),
      warnings,
    };
  }

  async preview(workspaceId: WorkspaceId, path: string): Promise<SetupPreviewView> {
    const { folder, hash, items, ignored } = await this.#previewItems(workspaceId, path);
    return { folder, hash, items, counts: setupCounts(items), ignored };
  }

  async apply(caller: Caller, workspaceId: WorkspaceId, request: ApplySetupRequest): Promise<SetupApplyView> {
    const { hash, items } = await this.#previewItems(workspaceId, request.path);
    if (hash !== request.hash) {
      throw new TandemiseError('CONFLICT', 'The files changed since the preview. Preview again.', { details: { expected: request.hash, found: hash } });
    }
    const choices = request.choices ?? {};
    const taken: SetupItem[] = [];
    for (const item of items) {
      const choice: SetupChoice | null = item.action === 'same' ? null : (choices[item.id] ?? item.choice);
      if (choice !== 'theirs') continue;
      if (item.problem !== null) throw TandemiseError.validation(`${item.name} cannot be taken: ${item.problem}`, { item: item.id });
      taken.push(item);
    }
    const kept = items.filter((i) => i.action !== 'same').length - taken.length;
    if (taken.length === 0) return { applied: 0, kept, lines: [] };

    const read = await this.#readFolder(request.path);
    const theirs = readSetup(read.files).snapshot;
    const { workflowSources } = await this.#snapshot(workspaceId);
    const stored = await this.#storedFiles(workspaceId, taken, theirs);

    // Files first, staged: nothing is visible until the rows have committed.
    const write: Record<string, string> = {};
    const remove: string[] = [];
    const workflowItems = taken.filter((i) => i.kind === 'workflow');
    if (workflowItems.length > 0) {
      const home = this.#defaultRepository(workspaceId);
      for (const item of workflowItems) {
        const file = item.id.slice('workflow:'.length);
        if (item.action === 'remove') {
          const source = workflowSources.get(file);
          if (source !== undefined) remove.push(source);
          continue;
        }
        const incoming = theirs.workflows?.find((w) => w.file === file);
        if (incoming === undefined) continue;
        // A changed file is replaced where it lives; a new one goes to the default repository.
        write[workflowSources.get(file) ?? join(home.path, SETUP_DIR, SETUP_WORKFLOWS_DIR, file)] = incoming.content;
      }
    }
    const staged = await this.deps.folder.stage({ write, remove });

    try {
      this.deps.unitOfWork.transaction(() => this.#applyRows(caller, workspaceId, taken, theirs, stored));
    } catch (e) {
      await staged.discard();
      throw e;
    }
    await staged.commit();
    this.deps.recorder.invalidate('workspaces');
    this.deps.recorder.invalidate('missions');
    this.deps.log.info('setup.applied', { workspaceId, applied: taken.length, kept, hash });
    return {
      applied: taken.length,
      kept,
      lines: taken.map((item) => `${verb(item.action)} ${item.name}${item.detail !== '' && item.action === 'change' ? `: ${item.detail}` : ''}`),
    };
  }

  // ------------------------------------------------------------------ rows

  #applyRows(caller: Caller, workspaceId: WorkspaceId, taken: readonly SetupItem[], theirs: SetupSnapshot, stored: ReadonlyMap<string, readonly SkillFile[]>): void {
    const workspace = this.deps.workspaces.view(workspaceId).workspace;
    const patch: { -readonly [K in keyof UpdateWorkspaceRequest]: UpdateWorkspaceRequest[K] } = {};
    const project = theirs.project;
    // Skills first, so a role taken in the same apply can pin them.
    const ordered = [...taken].sort((a, b) => Number(b.kind === 'skill') - Number(a.kind === 'skill'));
    for (const item of ordered) {
      switch (item.kind) {
        case 'settings':
          if (project === null) break;
          patch.name = project.name;
          patch.autonomy = project.autonomy as UpdateWorkspaceRequest['autonomy'];
          patch.concurrency = { ...workspace.concurrency, perRuntime: { ...workspace.concurrency.perRuntime }, maxTotalWorkers: project.maxTotalWorkers };
          patch.knowledge = Object.fromEntries(KNOWLEDGE_KEYS.map((k) => [k, project.knowledge[k] ?? null]));
          break;
        case 'wip':
          patch.maxActiveMissions = project?.wipLimit ?? null;
          break;
        case 'monthly_limits':
          patch.monthlyLimits = [...(project?.monthlyLimits ?? [])];
          break;
        case 'mission_limits':
          patch.defaultMissionLimits = [...(project?.missionLimits ?? [])];
          break;
        case 'role':
          this.#applyRole(workspaceId, item, theirs, stored);
          break;
        case 'skill': {
          const entry = theirs.skills?.find((s) => skillItemId(s) === item.id);
          if (entry !== undefined) this.#skillVersion(workspaceId, entry, theirs, stored);
          break;
        }
        case 'issues':
          this.#applyIssues(caller, workspaceId, item, theirs);
          break;
        case 'routine':
          this.#applyRoutine(caller, workspaceId, item, theirs);
          break;
        case 'workflow':
          break;
      }
    }
    if (Object.keys(patch).length > 0) this.deps.workspaces.update(workspaceId, patch);
  }

  /** The library's version with a pin's files, adding them from this machine's store when needed. */
  #skillVersion(workspaceId: WorkspaceId, pin: SkillPinSetup, theirs: SetupSnapshot, stored: ReadonlyMap<string, readonly SkillFile[]>): number {
    const have = this.deps.skills.versionFor(workspaceId, pin.name, pin.hash);
    if (have !== undefined) return have;
    const files = stored.get(pin.hash);
    const entry = theirs.skills?.find((s) => s.name === pin.name && s.hash === pin.hash);
    if (files === undefined || entry === undefined) {
      // The preview refuses this; a folder or store that changed in between lands here.
      throw TandemiseError.validation(`Needs import: ${pin.name} v${pin.version}. Its files are not on this machine. Import it, then preview again.`, { skill: pin.name });
    }
    return this.deps.skills.adoptStored(workspaceId, entry, files);
  }

  /** Files in the store for every taken pin the library lacks, read (and verified) before the transaction. */
  async #storedFiles(workspaceId: WorkspaceId, taken: readonly SetupItem[], theirs: SetupSnapshot): Promise<Map<string, readonly SkillFile[]>> {
    const pins: SkillPinSetup[] = [];
    for (const item of taken) {
      if (item.kind === 'skill') pins.push(...(theirs.skills ?? []).filter((s) => skillItemId(s) === item.id));
      if (item.kind === 'role' && item.action !== 'remove') pins.push(...(theirs.roles?.find((r) => `role:${r.id}` === item.id)?.skills ?? []));
    }
    const out = new Map<string, readonly SkillFile[]>();
    for (const pin of pins) {
      if (out.has(pin.hash) || this.deps.skills.versionFor(workspaceId, pin.name, pin.hash) !== undefined) continue;
      const files = await this.deps.skills.content(pin.hash);
      if (files !== null) out.set(pin.hash, files);
    }
    return out;
  }

  #applyIssues(caller: Caller, workspaceId: WorkspaceId, item: SetupItem, theirs: SetupSnapshot): void {
    const name = item.id.slice('issues:'.length);
    const settings = theirs.issues?.find((i) => i.repository === name);
    const repository = this.deps.repositories.listByWorkspace(workspaceId).find((r) => r.name === name);
    if (settings === undefined || repository === undefined) return;
    this.deps.issues.importSettings(caller, repository.id, {
      githubRepo: settings.githubRepo,
      label: settings.label,
      pollMinutes: settings.pollMinutes,
      closeOnComplete: settings.closeOnComplete,
      postComments: settings.postComments,
      workflowPreset: settings.workflow,
    });
  }

  #applyRole(workspaceId: WorkspaceId, item: SetupItem, theirs: SetupSnapshot, stored: ReadonlyMap<string, readonly SkillFile[]>): void {
    const id = item.id.slice('role:'.length);
    if (item.action === 'remove') {
      // A built-in is restored as shipped; a role someone added is deleted.
      this.deps.roles.remove(id, workspaceId);
      return;
    }
    const role = theirs.roles?.find((r) => r.id === id);
    if (role === undefined) return;
    const models = role.model === null && role.escalate.length === 0 && role.economyModel === null
      ? null
      : { model: role.model, escalate: [...role.escalate], economyModel: role.economyModel };
    this.deps.roles.upsert({
      workspaceId,
      id: role.id,
      name: role.name,
      summary: role.summary.trim(),
      instructions: role.instructions.trim(),
      defaultCapabilities: [...role.capabilities],
      producesArtifacts: [...role.produces] as RoleTemplate['producesArtifacts'][number][],
      consumesArtifacts: [...role.consumes] as RoleTemplate['consumesArtifacts'][number][],
      defaultIsolation: role.isolation,
      outputContract: role.outputContract.trim(),
      models,
      // Pinned by the files' hash, at whatever version number this library has them.
      skills: role.skills.map((pin) => ({ name: pin.name, version: this.#skillVersion(workspaceId, pin, theirs, stored) })),
    });
  }

  #applyRoutine(caller: Caller, workspaceId: WorkspaceId, item: SetupItem, theirs: SetupSnapshot): void {
    const name = item.id.slice('routine:'.length);
    const existing = this.deps.routines.list(workspaceId).find((r) => r.name === name);
    if (item.action === 'remove') {
      if (existing !== undefined) this.deps.routineService.remove(existing.id);
      return;
    }
    const routine = theirs.routines?.find((r) => r.name === name);
    if (routine === undefined) return;
    const fields = {
      name: routine.name,
      kind: routine.kind,
      goal: routine.goal,
      successCriteria: [...routine.successCriteria],
      priority: routine.priority,
      limits: routine.limits === null ? null : [...routine.limits],
      workflowPreset: routine.workflow,
      schedule: routine.schedule,
      // Nothing starts running because of an import (spec §5, ruling 4).
      enabled: false,
    };
    const id: RoutineId = existing === undefined
      ? this.deps.routineService.create(caller, workspaceId, fields).routine.id
      : this.deps.routineService.update(existing.id, fields).routine.id;
    this.deps.routines.update(id, { lastDetail: IMPORTED_ROUTINE_NOTE, lastOutcome: null });
  }

  // -------------------------------------------------------------- gathering

  async #previewItems(workspaceId: WorkspaceId, path: string): Promise<{ folder: string; hash: string; items: readonly SetupItem[]; ignored: readonly string[] }> {
    const read = await this.#readFolder(path);
    const parsed = readSetup(read.files);
    const { snapshot } = await this.#snapshot(workspaceId);
    const items = diffSetup(snapshot, parsed, await this.#diffContext(workspaceId, parsed.snapshot)).map((item) => this.#withRoutineProblem(item, parsed.snapshot));
    const hash = setupHash(Object.entries(read.files).map(([p, content]) => ({ path: p, content })));
    return { folder: read.root, hash, items, ignored: read.ignored };
  }

  async #diffContext(workspaceId: WorkspaceId, theirs: SetupSnapshot): Promise<SetupDiffContext> {
    const library = this.deps.skills.library(workspaceId);
    const context = { library, stored: new Set<string>(), repositories: this.deps.repositories.listByWorkspace(workspaceId).map((r) => r.name) };
    const wanted = [...(theirs.skills ?? []), ...(theirs.roles ?? []).flatMap((r) => r.skills)];
    for (const pin of wanted) {
      if (context.stored.has(pin.hash) || skillAvailability(pin, context) === 'library') continue;
      if ((await this.deps.skills.content(pin.hash)) !== null) context.stored.add(pin.hash);
    }
    return context;
  }

  /** A routine the routine screen would refuse is refused here too, with its words. */
  #withRoutineProblem(item: SetupItem, theirs: SetupSnapshot): SetupItem {
    if (item.kind !== 'routine' || item.action === 'remove' || item.action === 'same' || item.problem !== null) return item;
    const routine = theirs.routines?.find((r) => `routine:${r.name}` === item.id);
    if (routine === undefined) return item;
    const problem = this.deps.routineService.problemWith({
      name: routine.name, kind: routine.kind, goal: routine.goal, successCriteria: routine.successCriteria, schedule: routine.schedule,
    });
    return problem === null ? item : { ...item, problem, choice: null };
  }

  async #readFolder(path: string): Promise<{ root: string; files: Readonly<Record<string, string>>; ignored: readonly string[] }> {
    const read = await this.deps.folder.read(path);
    if (read === null) {
      throw TandemiseError.validation(`There is no ${SETUP_DIR} folder in ${path}. Choose the repository folder that holds it, or the ${SETUP_DIR} folder itself.`);
    }
    return read;
  }

  async #snapshot(workspaceId: WorkspaceId): Promise<{ snapshot: SetupSnapshot; workflowSources: Map<string, string> }> {
    const view = this.deps.workspaces.view(workspaceId);
    const { workspace } = view;
    const profiles = new Map(this.deps.runtimeProfiles.list(null).map((p) => [p.id, p.name]));
    const knowledge: Partial<Record<keyof WorkspaceKnowledge, string>> = {};
    for (const key of KNOWLEDGE_KEYS) {
      const value = workspace.knowledge[key];
      if (value !== null && value.trim() !== '') knowledge[key] = value;
    }
    const project: ProjectSetup = {
      name: workspace.name,
      autonomy: workspace.autonomy,
      maxTotalWorkers: workspace.concurrency.maxTotalWorkers,
      knowledge,
      wipLimit: workspace.maxActiveMissions,
      monthlyLimits: workspace.monthlyLimits,
      missionLimits: workspace.defaultMissionLimits,
    };
    const library = this.deps.skills.library(workspaceId);
    const pinOf = (name: string, version: number): SkillLockEntry | undefined => library.find((v) => v.name === name && v.version === version);
    const roles: RoleSetup[] = this.deps.roles.list(workspaceId).map((role) => ({
      id: role.id,
      name: role.name,
      summary: role.summary,
      instructions: role.instructions,
      capabilities: role.defaultCapabilities,
      produces: role.producesArtifacts,
      consumes: role.consumesArtifacts,
      isolation: role.defaultIsolation,
      outputContract: role.outputContract,
      model: role.models?.model ?? null,
      escalate: role.models?.escalate ?? [],
      economyModel: role.models?.economyModel ?? null,
      // Names, never ids: an id means nothing on another machine.
      runtime: (workspace.routing[role.id] ?? []).map((id) => profiles.get(asId<'RuntimeProfileId'>(id)) ?? id),
      // A pin to a version the library no longer has cannot be written by hash; it is left out.
      skills: (role.skills ?? []).flatMap((pin) => {
        const found = pinOf(pin.name, pin.version);
        return found === undefined ? [] : [{ name: pin.name, version: pin.version, hash: found.hash }];
      }),
    }));
    // skills.lock: each skill's newest version, plus every older version a role pins.
    const newest = new Map<string, SkillLockEntry>();
    for (const v of library) if ((newest.get(v.name)?.version ?? 0) < v.version) newest.set(v.name, v);
    const locked = new Map<string, SkillLockEntry>();
    for (const v of [...newest.values(), ...roles.flatMap((r) => r.skills).flatMap((p) => pinOf(p.name, p.version) ?? [])]) {
      locked.set(`${v.name}@${v.version}`, { name: v.name, version: v.version, hash: v.hash, source: v.source });
    }
    const issues: IssueSetup[] = this.deps.issueSettings.listSettings(workspaceId).flatMap((s) => {
      const repository = view.repositories.find((r) => r.id === s.repositoryId);
      return repository === undefined ? [] : [{
        repository: repository.name, githubRepo: s.githubRepo, enabled: s.enabled, label: s.label, pollMinutes: s.pollMinutes,
        closeOnComplete: s.closeOnComplete, postComments: s.postComments, workflow: s.workflowPreset,
      }];
    });
    const routines: RoutineSetup[] = this.deps.routines.list(workspaceId).map((r) => ({
      name: r.name,
      kind: r.kind,
      goal: r.goal,
      successCriteria: r.successCriteria,
      priority: r.priority,
      limits: r.limits,
      workflow: r.workflowPreset,
      schedule: r.schedule,
    }));
    const loaded = await this.deps.workflows.list(view.repositories.map((r) => r.path));
    const workflowSources = new Map<string, string>();
    const workflows: WorkflowSetup[] = [];
    for (const w of loaded) {
      if (w.text === undefined) continue;
      const file = w.path.split(sep).pop() ?? `${w.id}.yaml`;
      workflowSources.set(file, w.path);
      workflows.push({ file, content: w.text });
    }
    return { snapshot: { project, roles, workflows, routines, skills: [...locked.values()], issues }, workflowSources };
  }

  #repository(workspaceId: WorkspaceId, repositoryId: string): Repository {
    const repository = this.deps.repositories.get(asId<'RepositoryId'>(repositoryId));
    if (repository === undefined || repository.workspaceId !== workspaceId) throw TandemiseError.notFound('Repository', repositoryId);
    return repository;
  }

  #defaultRepository(workspaceId: WorkspaceId): Repository {
    const { workspace, repositories } = this.deps.workspaces.view(workspaceId);
    const repository = repositories.find((r) => r.id === workspace.defaultRepositoryId) ?? repositories[0];
    if (repository === undefined) {
      throw new TandemiseError('PRECONDITION_FAILED', 'Add a repository to this project first: imported workflow files are written into it.');
    }
    return repository;
  }

  #exports(): Record<string, SetupExportRecord> {
    const stored = this.deps.settings.read()[EXPORTS_KEY];
    return stored !== null && typeof stored === 'object' ? { ...(stored as Record<string, SetupExportRecord>) } : {};
  }
}

function verb(action: SetupItem['action']): string {
  return action === 'add' ? 'Added' : action === 'remove' ? 'Removed' : 'Changed';
}
