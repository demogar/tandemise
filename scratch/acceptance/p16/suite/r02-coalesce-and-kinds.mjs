// R2 — Several at once, and a kind switched off. Three new decisions in one poll give one notification
// "3 things need you" whose click opens the Inbox. With "Refinements" switched off in Settings, a draft whose
// refinement asks for decisions reaches the Inbox without a notification, and switching it back on does not
// announce it late.
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import {
  SECTION, cleanSlate, clearSize, createDraft, debug, refine, docSize, missionAtPlanCard, notifyState, openNotificationSettings, pollTimes, shown, switchOn,
} from '../common.mjs';

const c = await context();
const { page, until, sleep, api } = c;
const ev = new Evidence('R2', 'Three at once become one notification; a switched-off kind stays quiet');
try {
  await cleanSlate(c, ev);
  await debug(c, 'focus', null);
  await debug(c, 'resume');
  await pollTimes(c, 2);
  const run = Date.now().toString(36);

  await debug(c, 'pause');
  const made = [];
  for (const goal of [`R2 fix the footer links ${run}`, `R2 add a sitemap ${run}`, `R2 compress the images ${run}`]) made.push(await missionAtPlanCard(c, goal));
  ev.note(`missions: ${made.map((m) => `${m.id} "${m.title}"`).join('; ')}`);
  await page.navigate('#/');
  const before = (await shown(c)).length;
  const got = await debug(c, 'poll');
  const list = await shown(c);
  const notice = list[list.length - 1];
  ev.check('one poll, one notification for three new cards', got === 1 && list.length === before + 1, { got, count: list.length - before });
  ev.check('it reads "3 things need you"', notice?.title === '3 things need you', notice);
  const named = made.filter((m) => notice?.body.includes(`${m.card.title} · ${m.title}`));
  ev.check('its body names two of the three cards and "and 1 more"', named.length === 2 && notice.body.endsWith('; and 1 more'), notice?.body);
  ev.check('it opens the Inbox', notice?.route === '/inbox', notice?.route);
  ev.check('proof (settings.json): all three card ids are recorded', made.every((m) => notifyState(c).notified.includes(m.card.id)), notifyState(c).notified.slice(-4));
  ev.check('nothing more on the next polls', (await pollTimes(c, 3)) === 0);

  await debug(c, 'click', list.length - 1);
  await until(async () => (await page.evaluate('location.hash')) === '#/inbox', { label: 'inbox route', timeoutMs: 15_000 });
  const inbox = await until(async () => { const t = await page.text('main'); return made.every((m) => t.includes(m.title)) && t; }, { label: 'three rows', timeoutMs: 15_000 }).catch(() => page.text('main'));
  ev.check('clicking it opens the Inbox with the three missions', made.every((m) => inbox.includes(m.title)), inbox.slice(0, 700));
  await page.screenshot(ev.shot('inbox-from-coalesced'));

  // Settings → Notifications: Refinements off, in the window.
  await openNotificationSettings(c);
  if (!(await switchOn(c, 'Refinements'))) throw new Error('Refinements should start on');
  await page.click('Refinements', { within: SECTION });
  await until(async () => !(await switchOn(c, 'Refinements')), { label: 'switch off', timeoutMs: 10_000 });
  const prefs = await api.get('/v1/notifications/preferences');
  ev.check('the Refinements switch reads off', !(await switchOn(c, 'Refinements')));
  ev.check('proof (API): kinds.refinements is false, the rest on', prefs.kinds.refinements === false && prefs.kinds.decisions && prefs.kinds.stalled && prefs.kinds.quiet && prefs.kinds.limits, prefs.kinds);
  await docSize(c);
  await openNotificationSettings(c);
  await page.screenshot(ev.shot('settings-refinements-off'));
  await clearSize(c);

  await debug(c, 'resume');
  const count = (await shown(c)).length;
  const draft = await createDraft(c, `R2 a page for the press kit ${run}`);
  ev.note(`draft ${draft.id}`);
  await refine(c, draft.id);
  await until(async () => (await api.get(`/v1/inbox?workspaceId=${c.env.workspaceId}`)).refinements.some((r) => r.missionId === draft.id), { label: 'refinement in the Inbox', timeoutMs: 90_000 });
  await page.navigate('#/');
  await sleep(1500);
  await pollTimes(c, 2);
  ev.check('the refinement is in the Inbox and no notification was shown for it', (await shown(c)).length === count, (await shown(c)).slice(count));
  ev.check('proof (settings.json): it is recorded as seen', notifyState(c).notified.includes(`refinement:${draft.id}`), notifyState(c).notified.slice(-3));

  await openNotificationSettings(c);
  await page.click('Refinements', { within: SECTION });
  await until(() => switchOn(c, 'Refinements'), { label: 'switch on', timeoutMs: 10_000 });
  await page.navigate('#/');
  await pollTimes(c, 2);
  ev.check('switching Refinements back on does not announce the old one', (await shown(c)).length === count, (await shown(c)).slice(count));
} catch (e) {
  ev.check(`scenario ran to the end (${e.message})`, false);
} finally {
  await debug(c, 'resume').catch(() => undefined);
  await api.put('/v1/notifications/preferences', { kinds: { refinements: true } }).catch(() => undefined);
  ev.save();
  page.close();
}
