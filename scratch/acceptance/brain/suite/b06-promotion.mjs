// B6 — Thumbs up three times across two missions: Brain → Proposals shows a promotion, and with no promotion
// suite the fake gh opened a PR whose body names the lesson and says "Not evaluated".
import { Evidence } from '../../p0/lib/evidence.mjs';
import { ghLog, home1, openBrainTab, readState, runBuildMission } from '../common.mjs';

const c = await home1();
const ev = new Evidence('B6', 'A lesson that keeps helping is proposed as a rule, as a PR');
const { b5 } = readState();
const helpful = async (missionId, taskTitle) => {
  await c.openTaskDrawer(missionId, taskTitle);
  await c.until(() => c.page.evaluate(`Boolean([...document.querySelectorAll('[role=dialog]')].pop()?.querySelector('section[aria-label="What it knew"] [aria-label="Helpful"]'))`), { label: 'Helpful button', timeoutMs: 20_000 });
  const ok = await c.page.evaluate(`(() => {
    const d = [...document.querySelectorAll('[role=dialog]')].pop();
    const row = [...d.querySelectorAll('section[aria-label="What it knew"] .brain__row')].find((r) => r.innerText.includes('Keep the header sticky on mobile.'));
    const b = row?.querySelector('[aria-label="Helpful"]');
    if (!b || b.disabled) return false;
    b.scrollIntoView({ block: 'center' }); b.click(); return true;
  })()`);
  if (!ok) throw new Error('no Helpful on the lesson');
  await c.sleep(1500);
};
const before = ghLog().length;
await helpful(b5.missionId, b5.taskTitle);
await helpful(b5.missionId, b5.taskTitle);
ev.note('two thumbs-up on the lesson from the B5 mission\'s task');
const second = await runBuildMission(c, `B6 hello page ${Date.now().toString(36)}`);
await helpful(second.id, second.task.title);
ev.note('one thumbs-up from a second mission\'s task');
await c.page.screenshot(ev.shot('thumbs-up'));

const pr = await c.until(() => ghLog().slice(before).find((l) => l.argv[0] === 'pr' && l.argv[1] === 'create' && l.stdin.includes('Keep the header sticky on mobile.')), { label: 'promotion PR', timeoutMs: 90_000, everyMs: 1000 });
ev.check('the fake gh saw pr create with the lesson in the body', pr.stdin.includes('## Lessons') && pr.stdin.includes('Keep the header sticky on mobile.'), pr.stdin.slice(0, 400));
ev.check('and "Not evaluated" (no promotion suite)', pr.stdin.includes('Not evaluated: this project has no promotion evals yet.'));
ev.check('from a tandemise/promote/ branch', pr.argv[pr.argv.indexOf('--head') + 1]?.startsWith('tandemise/promote/'), pr.argv);
await openBrainTab(c, 'proposals');
const text = await c.until(() => c.page.evaluate(`document.querySelector('[aria-label="Proposal list"]')?.innerText ?? false`), { label: 'proposal row', timeoutMs: 30_000 });
ev.check('Brain → Proposals shows the promotion with its PR', text.includes('Keep the header sticky on mobile.') && text.includes('Pull request open') && text.includes('Not evaluated'), text.slice(0, 400));
await c.page.screenshot(ev.shot('proposals'));
c.close(); ev.save();
