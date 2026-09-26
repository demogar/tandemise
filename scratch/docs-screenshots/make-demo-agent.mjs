#!/usr/bin/env node
// Writes demo-agent.mjs: a copy of the acceptance suite's scripted agent with neutral,
// Taskly-flavoured strings, so nothing in a screenshot says "scripted" or "hello page".
//   node make-demo-agent.mjs <out-file>
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SOURCE = fileURLToPath(new URL('../acceptance/p0/scripted-agent.mjs', import.meta.url));
const OUT = process.argv[2];
if (!OUT) throw new Error('usage: node make-demo-agent.mjs <out-file>');
let s = readFileSync(SOURCE, 'utf8');
const rep = (a, b) => { if (!s.includes(a)) throw new Error('missing: ' + a.slice(0, 60)); s = s.split(a).join(b); };
rep("const sentence = 'The hello page greets each visitor by name and keeps the layout calm and readable on every screen size.';",
    "const sentence = 'The change keeps the board fast and readable on every screen size.';");
rep("statement: `Scripted criterion ${i + 1}: the hello page ${['greets the visitor by name', 'works offline', 'loads in under a second', 'reads well on a phone'][i % 4]}.`,",
    "statement: DEMO_ACS[i % DEMO_ACS.length],");
rep("const specCriteria = () => {", `const DEMO_ACS = prompt.includes('CSV')
  ? ['Every report has a "Download CSV" button', 'The CSV has a header row and one row per task', 'Dates in the CSV are written as YYYY-MM-DD']
  : prompt.includes('last board')
    ? ['Taskly remembers the last board each person opened', 'Reopening Taskly opens that board', 'A deleted board falls back to the first board in the list']
    : ['The change does what the request asks', 'Nothing else on the board changes', 'The change reads well on a phone'];
const specCriteria = () => {`);
rep("const evidence = outcome === 'FAIL' ? `The scripted check for ${key} failed` : outcome === 'SKIP' ? `Not reached by the scripted run` : `Scripted check for ${key} passed`;",
    "const evidence = outcome === 'FAIL' ? `Checked in the running app: ${key} failed` : outcome === 'SKIP' ? `Not checked: the test data has no report with tasks` : `Checked in the running app: passed`;");
rep(`const REFINE_POOL = [
  'Visiting the home page shows "Hello, <name>" for a signed-in visitor',
  'A visitor who is not signed in sees "Hello, friend" instead of an empty name',
  'The greeting is readable on a 375px wide phone screen without scrolling sideways',
  'The greeting appears within one second of opening the page',
  'Screen readers announce the greeting as the page heading',
  'The greeting still shows when the visitor is offline after a first visit',
];`, `const REFINE_POOL = [
  'Anyone with the link can view the board without signing in',
  'People who open the link cannot add, move or delete cards',
  'The owner can turn the link off, and the old link then shows "This board is no longer shared"',
  'A shared board shows its name, its columns and its cards, and nothing from other boards',
  'The share link is at least 20 random characters, so it cannot be guessed',
  'Turning sharing on again makes a new link',
];`);
rep(`{ text: 'Which pages should greet the visitor by name?', why: 'It decides how many pages the plan touches and what QA checks', options: ['Only the home page', 'Every page'] },`,
    `{ text: 'Should a shared link stop working on its own after a while?', why: 'An expiry adds a setting to build and a case for QA to verify', options: ['No, only when the owner turns it off', 'Yes, after 30 days'] },`);
rep("headline: `${type} ready for the hello page`,", "headline: DEMO_HEADLINE[type] ?? `${type} written`,");
rep("points: ['Written by the scripted acceptance agent', 'No model was called'],", "points: DEMO_POINTS[type] ?? ['Ready for the next step'],");
rep("for (const { type, destination } of outputs) {", `const DEMO_HEADLINE = {
  ProductSpec: 'Spec written with three acceptance criteria',
  QAReport: 'QA checked the change against every criterion',
  ReleaseCandidate: 'Release candidate assembled',
  Refinement: 'Refinement: proposed criteria and one question',
  ProblemBrief: 'Brief written',
  DesignBrief: 'Layout drafted',
  DecisionRecord: 'Decision recorded',
};
const DEMO_POINTS = {
  ProductSpec: ['Every Done-when line is covered by an acceptance criterion', 'Nothing outside the request is in scope'],
  QAReport: ['Each result names the criterion it checks'],
  Refinement: ['Accept, edit or reject each proposal', 'Answer the question before planning'],
};
for (const { type, destination } of outputs) {`);
s = s.split('Written by the scripted acceptance agent.').join('Written for the demo project.');
rep("owner: 'scripted'", "owner: 'product'");
writeFileSync(OUT, s);
{
  let t = readFileSync(OUT, 'utf8');
  const a = "?? 'Scripted work').slice(0, 80);";
  if (!t.includes(a)) throw new Error('title');
  t = t.replace(a, "?? /^Title: (.+)$/m.exec(prompt)?.[1] ?? 'Mission').slice(0, 80);");
  writeFileSync(OUT, t);
}
