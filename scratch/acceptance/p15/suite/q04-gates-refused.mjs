// Q4 — Gates that can never pass are refused where workflows are chosen: a workflow whose release gate reads
// mission.stalled, and one whose build step writes a ChangeSet but never checks it, are listed under New mission
// with the validator's reason; a correct one is not.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { docsSize } from '../common.mjs';

const c = await context();
const { page } = c;
await docsSize(c);
const ev = new Evidence('Q4', 'A workflow gate reading mission.stalled, or missing its output check, is refused with the reason');

const dir = join(c.env.project, '.tandemise', 'workflows');
writeFileSync(join(dir, 'q4-stalled.yaml'), `name: Q4 stalled gate
steps:
  - key: release
    role: release
    objective: Prepare the release.
    outputs: [ReleaseCandidate]
    gate: artifact.ReleaseCandidate.exists && mission.stalled == 0
`);
writeFileSync(join(dir, 'q4-no-output.yaml'), `name: Q4 no output check
steps:
  - key: build
    role: development
    objective: Build it.
    outputs: [ChangeSet]
    gate: checks.typecheck != FAIL && checks.tests != FAIL
`);
ev.note('wrote .tandemise/workflows/q4-stalled.yaml and q4-no-output.yaml in the project');

const banner = async (workflow) => {
  await page.navigate('#/missions/new');
  await page.waitForText('What outcome do you want?', { timeoutMs: 30_000 });
  await c.sleep(600);
  await page.select('Repository', 'acceptance-project');
  await page.select('Workflow', workflow);
  await c.sleep(600);
  return page.evaluate(`[...document.querySelectorAll('.banner')].map((b) => b.innerText).join('\\n')`);
};

const stalled = await banner('q4-stalled');
ev.check('mission.stalled: "only known for the whole mission, not inside a step"',
  stalled.includes("This workflow cannot run yet — steps.0.gate: The gate on 'release' reads mission.stalled, which is only known for the whole mission, not inside a step."), stalled);
await page.screenshot(ev.shot('stalled-gate-refused'));

const noOutput = await banner('q4-no-output');
ev.check('no output check: "never checks that the step wrote its output: add artifact.ChangeSet.exists"',
  noOutput.includes("This workflow cannot run yet — steps.0.gate: The gate on 'build' never checks that the step wrote its output: add artifact.ChangeSet.exists, so a run that writes nothing cannot pass."), noOutput);
await page.screenshot(ev.shot('output-check-refused'));

const good = await banner('P0 acceptance');
ev.check('a correct workflow shows no warning', !good.includes('cannot run yet'), good);

const listed = await c.api.get(`/v1/workflows?workspaceId=${c.env.workspaceId}`);
ev.check('proof (API): both files are listed with their issue and no steps', ['q4-stalled', 'q4-no-output'].every((id) => listed.find((w) => w.id === id)?.issues.length === 1 && listed.find((w) => w.id === id)?.steps.length === 0), listed.filter((w) => w.id.startsWith('q4')));

c.close(); ev.save();
