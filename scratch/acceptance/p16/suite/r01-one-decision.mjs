// R1 — One new decision while the window is hidden: exactly one native notification naming the mission, nothing
// more on later polls, and clicking it shows the window on the mission with its card. Then, on the Inbox and
// focused, a second decision is recorded without a notification, and leaving the Inbox does not announce it late.
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { cleanSlate, debug, docSize, clearSize, missionAtPlanCard, notifyState, pollTimes, shown, waitShown } from '../common.mjs';

const c = await context();
const { page, until, sleep } = c;
const ev = new Evidence('R1', 'One new decision: one notification, and its click opens the decision');
try {
  await cleanSlate(c, ev);
  await debug(c, 'resume');
  await debug(c, 'focus', null);
  // Whatever an earlier run left in the Inbox is announced (or not) before this scenario starts counting.
  await pollTimes(c, 2);
  const run = Date.now().toString(36);

  // The main process is held while the mission is made, so the notice comes from one known poll.
  await debug(c, 'pause');
  const a = await missionAtPlanCard(c, "Publish the changelog");
  ev.note(`mission ${a.id} "${a.title}", plan card ${a.card.id}`);
  const before = (await shown(c)).length;
  await page.navigate('#/');
  await debug(c, 'hide');
  ev.check('the window is hidden (as the main process sees it)', (await debug(c, 'window'))?.visible === false, await debug(c, 'window'));
  await debug(c, 'resume');
  const list = await waitShown(c, before);
  const notice = list[list.length - 1];
  ev.check('one notification "Decision needed"', list.length === before + 1 && notice.title === 'Decision needed', notice);
  ev.check(`its body names the card and the mission: "${a.card.title} · ${a.title}"`, notice.body === `${a.card.title} · ${a.title}`, notice.body);
  ev.check('it was shown while the window was hidden', notice.windowVisible === false, notice);
  ev.check(`it opens /missions/${a.id}`, notice.route === `/missions/${a.id}`, notice.route);
  await sleep(3500); // three more polls at 1 s
  ev.check('nothing more on later polls (same Inbox, same ids)', (await shown(c)).length === before + 1, (await shown(c)).length);
  ev.check('proof (settings.json): the card id is recorded as announced', notifyState(c).notified.includes(a.card.id), notifyState(c));

  await debug(c, 'click', list.length - 1);
  await until(async () => (await page.evaluate('location.hash')) === `#/missions/${a.id}`, { label: 'mission route', timeoutMs: 15_000 });
  await until(async () => (await debug(c, 'window'))?.visible === true, { label: 'window shown', timeoutMs: 15_000 });
  const text = await page.waitForText(a.title, { selector: 'main', timeoutMs: 15_000 });
  ev.check('clicking it shows the window on the mission', (await debug(c, 'window'))?.visible === true && (await page.evaluate('location.hash')) === `#/missions/${a.id}`, await debug(c, 'window'));
  ev.check('the mission page shows its plan card to decide', /Approve/.test(text) && text.includes(a.title), text.slice(0, 600));
  await docSize(c);
  await page.screenshot(ev.shot('opened-from-notification'));
  await clearSize(c);

  // On the Inbox, focused: the person is looking; nothing is announced, now or later.
  await debug(c, 'pause');
  const b = await missionAtPlanCard(c, `R1 tidy the release notes ${run}`);
  ev.note(`mission ${b.id} "${b.title}", plan card ${b.card.id}`);
  await page.navigate('#/inbox');
  await page.waitForText(b.title, { selector: 'main', timeoutMs: 15_000 });
  await debug(c, 'focus', true);
  const count = (await shown(c)).length;
  const onInbox = await pollTimes(c, 3);
  ev.check('on the Inbox and focused: no notification for the new card', onInbox === 0 && (await shown(c)).length === count, onInbox);
  ev.check('proof (settings.json): it is recorded as seen', notifyState(c).notified.includes(b.card.id), notifyState(c).notified.slice(-3));
  await page.navigate('#/');
  await debug(c, 'focus', false);
  const later = await pollTimes(c, 3);
  ev.check('leaving the Inbox does not announce it late', later === 0 && (await shown(c)).length === count, later);
} catch (e) {
  ev.check(`scenario ran to the end (${e.message})`, false);
} finally {
  await debug(c, 'focus', null).catch(() => undefined);
  await debug(c, 'resume').catch(() => undefined);
  ev.save();
  page.close();
}
