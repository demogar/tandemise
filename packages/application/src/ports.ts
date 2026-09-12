import type { ArtifactType, WorkflowDefinition, WorkflowIssue } from '@tandemise/domain';
import type { Result, Timestamp } from '@tandemise/shared';

/**
 * Ports the mission engine owns.
 *
 * Each of these exists for the same reason: the engine needs a capability that
 * a *lower* layer already implements, and `@tandemise/application` may not
 * import that layer. Rather than duplicate the implementation, the engine
 * states the narrowest contract it needs and the composition root binds it.
 */

/**
 * The authoring template for an artifact type, as handed to a worker inside the
 * output contract. Bound to `renderArtifactTemplate` from
 * `@tandemise/artifacts`.
 *
 * `undefined` for a type with no front-matter schema (Evidence, MissionPlan).
 * A missing template is not an error: the task still names the file it must
 * write, it simply has no skeleton to fill in.
 */
export interface ArtifactTemplatePort {
  render(type: ArtifactType): string | undefined;
}

export interface ArtifactParseIssue {
  /** Dotted path into the front matter, e.g. `findings.0.severity`. */
  readonly path: string;
  readonly message: string;
}

export interface ParsedArtifactDocument {
  readonly type: ArtifactType;
  readonly frontMatter: Readonly<Record<string, unknown>>;
  readonly body: string;
}

/**
 * Validates an agent-authored artifact against its front-matter contract.
 * Bound to `parseArtifact` from `@tandemise/artifacts`.
 *
 * Returns a `Result` because a malformed artifact is the ordinary way a first
 * attempt fails; the issues are fed straight back into the retry prompt.
 */
export interface ArtifactParserPort {
  parse(type: ArtifactType, source: string): Result<ParsedArtifactDocument, readonly ArtifactParseIssue[]>;
}

/** User-visible daemon settings. The application only reads and merges them. */
export interface SettingsStorePort {
  read(): Record<string, unknown>;
  write(patch: Record<string, unknown>): Record<string, unknown>;
}

/**
 * Facts about the running daemon that only the composition root knows. Supplied
 * rather than read from `process` so the application layer stays a pure
 * consumer of its environment.
 */
export interface SystemEnvironmentPort {
  readonly daemonVersion: string;
  readonly schemaVersion: number;
  readonly home: string;
  readonly startedAt: Timestamp;
  readonly pid: number;
  readonly platform: string;
  readonly nodeVersion: string;
}

/**
 * "Is this process id still running?"
 *
 * Recovery has to answer that for a pid recorded by a *previous* daemon, which
 * no supervisor in this process knows anything about (MVP.md §21.2).
 */
export interface ProcessLivenessPort {
  isAlive(pid: number): boolean;
}

/**
 * A workflow file found in a project's repository.
 *
 * Either it parsed or it did not; a file with problems is still listed, with
 * its issues, because a workflow that silently disappears from the list is far
 * harder to debug than one that shows up saying what is wrong with it.
 */
export interface LoadedWorkflow {
  /** Filename without extension - what a mission names to run it. */
  readonly id: string;
  /** Absolute path, so the UI can open the file that needs fixing. */
  readonly path: string;
  readonly definition: WorkflowDefinition | null;
  readonly issues: readonly WorkflowIssue[];
}

/**
 * Where workflow files come from.
 *
 * A port because reading files is not the application layer's business, and
 * because the same list has to be producible from a fixture in a test. The
 * convention - `.tandemise/workflows/*.yaml` inside each of the project's
 * repositories - lives in the adapter.
 */
export interface WorkflowSourcePort {
  list(repositoryPaths: readonly string[]): Promise<readonly LoadedWorkflow[]>;
}
