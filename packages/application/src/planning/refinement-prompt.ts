import type { Mission, Repository } from '@tandemise/domain';

/**
 * The refinement prompt (P6).
 *
 * Refinement is the product owner's first job: take a rough request and make
 * it ready to plan. The template (packages/artifacts) carries how to do that
 * job well; this prompt carries the request itself and everything the person
 * already settled, so the pass proposes only what is missing and never asks
 * again what was answered.
 */
export interface RefinementPromptInput {
  readonly mission: Mission;
  readonly repository: Repository | null;
  /** Criteria the person already accepted (their own lines included). */
  readonly accepted: readonly { readonly key: string; readonly statement: string }[];
  /** Questions answered in earlier passes. */
  readonly answered: readonly { readonly text: string; readonly answer: string }[];
  /** Proposals the person rejected: not to be proposed again. */
  readonly rejected: readonly string[];
  /** What intake made of the person's uploads (spec A2); an uploaded spec is a source of criteria. */
  readonly uploads?: readonly { readonly type: string; readonly title: string; readonly headline: string }[];
  /** The Refinement template with its guidance, from the artifact contract. */
  readonly template: string;
  readonly workingDirectory: string;
  /** Where the document goes, relative to the working directory. */
  readonly destination: string;
  /** The previous attempt's validation issues, verbatim; empty on the first attempt. */
  readonly issues: readonly string[];
}

export function buildRefinementPrompt(input: RefinementPromptInput): string {
  const { mission, repository } = input;
  const lines: string[] = [
    'You are the product owner for a request someone just gave Tandemise. Nothing has been planned or built yet.',
    'Your one job is to make this request ready to plan: propose the criteria that define "done" for this person,',
    'and ask only the questions whose answers change the plan or the criteria. You read the repository; you never',
    'change code, and you never plan or implement the work.',
    '',
    '# The request',
    '',
    'Goal (the person\'s own words):',
    '~~~',
    mission.goal.trim(),
    '~~~',
    '',
  ];
  if (mission.constraints.length > 0) lines.push('Constraints:', ...mission.constraints.map((c) => `- ${c}`), '');
  lines.push(input.accepted.length > 0
    ? ['Done when (already accepted; do not propose these again):', ...input.accepted.map((c) => `- ${c.key}: ${c.statement}`)].join('\n')
    : 'Done when: nothing yet. The request cannot be planned until at least one criterion is accepted, so propose the ones that define done.');
  lines.push('');
  if (input.answered.length > 0) {
    lines.push('Already decided by the person (do not ask again; use these answers):', ...input.answered.map((a) => `- ${a.text}\n  Answer: ${a.answer}`), '');
  }
  if ((input.uploads ?? []).length > 0) {
    lines.push(
      'Handed in with the request (converted from the person\'s uploads; propose criteria they state, do not ask what they answer):',
      ...(input.uploads ?? []).map((u) => `- ${u.type} "${u.title}": ${u.headline}`),
      '',
    );
  }
  if (input.rejected.length > 0) {
    lines.push('Proposed before and rejected by the person (do not propose these again):', ...input.rejected.map((r) => `- ${r}`), '');
  }
  lines.push(
    repository === null
      ? 'Repository: none. Refine from the request alone.'
      : `Repository: ${repository.name} at ${repository.path} (default branch ${repository.defaultBranch}). Read it before you ask anything it could answer.`,
    `Autonomy: ${mission.autonomy}`,
    '',
    '# What to write',
    '',
    'One Refinement document, exactly in this shape:',
    '',
    input.template,
    '',
    '# Where it goes',
    '',
    `Work in: ${input.workingDirectory}`,
    'Write the document with your file-writing tool to the path below, relative to your working directory, then reply',
    'with only the word DONE. If you cannot write files, reply with the document itself.',
    '',
    `### Refinement → ${input.destination}`,
  );
  if (input.issues.length > 0) {
    lines.push(
      '',
      '# Your previous attempt was rejected',
      '',
      'These are the validator\'s findings, verbatim. Fix every one of them and write the document again.',
      '',
      ...input.issues.map((i) => `- ${i}`),
    );
  }
  return lines.join('\n');
}
