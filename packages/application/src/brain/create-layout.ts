import type { BrainWrite, WorkspaceKnowledge } from '@tandemise/domain';
import { scrubForBrain, BRAIN_PATH_REFUSAL } from '@tandemise/domain';
import { redactSecrets } from '@tandemise/shared';
import type { SetupFile } from '../setup/codec.js';
import {
  BRAIN_FACTORY, BRAIN_GITATTRIBUTES, BRAIN_GITATTRIBUTES_FILE, BRAIN_MANIFEST, BRAIN_README, BRAIN_RULES, BRAIN_SKILLS,
  renderBrainManifest, type BrainManifest,
} from './layout.js';

/** The five knowledge fields, in the order `project.md` writes them (#51 plan Task 5). */
const KNOWLEDGE_SECTIONS: readonly [keyof WorkspaceKnowledge, string][] = [
  ['productVision', 'Product vision'],
  ['architecturePrinciples', 'Architecture principles'],
  ['codingStandards', 'Coding standards'],
  ['designSystem', 'Design system'],
  ['glossary', 'Glossary'],
];

export const PROJECT_RULES_FILE = `${BRAIN_RULES}/project.md`;

/**
 * Scrubs a curated text (rules, decisions) for the brain: secrets go, paths
 * inside a repository become repo-relative, any other machine path is replaced
 * rather than refusing the whole document.
 */
export function scrubDocument(text: string, repos: readonly { name: string; path: string }[]): string {
  const result = scrubForBrain(text, repos);
  if ('text' in result) return result.text;
  if (result.refused !== BRAIN_PATH_REFUSAL) return '';
  const redacted = redactSecrets(text);
  const relative = [...repos].sort((a, b) => b.path.length - a.path.length)
    .reduce((t, r) => t.split(r.path.endsWith('/') ? r.path : `${r.path}/`).join(`${r.name}:`), redacted);
  return relative
    .replace(/(^|[\s'"`(<[=,])(~?\/[^\s'"`)>\]/,;]+\/[^\s'"`)>\],;]*)/g, '$1[a path on this machine]')
    .replace(/«redacted»/g, '[redacted secret]');
}

export function projectRules(knowledge: WorkspaceKnowledge, scrub: (t: string) => string): string {
  const parts: string[] = ['# Project rules', '', 'Every agent on this project reads this file. Keep it short.', ''];
  for (const [key, heading] of KNOWLEDGE_SECTIONS) {
    const value = knowledge[key];
    if (value === null || value.trim() === '') continue;
    parts.push(`## ${heading}`, '', scrub(value.trim()), '');
  }
  return `${parts.join('\n').replace(/\n+$/, '')}\n`;
}

export function brainReadme(project: string): string {
  return [
    `# ${project}: the brain`,
    '',
    `This repository is the brain of the ${project} project in Tandemise: how its factory works and what it has learned.`,
    '',
    '- `factory/` holds the roles, workflows, routines, skills pins, tracker and the MCPs the project needs.',
    '- `memory/rules/` holds curated conventions every agent loads. Change them with a commit or a pull request.',
    '- `memory/decisions/` holds accepted decisions.',
    '- `memory/ledger/` is an append-only log of lessons and votes, one file per writer. Never edit it by hand.',
    '- `evals/` holds the evals that gate promotions. Agents never read it.',
    '',
    'Sharing is `git pull` and `git push`. Secrets and personal settings never live here.',
    '',
  ].join('\n');
}

export interface BrainLayoutInput {
  readonly manifest: BrainManifest;
  /** `renderSetup(...)` files, relative to the setup root. */
  readonly setupFiles: readonly SetupFile[];
  readonly knowledge: WorkspaceKnowledge;
  readonly decisions: readonly { path: string; content: string }[];
  /** Vendored skill versions: name, hash and files as text. */
  readonly skills: readonly { name: string; hash: string; files: readonly { path: string; content: string }[] }[];
  readonly scrub: (text: string) => string;
}

/** The first commit of a new brain (#51 spec §1, §3). */
export function createBrainLayout(input: BrainLayoutInput): BrainWrite[] {
  const writes: BrainWrite[] = [
    { path: BRAIN_MANIFEST, mode: 'write', content: renderBrainManifest(input.manifest) },
    { path: BRAIN_README, mode: 'write', content: brainReadme(input.manifest.project) },
    { path: BRAIN_GITATTRIBUTES_FILE, mode: 'write', content: BRAIN_GITATTRIBUTES },
    { path: PROJECT_RULES_FILE, mode: 'write', content: projectRules(input.knowledge, input.scrub) },
  ];
  for (const file of input.setupFiles) writes.push({ path: `${BRAIN_FACTORY}/${file.path}`, mode: 'write', content: file.content });
  for (const d of input.decisions) writes.push({ path: d.path, mode: 'write', content: d.content });
  for (const skill of input.skills) {
    for (const f of skill.files) writes.push({ path: `${BRAIN_SKILLS}/${skill.name}/${skill.hash.slice(0, 12)}/${f.path}`, mode: 'write', content: f.content });
  }
  return writes;
}
