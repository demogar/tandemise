import type {
  ArtifactHandoff, ArtifactManifest, ArtifactRepositoryPort, ArtifactStorePort, ArtifactType,
  EvaluationRepositoryPort, ExternalRef, Mission, MissionTask, TaskRepositoryPort,
} from '@tandemise/domain';
import { ARTIFACT_OUT_DIR, RUNTIME_ACTOR, SYSTEM_ACTOR, isArtifactType } from '@tandemise/domain';
import type { ExecutionTarget } from '@tandemise/execution-core';
import type { ArtifactId, Clock, RunId } from '@tandemise/shared';
import { errorMessage, summarize } from '@tandemise/shared';
import type { ArtifactMeasurePort, ArtifactParserPort } from '../ports.js';
import { supersededBy } from '../support/lineage.js';
import type { EventRecorder, EventScope } from '../support/event-recorder.js';
import { checkRoundHandoff, owedUncited, type RoundContract } from '../support/feedback-rules.js';
import { evaluationFrom } from './evaluations.js';

export { ARTIFACT_OUT_DIR };

/**
 * Where one task writes its artifacts: its own folder under the out directory.
 *
 * Tasks that run in place share one checkout, so a single shared folder forced
 * them to take turns - the next task's preparation would empty the folder under
 * a running one. A folder per task lets read-only work in several missions run
 * in the same checkout at once.
 */
export function outDirFor(task: Pick<MissionTask, 'id'>): string {
  return `${ARTIFACT_OUT_DIR}/${task.id}`;
}

/**
 * Keeps agent output out of the diff, two ways.
 *
 * `.git/info/exclude` is the canonical place (APPLICATION_DESIGN.md) and is
 * written through git itself, because for a worktree that file lives in the
 * *main* repository's `.git/worktrees/<name>/` - outside the target's
 * filesystem scope, so `fs.write` cannot reach it.
 *
 * The self-ignoring `.gitignore` inside `.tandemise/` is the belt to that
 * braces: it works when the target is not a git repository at all, it survives
 * the worktree being re-provisioned, and it is visible to the user in Finder
 * rather than buried in a git internal.
 */
const IGNORE_FILE = '.tandemise/.gitignore';
const IGNORE_BODY = '# Written by Tandemise. Agent working files never belong in the diff.\n*\n';
const EXCLUDE_ENTRY = '.tandemise/';

export interface HarvestRequest {
  readonly mission: Mission;
  readonly task: MissionTask;
  readonly target: ExecutionTarget;
  readonly runId: RunId | null;
  readonly roleId: string;
  readonly scope: EventScope;
  /** Provenance recorded on every artifact collected from this run. */
  readonly sourceRefs: readonly ExternalRef[];
  /** The agent member that did the run; the runtime itself when omitted. */
  readonly authorId?: string;
  /**
   * Artifacts this run was asked to revise in place - a tighten pass's first
   * draft. A file left exactly as it was is that artifact again, not a new
   * version: storing it twice would supersede a draft with itself.
   */
  readonly revising?: readonly ArtifactManifest[];
  /**
   * Set when the pass carries feedback: a handoff that does not cite what it
   * owes is refused like any malformed artifact, so the retry names the ids.
   */
  readonly roundContract?: RoundContract;
}

/** A file refused only because it left notes of its round unanswered. */
export interface UnansweredNotes {
  readonly type: ArtifactType;
  /** Exactly as it appears in `HarvestResult.issues`. */
  readonly issue: string;
  readonly round: number;
  /** Notes it owed and did not cite; 0 when it only cited a note that is not on the task. */
  readonly notes: number;
}

/** An artifact whose main body is over its type's word budget. */
export interface OverBudgetArtifact {
  readonly artifactId: ArtifactId;
  readonly type: ArtifactType;
  readonly words: number;
  readonly budget: number;
}

