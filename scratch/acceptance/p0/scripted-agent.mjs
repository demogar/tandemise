#!/usr/bin/env node
// A deterministic stand-in for a model, used by the real-app acceptance runs.
//
// It is wired as a Generic CLI runtime profile (promptVia: stdin). It reads the
// prompt Tandemise compiled, finds every "### <Type> → <destination>" line in
// the output contract, and writes an artifact that satisfies that type's
// front-matter schema. Everything around it - scheduling, staffing, approvals,
// the desktop - is the real product. Only the model is replaced, so a scenario
// that fails is a product failure rather than a model having a bad day.
//
// Knobs (environment of the daemon, inherited by the runtime). The three modes
// can also be switched on per mission by writing the variable's name in the
// mission goal, so one daemon can run a normal and a long mission side by side.
//   SCRIPTED_DELAY_MS         sleep before writing, so a scenario can act mid-run
//   SCRIPTED_LONG=1           first draft's main body is 1.5x its type's word budget;
//                             a prompt asking to "Tighten" gets a short body
//   SCRIPTED_STUBBORN=1       always over budget, tighten pass or not
//   SCRIPTED_NO_HANDOFF_ONCE=1  omit the handoff until the retry feedback names it
// Rounds (P2): a prompt that carries numbered feedback lines is a round, and the
// agent answers every note in handoff.changed, citing its id. The P2 modes are
// listed where they are read, below.
// A task objective that mentions "preview" gets an "Open preview" link in its handoff.
// P8 usage knobs (SCRIPTED_USAGE_MIN, SCRIPTED_COST_USD) are described where they are read, at the end.
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString('utf8');

