import type { ArtifactManifest, ExternalRef, Mission } from '@tandemise/domain';

/**
 * Mission intake (spec A2): turning an upload pinned as Evidence into the typed
 * artifact a mission consumes.
 *
 * Everything here is pure. The run itself belongs to planning, which owns the
 * runtime ladder intake borrows; this module decides what an upload should
 * become, what the agent is told, and how an intake artifact is recognised
 * again later without a column of its own.
 */

export type IntakeTarget = 'ProductSpec' | 'ProblemBrief' | 'DesignBrief' | 'ImplementationPlan';

/**
 * The target type from media type, filename and refs. ProductSpec vs
 * ProblemBrief is decided after the run by whether the output has acceptance
 * criteria, because only the agent that read the upload can say.
 */
export function intakeTargetFor(e: {
  mediaType: string; filename: string; refs: readonly ExternalRef[];
}): 'spec-or-brief' | 'DesignBrief' | 'ImplementationPlan' {
  const name = e.filename.toLowerCase();
  const media = e.mediaType.toLowerCase();
  // An existing change: a resolved pull request, or a patch someone exported.
  if (e.refs.some((r) => r.kind === 'github.pr')) return 'ImplementationPlan';
  if (/\.(patch|diff)$/.test(name) || /^(text|application)\/(x-)?(diff|patch)$/.test(media)) return 'ImplementationPlan';
  // A picture of the thing, or an export from a design tool.
  if (media.startsWith('image/') || /\.(fig|sketch|xd|png|jpe?g|gif|webp|svg)$/.test(name)
    || e.refs.some((r) => r.kind === 'url' && /(^|\.)figma\.com\//i.test(r.value.replace(/^https?:\/\//, '')))) {
    return 'DesignBrief';
  }
  return 'spec-or-brief';
}

/** The fixed objective of an intake pass, worded as the spec words it. */
export function intakeObjective(type: IntakeTarget | 'spec-or-brief', filename: string): string {
  const into = type === 'spec-or-brief'
    ? '`ProductSpec` when it states acceptance criteria, otherwise `ProblemBrief`'
    : `\`${type}\``;
  return `Turn the uploaded input into ${into}, preserving its content. The Evidence is the source of truth. `
    + `The Evidence is "${filename}".`;
}

/**
 * Whether an intake document states acceptance criteria, in its front matter
 * or as a section. The spec-or-brief choice rests on this alone: a document
 * with criteria is a spec, one without is a brief.
 */
export function hasAcceptanceCriteria(source: string): boolean {
  return /^acceptanceCriteria\s*:/m.test(source) || /^#{1,6}\s*acceptance criteria\b/im.test(source);
}

/** The name the person gave the upload: its file ref's label, else its title. */
export function uploadFilename(evidence: Pick<ArtifactManifest, 'sourceRefs' | 'title'>): string {
  return evidence.sourceRefs.find((r) => r.kind === 'file' && r.label !== undefined)?.label ?? evidence.title;
}

/**
 * Whether `artifact` is what intake made of `evidence`.
 *
 * No column records it (spec A7 adds none): an intake artifact is mission-wide
 * (`taskId: null`), is not itself Evidence, and carries the Evidence's first
 * ref. Comparing by the ref's value rather than the Evidence id means the same
 * bytes pinned twice are one blob with one intake, not two.
 */
export function isIntakeOf(artifact: ArtifactManifest, evidence: ArtifactManifest): boolean {
  const first = evidence.sourceRefs[0];
  if (first === undefined || (first.kind !== 'file' && first.kind !== 'url')) return false;
  if (artifact.taskId !== null || artifact.type === 'Evidence' || artifact.missionId !== evidence.missionId) return false;
  return artifact.sourceRefs.some((r) => r.kind === first.kind && r.value === first.value);
}

/** The mission's uploads: Evidence pinned with no task, at creation. */
export function missionUploads(artifacts: readonly ArtifactManifest[]): readonly ArtifactManifest[] {
  return artifacts.filter((a) => a.type === 'Evidence' && a.taskId === null);
}

/** What intake made of an upload, if anything, among the mission's artifacts. */
export function intakeArtifactFor(evidence: ArtifactManifest, artifacts: readonly ArtifactManifest[]): ArtifactManifest | undefined {
  return artifacts.find((a) => isIntakeOf(a, evidence));
}

export interface IntakePromptInput {
  readonly mission: Mission;
  readonly target: IntakeTarget | 'spec-or-brief';
  readonly filename: string;
  readonly mediaType: string;
  /** Where the upload's bytes were copied, relative to the working directory. */
  readonly input: string;
  /** Where the document goes, relative to the working directory. */
  readonly destination: string;
  /** The artifact contract for each type the document may be. */
  readonly templates: readonly { readonly type: IntakeTarget; readonly template: string }[];
  /** The person's Done-when lines, so a spec's `covers` can name them. */
  readonly criteria: readonly { readonly key: string; readonly statement: string }[];
}

/**
 * The intake prompt. It says what the document must be and where it goes, and
 * nothing about planning: intake converts, it does not decide what to build.
 */
export function buildIntakePrompt(input: IntakePromptInput): string {
  const lines = [
    'You convert something a person handed in into a document Tandemise can use. You do not plan or build anything.',
    '',
    '# The objective',
    '',
    intakeObjective(input.target, input.filename),
    '',
    `The upload (${input.mediaType}) is at \`${input.input}\`, relative to your working directory. Read it in full.`,
    'Keep what it says: restate it in the shape below, do not improve on it, and do not invent what it leaves out.',
    '',
    '# The request it came with',
    '',
    '~~~',
    input.mission.goal.trim(),
    '~~~',
    '',
  ];
  if (input.criteria.length > 0) {
    lines.push(
      'Done when (the person\'s own lines; a spec\'s acceptance criteria name the ones they prove in `covers`):',
      ...input.criteria.map((c) => `- ${c.key}: ${c.statement}`),
      '',
    );
  }
  lines.push('# What to write', '');
  for (const { type, template } of input.templates) {
    lines.push(input.templates.length > 1 ? `## As a ${type}` : `One ${type}, exactly in this shape:`, '', template, '');
  }
  lines.push(
    '# Where it goes',
    '',
    `Write it to \`${input.destination}\` with your file-writing tool, then reply with only the word DONE.`,
    'If you cannot write files, reply with the document itself.',
  );
  return lines.join('\n');
}
