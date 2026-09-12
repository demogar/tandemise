import type { ArtifactType } from '@tandemise/domain';
import { Err, Ok, type Result } from '@tandemise/shared';
import { parseFrontMatterDocument } from './front-matter.js';
import { ARTIFACT_SCHEMAS, hasSchema, type FrontMatterFor, type SchemaBackedArtifactType } from './schemas.js';

export interface ArtifactIssue {
  /** Dotted path into the front matter, e.g. `findings.0.severity`. */
  readonly path: string;
  readonly message: string;
}

export interface ParsedArtifact<T extends SchemaBackedArtifactType = SchemaBackedArtifactType> {
  readonly type: T;
  readonly frontMatter: FrontMatterFor<T>;
  /** The Markdown below the closing fence. */
  readonly body: string;
}

/**
 * Validates an agent-authored artifact against its front-matter contract
 * (MVP.md §15.1: artifacts are the contract between stages, so the contract has
 * to be checkable).
 *
 * Returns `Result` rather than throwing because a malformed artifact is an
 * expected outcome - it is the normal way a role's first attempt fails, and the
 * issues list is fed straight back to that role as a retry prompt.
 */
export function parseArtifact<T extends SchemaBackedArtifactType>(
  type: T,
  source: string,
): Result<ParsedArtifact<T>, readonly ArtifactIssue[]>;
export function parseArtifact(
  type: ArtifactType,
  source: string,
): Result<ParsedArtifact, readonly ArtifactIssue[]>;
export function parseArtifact(
  type: ArtifactType,
  source: string,
): Result<ParsedArtifact, readonly ArtifactIssue[]> {
  if (!hasSchema(type)) {
    // Evidence, FinanceReport and MissionPlan have no front-matter contract by
    // design, so there is nothing to validate but presence. Refusing them made
    // `artifact.FinanceReport.exists` and `artifact.Evidence.exists` gates
    // impossible to pass: a finance run wrote its report and was blocked anyway.
    const document = parseFrontMatterDocument(source);
    const body = document.ok ? document.value.body : source.trim();
    if (body.trim() === '') {
      return Err([{ path: '', message: 'Artifact body is empty.' }]);
    }
    return Ok({
      type: type as SchemaBackedArtifactType,
      frontMatter: (document.ok ? document.value.frontMatter : {}) as ParsedArtifact['frontMatter'],
      body,
    });
  }

  const document = parseFrontMatterDocument(source);
  if (!document.ok) {
    return Err([{
      path: '',
      message: `${document.error}. An artifact must begin with a YAML front-matter block fenced by \`---\`.`,
    }]);
  }

  const result = ARTIFACT_SCHEMAS[type].safeParse(document.value.frontMatter);
  if (!result.success) {
    return Err(result.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: describe(issue.path.join('.'), issue.message),
    })));
  }
  if (document.value.body.trim() === '') {
    return Err([{ path: '', message: 'Artifact body is empty. Front matter alone is not an artifact.' }]);
  }

  return Ok({
    type,
    frontMatter: result.data as ParsedArtifact['frontMatter'],
    body: document.value.body,
  });
}

/** Renders issues as the correction instruction handed back to the author. */
export function formatIssues(issues: readonly ArtifactIssue[]): string {
  return issues.map((i) => (i.path ? `  - ${i.path}: ${i.message}` : `  - ${i.message}`)).join('\n');
}

function describe(path: string, message: string): string {
  return path === '' ? message : `${message} (at \`${path}\`)`;
}
