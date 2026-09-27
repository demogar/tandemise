// D6 — Workspace links. On D5's mission two cards carry one: the design's hand-back (the stored file) and the
// build's own handoff (the agent linked README.md by path). Each renders "Open workspace ↗"; clicking it asks
// the daemon to resolve the path and reveals what comes back. The harness records that answer from the
// renderer's own request and hands the renderer an empty path, which the main process ignores, so no Finder
// window opens during the run. A path out of the project is refused.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { docsSize, openFeed, readState } from '../common.mjs';

const c = await context();
const { page, api, until } = c;
await docsSize(c);
const ev = new Evidence('D6', 'A workspace link renders "Open workspace ↗" and resolves to the local path');
const { d5 } = readState();
if (!d5?.missionId) throw new Error('D6 needs D5 first');
const { missionId } = d5;

// Records each resolve the window makes; the path it passes on to reveal is emptied (see above).
await page.evaluate(`(() => {
  if (window.__p3Resolves) return;
  window.__p3Resolves = [];
  const real = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    const response = await real(input, init);
    if (!url.includes('/v1/workspace-links/resolve')) return response;
    const body = await response.clone().json().catch(() => null);
    window.__p3Resolves.push({ request: init?.body ? JSON.parse(init.body) : null, status: response.status, body });
    return response.ok ? new Response(JSON.stringify({ ...body, path: '' }), { status: 200, headers: { 'content-type': 'application/json' } }) : response;
  };
})()`);
const resolves = () => page.evaluate('window.__p3Resolves ?? []');

const detail = await api.get(`/v1/missions/${missionId}`);
const design = detail.tasks.find((t) => t.key === 'design');
const build = detail.tasks.find((t) => t.key === 'build');
const brief = detail.artifacts.find((a) => a.type === 'DesignBrief' && a.taskId === design.id && a.round === 2);
const evidence = detail.artifacts.find((a) => a.type === 'Evidence' && a.taskId === design.id);
const handBackLink = brief?.handoff?.links?.find((l) => l.kind === 'workspace');
ev.check('proof (API): the hand-back\'s handoff has a workspace link with a path and no url', handBackLink?.path !== undefined && handBackLink.url === undefined, handBackLink);

await openFeed(c, missionId);
const clickWorkspace = async (key) => {
  const title = await page.evaluate(`(() => { const b = [...document.querySelectorAll('[data-feed-card="${key}"] button')].find((x) => x.innerText.trim() === 'Open workspace ↗'); if (!b) return null; b.scrollIntoView({ block: 'center' }); return b.title; })()`);
  return title;
};

// The design's hand-back: the stored file.
const designTitle = await until(() => clickWorkspace('design'), { label: 'design workspace link', timeoutMs: 20_000 }).catch(() => null);
ev.check('the design card shows "Open workspace ↗" (its title is the link\'s path)', designTitle === handBackLink?.path, { shown: designTitle, path: handBackLink?.path });
await page.screenshot(ev.shot('design-card-open-workspace'));
await page.evaluate(`[...document.querySelectorAll('[data-feed-card="design"] button')].find((x) => x.innerText.trim() === 'Open workspace ↗').click()`);
const one = await until(async () => (await resolves())[0], { label: 'resolve request', timeoutMs: 10_000 }).catch(() => null);
const expected = evidence ? (await api.get(`/v1/artifacts/${evidence.id}/path`)).path : null;
ev.check('clicking it asks the daemon, which resolves it to the Evidence file on disk', one?.status === 200 && one.body?.path === realpathSync(expected) && existsSync(one.body.path), { resolved: one, evidencePath: expected });
ev.check('that file is the handed-back export', one?.body?.path && readFileSync(one.body.path, 'utf8').includes('Hello page, v2'));
ev.check('no error flash after the click', !(await c.flash()), await c.flash());

// The build's own handoff: an agent naming a file in the repository by path.
const buildTitle = await until(() => clickWorkspace('build'), { label: 'build workspace link', timeoutMs: 20_000 }).catch(() => null);
ev.check('the build card shows "Open workspace ↗" for the agent\'s README.md link', buildTitle === 'README.md', buildTitle);
await page.evaluate(`[...document.querySelectorAll('[data-feed-card="build"] button')].find((x) => x.innerText.trim() === 'Open workspace ↗').click()`);
const two = await until(async () => (await resolves())[1], { label: 'second resolve', timeoutMs: 10_000 }).catch(() => null);
const readme = realpathSync(join(c.env.project, 'README.md'));
ev.check('it resolves to README.md in the project\'s repository', two?.status === 200 && two.body?.path === readme, { resolved: two, readme });
await page.evaluate(`document.querySelector('[data-feed-card="build"]')?.scrollIntoView({ block: 'center' })`);
await page.screenshot(ev.shot('build-card-open-workspace'));

// The reader offers it too.
await page.evaluate(`[...document.querySelectorAll('[data-feed-card="design"] button')].find((x) => x.innerText.trim() === 'Full doc')?.click()`);
const reader = await until(async () => { const t = await page.evaluate(`[...document.querySelectorAll('[role=dialog]')].pop()?.innerText ?? ''`); return t.includes('Open workspace') && t; }, { label: 'reader', timeoutMs: 10_000 }).catch(() => '');
ev.check('the reader of the handed-back DesignBrief offers "Open workspace"', reader.includes('Open workspace'), reader.slice(0, 300));
await page.screenshot(ev.shot('reader-open-workspace'));
await page.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);

// Out of the project: refused by the daemon.
const outside = await api.post('/v1/workspace-links/resolve', { workspaceId: c.env.workspaceId, path: '../../etc/passwd' }).then(() => null, (e) => ({ status: e.status, body: e.body }));
ev.check('proof (API): a path out of the project is refused', outside !== null && outside.status >= 400, outside);

// Back to the window's own fetch for the scenarios after this one.
await page.send('Page.reload', {});
await c.sleep(2000);
c.close(); ev.save();