export interface HarvestResult {
  readonly manifests: readonly ArtifactManifest[];
  /** Expected outputs the worker did not write, or wrote unreadably. */
  readonly missing: readonly ArtifactType[];
  /** One entry per rejected file, already formatted for a retry prompt. */
  readonly issues: readonly string[];
  /**
   * The rejected files whose only fault was the round's contract: written and
   * valid, but not citing every note they owe. Their issues are in `issues`
   * too; this says which ones they are, so the line a person reads can speak
   * of an unanswered note instead of the retry prompt's ids and paths.
   */
  readonly unanswered: readonly UnansweredNotes[];
  /** What this run's ChangeSet says it changed; absent when it wrote none. */
  readonly filesChanged?: number;
  /** Collected artifacts over their word budget. Never a reason to fail: it earns a tighten pass. */
  readonly overBudget: readonly OverBudgetArtifact[];
}

/**
 * Collects, validates and stores the artifacts a worker left behind
 * (MVP.md §15.1).
 *
 * The protocol is the filesystem because it has to work with a runtime that has
 * no tool calling and no MCP: a worker writes
 * `.tandemise/out/<ArtifactType>.md` and Tandemise reads it. That survives a
 * crashed run (the file is already on disk), it is inspectable by the user, and
 * it needs no negotiation.
 *
 * A file that fails its front-matter schema is **not** stored. Storing it would
 * let `artifact.ChangeSet.exists` pass on a document the next role cannot read,
 * which converts a hard, retryable failure into a soft one that surfaces three
 * tasks later. The issues are returned instead and fed into the retry prompt.
 */
export class ArtifactHarvester {
  constructor(
    private readonly store: ArtifactStorePort,
    private readonly artifacts: ArtifactRepositoryPort,
    private readonly evaluations: EvaluationRepositoryPort,
    private readonly parser: ArtifactParserPort,
    private readonly measure: ArtifactMeasurePort,
    private readonly recorder: EventRecorder,
    private readonly clock: Clock,
    /** Optional so older compositions keep mission-wide superseding. */
    private readonly tasks?: TaskRepositoryPort,
  ) {}

  /**
   * Prepares the hand-off directory before the worker starts.
   *
   * The directory is emptied first. An unisolated target is the user's own
   * checkout, which every `isolation: none` task in the mission shares - so a
   * file left by the previous task is still sitting there, and `harvest` would
   * collect it again and attribute this run's provenance to work it did not do.
   * Clearing also means a retry is judged on what this attempt produced rather
   * than on what the failed one left behind.
   */
  async prepare(target: ExecutionTarget, scope: EventScope, task: MissionTask): Promise<void> {
    const fs = target.filesystem();
    const own = outDirFor(task);
    // Only this task's folder is cleared, plus any loose files at the top level
    // (the pre-folder layout). Other folders belong to tasks that may be running
    // in this same checkout right now.
    if (await fs.exists(ARTIFACT_OUT_DIR)) {
      for (const entry of await fs.list(ARTIFACT_OUT_DIR)) {
        if (entry.kind === 'file') await fs.remove(`${ARTIFACT_OUT_DIR}/${entry.name}`);
      }
    }
    if (await fs.exists(own)) await fs.remove(own, { recursive: true });
    await fs.mkdir(own);
    await fs.write(IGNORE_FILE, IGNORE_BODY);
    await this.#excludeFromGit(target, scope);
  }