const workIn = /^Work in: (.+)$/m.exec(prompt)?.[1]?.trim() ?? process.cwd();
const outputs = [...prompt.matchAll(/^### ([A-Za-z]+) → (\S+)$/gm)].map((m) => ({ type: m[1], destination: m[2] }));
const title = (/^#+\s*Task[^\n]*\n+([^\n]+)/m.exec(prompt)?.[1] ?? 'Scripted work').slice(0, 80);

const objective = /^Objective:\n([\s\S]*?)\n\n/m.exec(prompt)?.[1] ?? '';
// Harness-only switch: a mode is on when its env var is 1 or when the prompt
// contains the variable's name anywhere (a goal, a constraint, an upstream
// artifact). That is deliberately loose, and fine for a scripted stand-in that
// never sees real user text; nothing in the product reads these names.
const mode = (name) => process.env[name] === '1' || prompt.includes(name);
const LONG = mode('SCRIPTED_LONG');
const STUBBORN = mode('SCRIPTED_STUBBORN');
// The tighten request is one "Tighten <Type>: ..." line per artifact; the
// output contract's own "asked once to tighten it" is lower case and never matches.
const tightening = /^Tighten [A-Za-z]+:/m.test(prompt);
// The first attempt has no retry feedback; the retry after a missing handoff names handoff.headline.
const omitHandoff = mode('SCRIPTED_NO_HANDOFF_ONCE') && !prompt.includes('handoff.headline');

// Rounds: the numbered feedback lines the engine writes into a round's prompt.
const feedbackItems = [...prompt.matchAll(/^\d+\. (fb_[0-9a-z]{20}) \(([^)]*)\): (.*)$/gm)].map((m) => ({ id: m[1], author: m[2], text: m[3] }));
const inRound = feedbackItems.length > 0;
//   SCRIPTED_SLOW_20S            first pass sleeps 20 s (a note can arrive mid-run); a delivery pass does not
//   SCRIPTED_OMIT_CITATION_ONCE  leaves the last note uncited until the retry names it ("must cite fb_…")
//   SCRIPTED_DECLINE             declines every note
//   SCRIPTED_REVIEW_BLOCKING     a ReviewReport blocks until the ChangeSet it reads cites feedback
//   SCRIPTED_FAIL_UNTIL_NOTE     writes nothing (the task blocks) until a round carries a note
//   SCRIPTED_PROMPT_DIR          (env) every prompt is saved there, so a scenario can read what the agent was told
const SLOW = mode('SCRIPTED_SLOW_20S') && !inRound;
const OMIT_ONCE = mode('SCRIPTED_OMIT_CITATION_ONCE') && !/must cite fb_/.test(prompt);
const DECLINE = mode('SCRIPTED_DECLINE');
const REVIEW_BLOCKING = mode('SCRIPTED_REVIEW_BLOCKING') && !/feedback: "?fb_[0-9a-z]{20}/.test(prompt);
const FAIL_UNTIL_NOTE = mode('SCRIPTED_FAIL_UNTIL_NOTE') && !inRound;
// P5, the Done-when ledger. The prompt lists it as "- U1: …" lines and tells a
// tester which ids to verify; the agent covers and verifies exactly those.
//   SCRIPTED_SPEC_MISSES_U2  the spec's criteria never cover U2 (the task blocks on criteria.uncovered_user)
//   SCRIPTED_SPEC_TWO_ACS    the spec writes AC1 and AC2
//   SCRIPTED_QA_PARTIAL      the spec writes AC1-AC3; QA passes AC1 and skips the rest
//   SCRIPTED_QA_FAIL_AC2     the spec writes AC1 and AC2; QA fails AC2
//   SCRIPTED_SPEC_THREE_ACS  the spec writes AC1-AC3 (QA passes all three) (P10)
//   SCRIPTED_FAIL_RELEASE    a step asked for a ReleaseCandidate writes nothing, every time; the "P10 desk"
//                            workflow's release gate needs the artifact, so its retries exhaust (P10)
// A spec written in a round adds one criterion per note, so a note adds AC3 to two.
const ledgerBlock = /^Done when \(criteria ledger[^\n]*\n((?:- [^\n]+\n?)+)/m.exec(prompt)?.[1] ?? '';
const ledgerKeys = [...ledgerBlock.matchAll(/^- ([A-Za-z][\w-]*): /gm)].map((m) => m[1]);
const userKeys = ledgerKeys.filter((k) => /^U\d+$/.test(k));
const verifyKeys = /with `criterionId` set to its ledger id: ([^.]+)\./.exec(prompt)?.[1]?.split(',').map((k) => k.trim()).filter(Boolean)
  ?? (ledgerKeys.length > 0 ? ledgerKeys.filter((k) => !/^U\d+$/.test(k)) : ['AC1']);
const SPEC_MISSES_U2 = mode('SCRIPTED_SPEC_MISSES_U2');
const QA_PARTIAL = mode('SCRIPTED_QA_PARTIAL');
const QA_FAIL_AC2 = mode('SCRIPTED_QA_FAIL_AC2');
const baseAcs = (QA_PARTIAL || mode('SCRIPTED_SPEC_THREE_ACS')) ? 3 : (QA_FAIL_AC2 || mode('SCRIPTED_SPEC_TWO_ACS')) ? 2 : 1;
if (process.env.SCRIPTED_PROMPT_DIR) {
  mkdirSync(process.env.SCRIPTED_PROMPT_DIR, { recursive: true });
  writeFileSync(join(process.env.SCRIPTED_PROMPT_DIR, `${Date.now()}-${process.pid}.txt`), prompt);
}
if (SLOW) await new Promise((r) => setTimeout(r, 20_000));
if (FAIL_UNTIL_NOTE) { console.log('SCRIPTED_FAIL_UNTIL_NOTE: nothing written'); process.exit(0); }
if (mode('SCRIPTED_FAIL_RELEASE') && outputs.some((o) => o.type === 'ReleaseCandidate')) { console.log('SCRIPTED_FAIL_RELEASE: nothing written'); process.exit(0); }

// P9, liveness. Both count runs per step of one mission in SCRIPTED_STATE_DIR
// (default: a folder in the system temp dir), keyed by the knob's line in the
// prompt (the mission goal) and the step title, so two missions never share a count.
//   SCRIPTED_FAIL_TIMES=<n>  the first n runs of a step write nothing (its gate fails; retries exhaust)
//   SCRIPTED_HANG_ONCE       the first run of a step prints nothing and sleeps SCRIPTED_HANG_MS
//                            (default 10 min) until it is stopped; later runs work normally
const runOf = (knob) => {
  const line = prompt.split('\n').find((l) => l.includes(knob)) ?? knob;
  const key = createHash('sha1').update(`${line}\n${title}`).digest('hex').slice(0, 16);
  const dir = process.env.SCRIPTED_STATE_DIR ?? join(tmpdir(), 'tandemise-scripted-state');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${knob}-${key}`);
  const n = (existsSync(file) ? Number(readFileSync(file, 'utf8')) : 0) + 1;
  writeFileSync(file, String(n));
  return n;
};
if (prompt.includes('SCRIPTED_HANG_ONCE') && runOf('SCRIPTED_HANG_ONCE') === 1) {
  await new Promise((r) => setTimeout(r, Number(process.env.SCRIPTED_HANG_MS ?? 600_000)));
}
{
  const failTimes = /SCRIPTED_FAIL_TIMES=(\d+)/.exec(prompt)?.[1] ?? process.env.SCRIPTED_FAIL_TIMES;
  if (failTimes !== undefined && runOf('SCRIPTED_FAIL_TIMES') <= Number(failTimes)) {
    console.log('SCRIPTED_FAIL_TIMES: nothing written');
    process.exit(0);
  }
}

const cite = OMIT_ONCE ? feedbackItems.slice(0, -1) : feedbackItems;
const changed = !inRound ? [] : DECLINE
  ? [{ what: 'Declined: the scripted agent keeps the page as it is', feedback: feedbackItems.map((f) => f.id).join(', ') }]
  : [{ what: `Applied: ${feedbackItems[0].text}`.slice(0, 140), ...(cite.length > 0 ? { feedback: cite.map((f) => f.id).join(', ') } : {}) }];

// Main-body word budgets per type, as the handoff contract sets them.
const BUDGET = {
  ReleaseCandidate: 300, DecisionRecord: 300, MissionPlan: 300,
  ProblemBrief: 400, QAPlan: 400, Evidence: 400,
  DesignBrief: 500, ReviewReport: 500, QAReport: 500, ChangeSet: 500,
  ProductSpec: 600, FinanceReport: 600,
  ArchitecturePlan: 800, ImplementationPlan: 800,
};

/** Plain prose of `words` words: no code or tables, so every word counts against the budget. */
const prose = (words) => {
  const sentence = 'The hello page greets each visitor by name and keeps the layout calm and readable on every screen size.';
  const vocabulary = sentence.split(' ');
  const out = [];
  for (let i = 0; i < words; i += 1) out.push(vocabulary[i % vocabulary.length]);
  // Paragraphs of about sixty words, so the reader shows a document rather than one block.
  return out.map((w, i) => (i > 0 && i % 60 === 0 ? `\n\n${w}` : w)).join(' ');
};

const delay = Number(process.env.SCRIPTED_DELAY_MS ?? 0);
if (delay > 0) await new Promise((r) => setTimeout(r, delay));

const specCriteria = () => {
  const count = baseAcs + feedbackItems.length;
  const covers = userKeys.filter((k) => !(SPEC_MISSES_U2 && k === 'U2'));
  return Array.from({ length: count }, (_, i) => ({
    id: `AC${i + 1}`,
    statement: `Scripted criterion ${i + 1}: the hello page ${['greets the visitor by name', 'works offline', 'loads in under a second', 'reads well on a phone'][i % 4]}.`,
    ...(covers.length > 0 ? { covers } : {}),
  }));
};
const qaResults = () => (verifyKeys.length > 0 ? verifyKeys : ['AC1']).map((key, i) => {
  const outcome = QA_FAIL_AC2 && key === 'AC2' ? 'FAIL' : QA_PARTIAL && i > 0 ? 'SKIP' : 'PASS';
  const evidence = outcome === 'FAIL' ? `The scripted check for ${key} failed` : outcome === 'SKIP' ? `Not reached by the scripted run` : `Scripted check for ${key} passed`;
  return { criterionId: key, outcome, evidence };
});

// P6, refinement. The prompt lists what the person already accepted, answered
// and rejected; the agent proposes the next three criteria it has not seen there
// and asks the one question not yet answered, so a second pass reads as new.
const REFINE_POOL = [
  'Visiting the home page shows "Hello, <name>" for a signed-in visitor',
  'A visitor who is not signed in sees "Hello, friend" instead of an empty name',
  'The greeting is readable on a 375px wide phone screen without scrolling sideways',
  'The greeting appears within one second of opening the page',
  'Screen readers announce the greeting as the page heading',
  'The greeting still shows when the visitor is offline after a first visit',
];
const REFINE_QUESTIONS = [
  { text: 'Which pages should greet the visitor by name?', why: 'It decides how many pages the plan touches and what QA checks', options: ['Only the home page', 'Every page'] },
  { text: 'Should a returning visitor see a different greeting?', why: 'A second greeting adds a remembered-visit state to build and verify', options: ['Yes, "Welcome back"', 'No, always the same'] },
];
const refinement = () => {
  const proposed = REFINE_POOL.filter((line) => !prompt.includes(line)).slice(0, 3);
  const asked = REFINE_QUESTIONS.filter((q) => !prompt.includes(q.text)).slice(0, 1);
  return {
    proposedCriteria: proposed.map((statement, i) => ({ key: `P${i + 1}`, statement })),
    questions: asked.map((q, i) => ({ key: `Q${i + 1}`, ...q })),
  };
};

const FRONT = {
  ProblemBrief: { successMetric: 'Scenario passes', evidence: [] },
  ProductSpec: { acceptanceCriteria: specCriteria(), nonGoals: [] },
  DesignBrief: { flows: ['Main flow'], accessibility: ['Keyboard reachable'], openQuestions: [] },
  ArchitecturePlan: { components: ['app'], risks: [], migration: '' },
  ImplementationPlan: { steps: [{ id: 's1', summary: 'Make the change', files: ['README.md'], dependsOn: [] }] },
  ChangeSet: { branch: 'scripted/change', commits: [], filesChanged: 0, testsRun: [], knownLimitations: [] },
  ReviewReport: { verdict: 'pass', reviewedRef: 'HEAD', findings: [] },
  QAPlan: { cases: [{ id: 'c1', criterion: verifyKeys[0] ?? 'AC1', method: 'manual' }] },
  QAReport: { results: qaResults(), blockingDefects: 0 },
  ReleaseCandidate: { ref: 'HEAD', checks: [], unresolvedRisks: [], rollback: 'Revert the commit.' },
  DecisionRecord: { status: 'accepted', decision: 'Proceed', owner: 'scripted', supersedes: '' },
  get Refinement() { return refinement(); },
};

const yaml = (value, indent = '') => {
  if (Array.isArray(value)) {
    if (value.length === 0) return ' []';
    return value.map((item) => (typeof item === 'object'
      ? `\n${indent}- ${yaml(item, `${indent}  `).trimStart()}`
      : `\n${indent}- ${JSON.stringify(item)}`)).join('');
  }
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).map(([k, v]) => {
      const rendered = yaml(v, `${indent}  `);
      return `\n${indent}${k}:${rendered.startsWith('\n') ? rendered : rendered.startsWith(' ') ? rendered : ` ${rendered}`}`;
    }).join('');
  }
  return ` ${JSON.stringify(value)}`;
};

for (const { type, destination } of outputs) {
  const path = isAbsolute(destination) ? destination : join(workIn, destination);
  mkdirSync(dirname(path), { recursive: true });
  // Every artifact carries a handoff, and titles are capped at 60 characters,
  // so the stand-in writes a basic handoff and trims its title to fit.
  const handoff = {
    headline: `${type} ready for the hello page`,
    points: ['Written by the scripted acceptance agent', 'No model was called'],
    ...(/preview/i.test(objective) ? { links: [{ label: 'Open preview', url: 'https://example.com/preview', kind: 'workspace' }] } : {}),
    ...(changed.length > 0 ? { changed } : {}),
  };
  const typeFront = type === 'ReviewReport' && REVIEW_BLOCKING
    ? { verdict: 'fail', reviewedRef: 'HEAD', findings: [{ severity: 'blocking', title: 'The greeting ignores the visitor name', location: 'hello.txt' }] }
    : type === 'ChangeSet'
      ? { ...FRONT.ChangeSet, filesChanged: 1 }
      : FRONT[type] ?? {};
  // A ChangeSet touches a file, so a round leaves a commit on the task's branch.
  if (type === 'ChangeSet') appendFileSync(join(workIn, 'hello.txt'), `round ${inRound ? feedbackItems.map((f) => f.id).join(',') : 'first'}\n`);
  const front = {
    type, schemaVersion: 1, title: `${type}: ${title}`.slice(0, 60).trim(),
    ...(omitHandoff ? {} : { handoff }),
    ...typeFront,
  };
  const budget = BUDGET[type] ?? 400;
  const long = STUBBORN || (LONG && !tightening);
  // A tightened long draft does what the tighten request asks: a short main
  // body, with the supporting detail moved under "## Appendix" (within 2x budget).
  // A round's body lists the notes it answered, so the reader's comparison shows what moved.
  const roundNotes = inRound ? `\nRound notes:\n${feedbackItems.map((f) => `- ${f.text}`).join('\n')}\n` : '';
  // A QA report says what it found per criterion in its body too, so a reader sees it without the front matter.
  const qaBody = type === 'QAReport' ? `\n## Results\n\n${typeFront.results.map((r) => `- ${r.criterionId}: ${r.outcome} — ${r.evidence}`).join('\n')}\n` : '';
  const body = (long
    ? `# ${front.title}\n\n${prose(Math.ceil(budget * 1.5))}\n`
    : LONG && tightening
      ? `# ${front.title}\n\nWritten by the scripted acceptance agent.\n\n## Appendix\n\n${prose(Math.ceil(budget * 0.8))}\n`
      : `# ${front.title}\n\nWritten by the scripted acceptance agent.\n`) + qaBody + roundNotes;
  writeFileSync(path, `---${yaml(front)}\n---\n\n${body}`);
  console.log(`wrote ${type} to ${path}`);
}
if (outputs.length === 0) console.log('No artifacts requested.');

// P8, limits. The agent reports usage as one NDJSON line, which a runtime
// profile with outputFormat "ndjson" reads (a "text" profile shows it as a line).
//   SCRIPTED_USAGE_MIN=<n>   report n agent minutes, 1200 input and 300 output tokens, no cost
//   SCRIPTED_COST_USD=<x>    also report a cost of x US dollars
// A number can come from the environment or from "SCRIPTED_USAGE_MIN=5" in the prompt (the mission goal).
const knobNumber = (name) => {
  const fromEnv = process.env[name];
  if (fromEnv !== undefined && fromEnv !== '') return Number(fromEnv);
  const match = new RegExp(`${name}=([0-9.]+)`).exec(prompt);
  return match === null ? null : Number(match[1]);
};
const usageMinutes = knobNumber('SCRIPTED_USAGE_MIN');
const costUsd = knobNumber('SCRIPTED_COST_USD');
if (usageMinutes !== null || costUsd !== null) {
  console.log(JSON.stringify({
    type: 'usage',
    ...(usageMinutes === null ? {} : { wallTimeMs: Math.round(usageMinutes * 60_000) }),
    inputTokens: 1200,
    outputTokens: 300,
    ...(costUsd === null ? {} : { costUsd }),
  }));
}
