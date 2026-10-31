import type { TaskType } from '../planner/types.js';

/**
 * The pull request the ship step opens (#53 §8.1): a Conventional-Commit title
 * from the profile's type and the task's title, and a body made only of what
 * the daemon knows (the tracker link, the Done-when table, the plan's why).
 * No agent-written text goes into either.
 */
const PREFIX: Readonly<Record<TaskType, string>> = {
  fix: 'fix', feature: 'feat', docs: 'docs', deps: 'build', refactor: 'refactor', test: 'test',
  security: 'fix', chore: 'chore', unknown: 'chore',
};

const CONVENTIONAL = /^\s*(feat|fix|docs|chore|refactor|test|build|perf|ci|revert|style)(\([^)]*\))?!?:\s/i;

export function prTitle(profile: { readonly type: TaskType }, title: string): string {
  const clean = title.trim().replace(/\s+/g, ' ');
  if (CONVENTIONAL.test(clean)) return clean;
  const subject = clean.length === 0 ? 'change' : clean.charAt(0).toLowerCase() + clean.slice(1);
  return `${PREFIX[profile.type]}: ${subject}`;
}

export interface PrBodyInput {
  readonly link: string | null;
  readonly criteria: readonly { readonly key: string; readonly statement: string; readonly verified: string }[];
  readonly why: readonly string[];
  readonly missionId: string;
}

const cell = (text: string): string => text.replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function prBody(input: PrBodyInput): string {
  const lines: string[] = [];
  if (input.link !== null) lines.push(`Tracked in ${input.link}`, '');
  lines.push('## Done when', '');
  if (input.criteria.length === 0) lines.push('No Done-when lines were given.');
  else {
    lines.push('| Id | Done when | Verified |', '|---|---|---|');
    for (const c of input.criteria) lines.push(`| ${cell(c.key)} | ${cell(c.statement)} | ${cell(c.verified)} |`);
  }
  if (input.why.length > 0) lines.push('', '## Why these steps', '', ...input.why.map((w) => `- ${w}`));
  lines.push('', `Opened by Tandemise for mission \`${input.missionId}\`.`);
  return lines.join('\n');
}
