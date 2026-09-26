import type { ArtifactHandoff, ArtifactType, WorkflowDefinition, WorkflowIssue } from '@tandemise/domain';
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
 * Every artifact type has a template, since every one carries a handoff.
 * `undefined` stays in the contract so a binding without a template for some
 * type still works: the task names the file it must write, it simply has no
 * skeleton to fill in.
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

/** An artifact body measured against its type's word budget. */
export interface ArtifactBodyMeasure {
  /** Words before `## Appendix`, excluding fenced code and tables. */
  readonly mainWords: number;
  readonly appendixWords: number;
  readonly codeLines: number;
  readonly hasAppendix: boolean;
  /** The type's main-body budget, in words. */
  readonly budget: number;
  readonly overBudget: boolean;
}

/**
 * Length budgets, derived handoffs and the appendix split. Bound to
 * `measureArtifact`, `deriveHandoff` and `splitAppendix` from
 * `@tandemise/artifacts`.
 *
 * The engine needs both to decide whether a round gets a tighten pass and to
 * give a person's work the same headline an agent's carries, and the rules
 * themselves belong with the schemas that quote the same numbers.
 */
export interface ArtifactMeasurePort {
  measure(type: ArtifactType, body: string): ArtifactBodyMeasure;
  deriveHandoff(text: string): ArtifactHandoff;
  /** Cuts a body at its first `## Appendix` heading, with the same fence and table rules `measure` uses. */
  splitAppendix(body: string): { main: string; appendix: string | null };
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
  readonly daemonBuild: string;
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

/** What the browser brought back to the loopback redirect. */
export interface OAuthCallback {
  readonly params: URLSearchParams;
  /** Answers the browser tab. Called exactly once per callback. */
  respond(outcome: { readonly ok: boolean; readonly title: string; readonly message: string }): void;
}

/**
 * A redirect URI that exists for one connect attempt (RFC 8252 §7.3).
 *
 * Bound in the daemon, which may listen on sockets. The listener is on
 * 127.0.0.1, on a port the OS picks, for as long as the attempt lasts - never on
 * the daemon's API port, whose every route requires the desktop's bearer token
 * and which a browser redirect could not present.
 */
export interface OAuthCallbackListener {
  readonly redirectUri: string;
  /** Resolves with the next request to the callback path. */
  next(signal: AbortSignal): Promise<OAuthCallback>;
  close(): void;
}

export interface OAuthCallbackPort {
  open(): Promise<OAuthCallbackListener>;
}