  /**
   * Appends `.tandemise/` to the target's `.git/info/exclude`, idempotently.
   *
   * Failure is logged as a note, never thrown: a target that is not a git
   * repository has no exclude file to write, and that is not a reason to fail
   * the run before the worker has done anything.
   */
  async #excludeFromGit(target: ExecutionTarget, scope: EventScope): Promise<void> {
    try {
      const gitDir = await target.exec({ command: 'git', args: ['rev-parse', '--absolute-git-dir'] });
      if (gitDir.exitCode !== 0) return;
      const dir = gitDir.stdout.trim();
      if (dir.length === 0) return;
      // One shell line so the read, the test and the append happen atomically
      // enough that a re-provisioned worktree never accumulates duplicates.
      await target.exec({
        command: '/bin/sh',
        args: [
          '-c',
          `mkdir -p "$1/info" && grep -qxF '${EXCLUDE_ENTRY}' "$1/info/exclude" 2>/dev/null `
          + `|| printf '%s\\n' '${EXCLUDE_ENTRY}' >> "$1/info/exclude"`,
          'sh',
          dir,
        ],
      });
    } catch (e) {
      this.recorder.note(scope, `Could not exclude ${EXCLUDE_ENTRY} from git: ${errorMessage(e)}`, 'warn');
    }
  }

  async harvest(request: HarvestRequest): Promise<HarvestResult> {
    const { task, target } = request;
    const fs = target.filesystem();
    const manifests: ArtifactManifest[] = [];
    const overBudget: OverBudgetArtifact[] = [];
    const issues: string[] = [];
    const unanswered: UnansweredNotes[] = [];
    const collected = new Set<ArtifactType>();
    let filesChanged: number | undefined;

    // This task's own folder, then loose top-level files for a worker that
    // wrote to the directory itself. Collected once per type, own folder first.
    const directories = [outDirFor(task), ARTIFACT_OUT_DIR];
    const entries: Array<{ dir: string; name: string }> = [];
    for (const dir of directories) {
      if (!(await fs.exists(dir))) continue;
      for (const entry of await fs.list(dir)) {
        if (entry.kind === 'file' && entry.name.endsWith('.md')) entries.push({ dir, name: entry.name });
      }
    }
    if (entries.length === 0) {
      return { manifests, missing: task.expectedOutputs, issues, unanswered, overBudget };
    }

    for (const { dir, name } of entries) {
      const typeName = name.slice(0, -'.md'.length);
      if (!isArtifactType(typeName)) {
        issues.push(`\`${dir}/${name}\` is not a recognised artifact type and was ignored.`);
        continue;
      }
      if (collected.has(typeName)) continue;

      const stored = await this.#collectOne(request, typeName, `${dir}/${name}`);
      if (stored.ok) {
        manifests.push(stored.manifest);
        collected.add(typeName);
        if (stored.manifest.overBudget === true) {
          overBudget.push({
            artifactId: stored.manifest.id,
            type: typeName,
            words: stored.manifest.wordCount ?? 0,
            budget: stored.budget,
          });
        }
        if (stored.filesChanged !== undefined) filesChanged = stored.filesChanged;
      } else {
        issues.push(stored.issue);
        if (stored.unanswered !== undefined) unanswered.push({ type: typeName, issue: stored.issue, ...stored.unanswered });
      }
    }

    return {
      manifests,
      missing: task.expectedOutputs.filter((type) => !collected.has(type)),
      issues,
      unanswered,
      ...(filesChanged === undefined ? {} : { filesChanged }),
      overBudget,
    };
  }

  async #collectOne(
    request: HarvestRequest,
    type: ArtifactType,
    path: string,
  ): Promise<
    | { ok: true; manifest: ArtifactManifest; budget: number; filesChanged?: number }
    | { ok: false; issue: string; unanswered?: { readonly round: number; readonly notes: number } }
  > {
    let source: string;
    try {
      source = await request.target.filesystem().read(path);
    } catch (e) {
      return { ok: false, issue: `\`${path}\` could not be read: ${errorMessage(e)}` };
    }

    const parsed = this.parser.parse(type, source);
    if (!parsed.ok) {
      const detail = parsed.error.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join('; ');
      return { ok: false, issue: `\`${path}\` does not satisfy the ${type} contract — ${detail}` };
    }

    // Before the unchanged check, so an untouched draft that owes a citation is refused too.
    if (request.roundContract !== undefined) {
      const handoff = readHandoff(parsed.value.frontMatter);
      const problems = checkRoundHandoff(type, handoff, request.roundContract);
      if (problems.length > 0) {
        return {
          ok: false,
          issue: `\`${path}\` does not answer the feedback for round ${request.roundContract.round}: ${problems.join('; ')}`,
          unanswered: { round: request.roundContract.round, notes: owedUncited(type, handoff, request.roundContract).length },
        };
      }
    }

    const measure = this.measure.measure(type, parsed.value.body);
    const changed = type === 'ChangeSet' ? parsed.value.frontMatter['filesChanged'] : undefined;
    const counted = typeof changed === 'number' ? { filesChanged: changed } : {};

    const unchanged = await this.#unchanged(request, type, source);
    if (unchanged !== null) return { ok: true, manifest: unchanged, budget: measure.budget, ...counted };

    const title = readTitle(parsed.value.frontMatter) ?? `${type} for ${request.task.title}`;
    const handoff = readHandoff(parsed.value.frontMatter);
    // The headline is what the author wrote for a busy reader; the first
    // paragraph cut to 300 characters was sometimes a table row. The fallback
    // only serves a parser bound without the handoff contract.
    const summary = handoff?.headline ?? summarize(firstParagraph(parsed.value.body), 300);
    // Supersede in the same breath as the write, so a downstream task never
    // reads last attempt's work - but only work this one actually replaces.
    const previous = this.tasks === undefined
      ? this.artifacts.latest(request.mission.id, type)
      : supersededBy(request.task, type, this.artifacts, this.tasks);

    const manifest = await this.store.write({
      workspaceId: request.mission.workspaceId,
      missionId: request.mission.id,
      taskId: request.task.id,
      createdByRunId: request.runId,
      type,
      title,
      body: source,
      sourceRefs: request.sourceRefs,
      supersedes: previous?.id ?? null,
      summary,
    });
    // The author is who did the work, the responsible person who answers for
    // it; the engine is what put it on record, since nobody uploaded it.
    const recorded = this.artifacts.create({
      ...manifest,
      authorId: request.authorId ?? RUNTIME_ACTOR,
      responsibleId: request.task.responsibleId ?? null,
      recordedBy: SYSTEM_ACTOR,
      handoff,
      wordCount: measure.mainWords,
      overBudget: measure.overBudget,
      round: request.task.round ?? 1,
    });

    const evaluation = evaluationFrom({
      missionId: request.mission.id,
      taskId: request.task.id,
      runId: request.runId,
      roleId: request.roleId,
      type,
      frontMatter: parsed.value.frontMatter,
      summary,
    }, this.clock);
    if (evaluation !== null) this.evaluations.createEvaluation(evaluation);

    this.recorder.record(request.scope, { type: 'artifact.created', artifactId: recorded.id });
    this.recorder.invalidate('artifacts', request.mission.id);
    return { ok: true, manifest: recorded, budget: measure.budget, ...counted };
  }

  /** The artifact being revised, when the file on disk is still exactly its body. */
  async #unchanged(request: HarvestRequest, type: ArtifactType, source: string): Promise<ArtifactManifest | null> {
    const previous = request.revising?.find((a) => a.type === type);
    if (previous === undefined) return null;
    try {
      return (await this.store.read(previous.id)).body === source ? previous : null;
    } catch {
      // An unreadable draft cannot be compared, so the file is stored as new.
      return null;
    }
  }
}

function readTitle(frontMatter: Readonly<Record<string, unknown>>): string | null {
  const title = frontMatter['title'];
  return typeof title === 'string' && title.trim().length > 0 ? title.trim() : null;
}

function readHandoff(frontMatter: Readonly<Record<string, unknown>>): ArtifactHandoff | null {
  const handoff = frontMatter['handoff'];
  return typeof handoff === 'object' && handoff !== null && typeof (handoff as { headline?: unknown }).headline === 'string'
    ? handoff as ArtifactHandoff
    : null;
}

function firstParagraph(body: string): string {
  const withoutHeadings = body.split('\n').filter((line) => !line.startsWith('#')).join('\n');
  return withoutHeadings.trim().split(/\n\s*\n/)[0] ?? '';
}
