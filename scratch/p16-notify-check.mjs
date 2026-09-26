// P16: reach me when it matters. The set of Inbox items to announce is a pure
// diff of the Inbox ids now minus the ids already announced; several new ones
// are folded into one notice; quiet hours hold and summarise; a kind switched
// off is recorded and never announced later.
//
//   npm run build && node scratch/p16-notify-check.mjs
//
// Pure diff first, then the Inbox mapping, then a real daemon (settings.json,
// a restart, the test clock for quiet hours).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let passed = 0;
const failures = [];
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failures.push(label); console.log(`  FAIL ${label}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)?.slice(0, 700)}`}`); }
};
const section = (t) => console.log(`\n== ${t}`);

const D = await import('@tandemise/domain');
const app = await import('@tandemise/application');
const C = await import('@tandemise/api-contract');

const item = (id, kind = 'decisions', extra = {}) => ({
  id, kind, workspaceId: 'wsp_a', title: kind === 'decisions' ? 'Decision needed' : `Kind ${kind}`, body: `Body ${id}`, route: `/missions/msn_${id}`, ...extra,
});
const prefs = (over = {}) => ({ ...D.DEFAULT_NOTIFY_PREFERENCES, ...over, kinds: { ...D.DEFAULT_NOTIFY_PREFERENCES.kinds, ...(over.kinds ?? {}) } });
const plan = (items, state = D.EMPTY_NOTIFY_STATE, over = {}) =>
  D.planNotifications({ items, state, preferences: over.preferences ?? prefs(), minuteOfDay: over.minuteOfDay ?? 12 * 60, suppress: over.suppress ?? false });

// ------------------------------------------------------------------ pure diff
section('pure: the diff');
{
  const one = plan([item('a')]);
  check('one new item: one notice with its own title, body and route', one.notice?.shape === 'item' && one.notice.title === 'Decision needed' && one.notice.body === 'Body a' && one.notice.route === '/missions/msn_a' && one.notice.workspaceId === 'wsp_a', one.notice);
  check('it is recorded as notified', one.state.notified.join() === 'a' && one.state.held.length === 0, one.state);
  const again = plan([item('a')], one.state);
  check('same state again: no notice', again.notice === null && again.state.notified.join() === 'a', again);
  const gone = plan([], again.state);
  check('the item leaves the Inbox: no notice, still remembered', gone.notice === null && gone.state.notified.includes('a'), gone.state);
  const back = plan([item('a')], gone.state);
  check('it comes back with the same id: no repeat', back.notice === null, back.notice);

  const three = plan([item('a'), item('b'), item('c')], D.EMPTY_NOTIFY_STATE);
  check('three new in one pass: one coalesced "3 things need you"', three.notice?.shape === 'coalesced' && three.notice.title === '3 things need you' && three.notice.route === '/inbox', three.notice);
  check('its body names two and "and 1 more"', three.notice?.body === 'Body a; Body b; and 1 more', three.notice?.body);
  check('all three are recorded', three.state.notified.join() === 'a,b,c', three.state);
  const two = plan([item('a'), item('b')]);
  check('two new: "2 things need you", both bodies, no "more"', two.notice?.title === '2 things need you' && two.notice.body === 'Body a; Body b', two.notice);
  const plusOne = plan([item('a'), item('b'), item('c'), item('d')], three.state);
  check('one more after three: only the new one, on its own', plusOne.notice?.shape === 'item' && plusOne.notice.ids.join() === 'd', plusOne.notice);
  const dup = plan([item('a'), item('a')]);
  check('a duplicated id counts once', dup.notice?.shape === 'item' && dup.state.notified.length === 1, dup);
  const spans = plan([item('a'), item('b', 'decisions', { workspaceId: 'wsp_b' })]);
  check('items from two projects: no project on the notice', spans.notice?.workspaceId === null, spans.notice);
}

section('pure: kinds switched off, and suppress');
{
  const off = prefs({ kinds: { stalled: false } });
  const r = plan([item('s1', 'stalled'), item('d1')], D.EMPTY_NOTIFY_STATE, { preferences: off });
  check('a stalled item with stalled off is not announced; the decision is', r.notice?.ids.join() === 'd1' && r.notice.shape === 'item', r.notice);
  check('the stalled item is recorded anyway', r.state.notified.includes('s1'), r.state);
  const on = plan([item('s1', 'stalled'), item('d1')], r.state);
  check('switching stalled on later does not announce the old one', on.notice === null, on.notice);
  const onlyOff = plan([item('s2', 'stalled')], D.EMPTY_NOTIFY_STATE, { preferences: off });
  check('only switched-off items: no notice', onlyOff.notice === null && onlyOff.state.notified.join() === 's2', onlyOff);

  const sup = plan([item('a'), item('b')], D.EMPTY_NOTIFY_STATE, { suppress: true });
  check('looking at the Inbox: nothing announced, both recorded', sup.notice === null && sup.state.notified.join() === 'a,b', sup);
  const after = plan([item('a'), item('b')], sup.state);
  check('leaving the Inbox does not announce them late', after.notice === null, after.notice);
}

section('pure: quiet hours');
{
  const q = (from, to) => prefs({ quietHours: { from, to } });
  check('22:00-07:00 wraps midnight: 23:30 and 06:59 are quiet, 07:00 and 21:59 are not',
    D.inQuietHours({ from: '22:00', to: '07:00' }, 23 * 60 + 30) && D.inQuietHours({ from: '22:00', to: '07:00' }, 6 * 60 + 59)
    && !D.inQuietHours({ from: '22:00', to: '07:00' }, 7 * 60) && !D.inQuietHours({ from: '22:00', to: '07:00' }, 21 * 60 + 59));
  check('13:00-14:00: 13:00 quiet (from inclusive), 14:00 not (to exclusive)', D.inQuietHours({ from: '13:00', to: '14:00' }, 13 * 60) && !D.inQuietHours({ from: '13:00', to: '14:00' }, 14 * 60));
  check('equal ends are no quiet hours, never all day', !D.inQuietHours({ from: '09:00', to: '09:00' }, 9 * 60));
  check('null is no quiet hours', !D.inQuietHours(null, 0));

  const night = q('22:00', '07:00');
  const held = plan([item('a'), item('b')], D.EMPTY_NOTIFY_STATE, { preferences: night, minuteOfDay: 23 * 60 });
  check('during quiet hours: nothing announced, both held', held.notice === null && held.state.held.join() === 'a,b' && held.state.notified.length === 0, held.state);
  const still = plan([item('a'), item('b')], held.state, { preferences: night, minuteOfDay: 2 * 60 });
  check('still quiet: nothing, still held', still.notice === null && still.state.held.join() === 'a,b', still.state);
  const left = plan([item('a')], still.state, { preferences: night, minuteOfDay: 3 * 60 });
  check('a held item that left the Inbox is dropped', left.state.held.join() === 'a', left.state);
  const morning = plan([item('a'), item('c')], left.state, { preferences: night, minuteOfDay: 7 * 60 });
  check('quiet hours end: one summary for the held one plus the new one', morning.notice?.shape === 'summary' && morning.notice.title === 'After quiet hours: 2 things need you' && morning.notice.route === '/inbox', morning.notice);
  check('after the summary: held cleared, both notified', morning.state.held.length === 0 && morning.state.notified.join() === 'a,c', morning.state);
  const later = plan([item('a'), item('c')], morning.state, { preferences: night, minuteOfDay: 8 * 60 });
  check('and nothing again after that', later.notice === null);
  const single = plan([item('x')], { notified: [], held: ['x'] }, { preferences: night, minuteOfDay: 12 * 60 });
  check('one held item: "After quiet hours: 1 thing needs you", its route', single.notice?.title === 'After quiet hours: 1 thing needs you' && single.notice.route === '/missions/msn_x' && single.notice.body === 'Decision needed: Body x', single.notice);
  const quietOff = plan([item('s', 'stalled')], D.EMPTY_NOTIFY_STATE, { preferences: prefs({ quietHours: { from: '22:00', to: '07:00' }, kinds: { stalled: false } }), minuteOfDay: 23 * 60 });
  check('a switched-off kind during quiet hours is recorded, not held', quietOff.state.notified.join() === 's' && quietOff.state.held.length === 0, quietOff.state);
  const supQuiet = plan([item('a')], { notified: [], held: ['a'] }, { preferences: night, minuteOfDay: 8 * 60, suppress: true });
  check('looking at the Inbox when quiet hours end: held ones recorded, no summary', supQuiet.notice === null && supQuiet.state.notified.join() === 'a' && supQuiet.state.held.length === 0, supQuiet);
}

section('pure: memory is bounded and never forgets a live item');
{
  const old = Array.from({ length: D.NOTIFIED_MEMORY }, (_, i) => `old${i}`);
  const r = plan([item('old0'), item('new1')], { notified: old, held: [] });
  check('memory stays at NOTIFIED_MEMORY', r.state.notified.length === D.NOTIFIED_MEMORY, r.state.notified.length);
  check('the oldest id still in the Inbox is kept; the oldest gone one is dropped', r.state.notified.includes('old0') && !r.state.notified.includes('old1') && r.state.notified.includes('new1'));
  check('no repeat for old0', r.notice?.ids.join() === 'new1', r.notice);
}

section('pure: preferences and state read leniently');
{
  const n = D.normalizeNotifyPreferences({ kinds: { stalled: false, bogus: true, quiet: 'no' }, quietHours: { from: '25:00', to: '07:00' } });
  check('unknown kinds ignored, non-booleans default to on, bad time drops quiet hours', n.kinds.stalled === false && n.kinds.quiet === true && !('bogus' in n.kinds) && n.quietHours === null, n);
  check('equal ends drop quiet hours', D.normalizeNotifyPreferences({ quietHours: { from: '09:00', to: '09:00' } }).quietHours === null);
  check('garbage reads as the default', JSON.stringify(D.normalizeNotifyPreferences('x')) === JSON.stringify(D.DEFAULT_NOTIFY_PREFERENCES));
  check('state keeps only strings', JSON.stringify(D.normalizeNotifyState({ notified: ['a', 3, null], held: 'b' })) === '{"notified":["a"],"held":[]}');
  check('request: "7:00" is refused', !C.updateNotificationPreferencesRequest.safeParse({ quietHours: { from: '7:00', to: '08:00' } }).success);
  check('request: equal ends are refused', !C.updateNotificationPreferencesRequest.safeParse({ quietHours: { from: '08:00', to: '08:00' } }).success);
  check('request: unknown kind is refused', !C.updateNotificationPreferencesRequest.safeParse({ kinds: { nope: true } }).success);
  check('request: partial kinds and null quiet hours are fine', C.updateNotificationPreferencesRequest.safeParse({ kinds: { quiet: false }, quietHours: null }).success);
}

// ------------------------------------------------------------ Inbox mapping
section('mapping: the Inbox rows for me, with the desktop Inbox ids');
{
  const approval = (id, over = {}) => ({
    approval: { id, workspaceId: 'wsp_a', missionId: 'msn_1', taskId: 'tsk_1', runId: null, kind: 'plan', status: 'PENDING', risk: 'read', title: 'Approve the plan', rationale: '', effect: '', evidence: [], options: [{ id: 'approve', label: 'Approve' }], recommendedOptionId: null, selectedOptionId: null, decidedBy: null, decisionNote: null, createdAt: '', decidedAt: null, expiresAt: null, addresseeIds: [], escalationLevel: 0, escalateAt: null, recordedBy: 'system', ...over },
    missionTitle: 'Add CSV export', taskTitle: null, roleName: null, revisable: false, addressees: [], decidedByRef: null, recordedByRef: null, escalationLevel: 0, headline: null,
  });
  const inbox = {
    approvals: [
      approval('apr_plan'),
      approval('apr_check', { kind: 'check' }),
      approval('apr_limit', { kind: 'intervention', taskId: null, missionId: null, title: 'Limit reached: 15 of 12 agent minutes', options: [{ id: D.RAISE_LIMIT_OPTION, label: 'Raise' }] }),
      { ...approval('apr_other'), addressees: [{ id: 'mem_other', kind: 'person', name: 'Someone' }] },
      approval('apr_done', { status: 'APPROVED' }),
    ],
    tasks: [{ id: 'tsk_h', key: 'review', title: 'Review the copy', missionId: 'msn_2', missionTitle: 'Landing page', assignee: null, responsible: null, claimable: [], escalatedTo: [], statusReason: null, updatedAt: '' }],
    refinements: [{ missionId: 'msn_3', missionTitle: 'Dark theme', toDecide: 2, openQuestions: 1, proposedPending: 1, forIds: [], updatedAt: '' }],
    stalled: [{ missionId: 'msn_4', missionTitle: 'Search', missionStatus: 'BLOCKED', rule: 'L12', reason: "'release' is blocked", action: { kind: 'replan', label: 'Re-plan', taskId: null, taskKey: null }, forIds: ['mem_me'], since: '' }],
    silentRuns: [{ runId: 'run_q', taskId: 'tsk_q', taskKey: 'implement', taskTitle: 'Implement', missionId: 'msn_5', missionTitle: 'Offline mode', attempt: 1, lastEventAt: '', quietForMs: 34 * 60_000, quietAfterMs: 0, silentAfterMs: 0, budgetMs: 0, forIds: [] }],
  };
  const items = app.itemsFromInbox('wsp_a', inbox, 'mem_me');
  const by = Object.fromEntries(items.map((i) => [i.id, i]));
  check('ids: approvals, task, refinement:, stalled:, quiet:', Object.keys(by).sort().join() === ['apr_limit', 'apr_plan', 'quiet:run_q', 'refinement:msn_3', 'stalled:msn_4', 'tsk_h'].sort().join(), Object.keys(by));
  check('a check card, a card for someone else and a decided card are left out', !by.apr_check && !by.apr_other && !by.apr_done);
  check('plan card: decisions, "Decision needed", "Approve the plan · Add CSV export", opens the mission', by.apr_plan?.kind === 'decisions' && by.apr_plan.title === 'Decision needed' && by.apr_plan.body === 'Approve the plan · Add CSV export' && by.apr_plan.route === '/missions/msn_1', by.apr_plan);
  check('limit card: limits, "Limit reached", no mission opens the Inbox', by.apr_limit?.kind === 'limits' && by.apr_limit.title === 'Limit reached' && by.apr_limit.route === '/inbox', by.apr_limit);
  check('human step: decisions, "Your step is waiting"', by.tsk_h?.kind === 'decisions' && by.tsk_h.title === 'Your step is waiting' && by.tsk_h.route === '/missions/msn_2', by.tsk_h);
  check('refinement: refinements, "2 to decide · Dark theme"', by['refinement:msn_3']?.kind === 'refinements' && by['refinement:msn_3'].body === '2 to decide · Dark theme', by['refinement:msn_3']);
  check('stalled: opens /inbox/stalled', by['stalled:msn_4']?.kind === 'stalled' && by['stalled:msn_4'].route === '/inbox/stalled' && by['stalled:msn_4'].title === 'Mission stalled', by['stalled:msn_4']);
  check('quiet: "implement quiet for 34 min · Offline mode", opens /inbox', by['quiet:run_q']?.kind === 'quiet' && by['quiet:run_q'].body === 'implement quiet for 34 min · Offline mode' && by['quiet:run_q'].route === '/inbox', by['quiet:run_q']);
  const nobody = app.itemsFromInbox('wsp_a', inbox, null);
  check('a caller with no seat still gets rows for anyone, not rows for a named member', !nobody.some((i) => i.id === 'stalled:msn_4') && nobody.some((i) => i.id === 'refinement:msn_3'));
}

// ---------------------------------------------------------------- the daemon
section('daemon: preferences in settings.json, take, a restart, the test clock');
const root = mkdtempSync(join(tmpdir(), 'tdn-'));
const home = join(root, 'h');
const repoDir = join(root, 'r');
const gitConfig = join(root, 'gitconfig');
writeFileSync(gitConfig, '[user]\n\tname = Notify Tester\n\temail = notify@example.com\n');
const savedEnv = { GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, TANDEMISE_OWNER_NAME: process.env.TANDEMISE_OWNER_NAME };
process.env.GIT_CONFIG_GLOBAL = gitConfig;
delete process.env.TANDEMISE_OWNER_NAME;
execFileSync('git', ['init', '-q', '-b', 'main', repoDir], { stdio: 'ignore' });
writeFileSync(join(repoDir, 'README.md'), '# notify check\n');
execFileSync('git', ['add', '.'], { cwd: repoDir, stdio: 'ignore' });
execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repoDir, stdio: 'ignore' });

const sqlite = await import('node:sqlite');
const { startDaemon } = await import('../apps/daemon/dist/main.js');
let daemon;
let token;
const api = async (method, path, body) => {
  const res = await fetch(`${daemon.url}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'x-tandemise-api-version': 'v1', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
};
const start = async () => {
  daemon = await startDaemon({ home, logLevel: 'error', tickIntervalMs: 60_000, clockOffsetMs: 0 });
  token = JSON.parse(readFileSync(join(home, 'daemon.json'), 'utf8')).token;
};
let n = 0;
const addCard = (ws, title, extra = {}) => {
  const db = new sqlite.DatabaseSync(join(home, 'tandemise.db'));
  try {
    const id = `apr_p16_${n++}`;
    db.prepare(`INSERT INTO approvals (id, workspace_id, mission_id, task_id, run_id, kind, status, risk, title, rationale, effect, evidence, options,
      recommended_option_id, selected_option_id, decided_by, decision_note, created_at, decided_at, expires_at, addressees, escalation_level, escalate_at, recorded_by)
      VALUES (?, ?, NULL, NULL, NULL, ?, 'PENDING', 'read', ?, 'r', 'e', '[]', ?, NULL, NULL, NULL, NULL, ?, NULL, NULL, '[]', 0, NULL, 'system')`)
      .run(id, ws, extra.kind ?? 'intervention', title, JSON.stringify(extra.options ?? [{ id: 'approve', label: 'Go on' }, { id: 'reject', label: 'Stop' }]), new Date().toISOString());
    return id;
  } finally { db.close(); }
};
const settle = (id) => {
  const db = new sqlite.DatabaseSync(join(home, 'tandemise.db'));
  try { db.prepare("UPDATE approvals SET status = 'APPROVED' WHERE id = ?").run(id); } finally { db.close(); }
};
// The daemon's connection does not see rows written behind its back while it
// runs, so seeding happens with the daemon stopped (a restart each time, which
// the notified-id memory must survive anyway).
const seeded = async (fn) => { await daemon.stop(); const out = fn(); await start(); return out; };
const settingsFile = () => JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8'));
const hhmm = (ms) => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

try {
  await start();
  const ws = (await api('POST', '/v1/workspaces', { name: 'Notify', repositoryPath: repoDir })).body?.workspace?.id;
  const p0 = await api('GET', '/v1/notifications/preferences');
  check('GET preferences: every kind on, no quiet hours', p0.status === 200 && Object.values(p0.body.kinds).every((v) => v === true) && p0.body.quietHours === null && p0.body.quietNow === false, p0.body);
  const empty = await api('POST', '/v1/notifications/take', {});
  check('take with an empty Inbox: no notices', empty.status === 200 && empty.body.notices.length === 0, empty.body);
  const noBody = await api('POST', '/v1/notifications/take');
  check('take with no body is fine', noBody.status === 200, noBody);
  const bad = await api('PUT', '/v1/notifications/preferences', { quietHours: { from: '9', to: '10:00' } });
  check('a bad time is 400 with the reason', bad.status === 400 && /24-hour time/.test(bad.body?.error?.message ?? JSON.stringify(bad.body)), bad);

  const first = await seeded(() => addCard(ws, 'Allow a network call'));
  const t1 = await api('POST', '/v1/notifications/take', {});
  check('a new card: one notice "Decision needed", body is the card title, opens the Inbox (no mission)', t1.body.notices.length === 1 && t1.body.notices[0].title === 'Decision needed' && t1.body.notices[0].body === 'Allow a network call' && t1.body.notices[0].route === '/inbox' && t1.body.notices[0].workspaceId === ws, t1.body);
  check('settings.json records it under notificationState', settingsFile().notificationState?.notified?.includes(first), settingsFile());
  const t2 = await api('POST', '/v1/notifications/take', {});
  check('take again: nothing', t2.body.notices.length === 0, t2.body);

  await daemon.stop();
  await start();
  const t3 = await api('POST', '/v1/notifications/take', {});
  check('after a daemon restart: still nothing (persisted)', t3.body.notices.length === 0, t3.body);

  await seeded(() => { addCard(ws, 'Card one'); addCard(ws, 'Card two'); addCard(ws, 'Card three'); });
  const t4 = await api('POST', '/v1/notifications/take', {});
  check('three new cards: one "3 things need you"', t4.body.notices.length === 1 && t4.body.notices[0].title === '3 things need you' && t4.body.notices[0].route === '/inbox', t4.body);

  const [check1, limit] = await seeded(() => [addCard(ws, 'Look at the release', { kind: 'check' }), addCard(ws, 'Limit reached: 15 of 12 agent minutes', { options: [{ id: D.RAISE_LIMIT_OPTION, label: 'Raise' }, { id: 'keep_paused', label: 'Keep paused' }] })]);
  const off = await api('PUT', '/v1/notifications/preferences', { kinds: { limits: false } });
  check('PUT kinds: limits off, the rest unchanged', off.status === 200 && off.body.kinds.limits === false && off.body.kinds.decisions === true, off.body);
  check('settings.json has the preferences', settingsFile().notifications?.kinds?.limits === false, settingsFile().notifications);
  const t5 = await api('POST', '/v1/notifications/take', {});
  check('a check card and a limit card with limits off: nothing', t5.body.notices.length === 0, t5.body);
  check('the limit card is recorded; the check card is not an item at all', settingsFile().notificationState.notified.includes(limit) && !settingsFile().notificationState.notified.includes(check1));
  await api('PUT', '/v1/notifications/preferences', { kinds: { limits: true } });
  const t6 = await api('POST', '/v1/notifications/take', {});
  check('limits back on: the old limit card is not announced', t6.body.notices.length === 0, t6.body);

  const sup = await seeded(() => addCard(ws, 'Seen in the Inbox'));
  const t7 = await api('POST', '/v1/notifications/take', { suppress: true });
  const t8 = await api('POST', '/v1/notifications/take', {});
  check('suppress: nothing now, nothing later', t7.body.notices.length === 0 && t8.body.notices.length === 0 && settingsFile().notificationState.notified.includes(sup), [t7.body, t8.body]);

  await seeded(() => settle(first));
  const gone = await api('POST', '/v1/notifications/take', {});
  await seeded(() => {
    const db = new sqlite.DatabaseSync(join(home, 'tandemise.db'));
    try { db.prepare("UPDATE approvals SET status = 'PENDING' WHERE id = ?").run(first); } finally { db.close(); }
  });
  check('the first card left the Inbox: nothing', gone.body.notices.length === 0, gone.body);
  const t9 = await api('POST', '/v1/notifications/take', {});
  check('a card that left and came back with the same id: no repeat', t9.body.notices.length === 0, t9.body);

  // Quiet hours around the daemon's own clock, then the test clock moves past them.
  const now = (await api('POST', '/v1/test/clock', { advanceMs: 0 })).body.now;
  const nowMs = Date.parse(now);
  const q = await api('PUT', '/v1/notifications/preferences', { quietHours: { from: hhmm(nowMs - 30 * 60_000), to: hhmm(nowMs + 60 * 60_000) } });
  check('quiet hours set around now: quietNow', q.status === 200 && q.body.quietNow === true, q.body);
  const quietCard = await seeded(() => addCard(ws, 'Arrived at night'));
  const t10 = await api('POST', '/v1/notifications/take', {});
  check('during quiet hours: nothing, and the card is held', t10.body.notices.length === 0 && settingsFile().notificationState.held.includes(quietCard), [t10.body, settingsFile().notificationState.held]);
  await api('POST', '/v1/test/clock', { advanceMs: 2 * 3_600_000 });
  const p1 = await api('GET', '/v1/notifications/preferences');
  check('two hours later: quiet hours are over', p1.body.quietNow === false, p1.body);
  const t11 = await api('POST', '/v1/notifications/take', {});
  check('one summary "After quiet hours: 1 thing needs you"', t11.body.notices.length === 1 && t11.body.notices[0].title === 'After quiet hours: 1 thing needs you' && t11.body.notices[0].shape === 'summary', t11.body);
  const t12 = await api('POST', '/v1/notifications/take', {});
  check('and nothing after it', t12.body.notices.length === 0, t12.body);
  const cleared = await api('PUT', '/v1/notifications/preferences', { quietHours: null });
  check('quiet hours cleared with null', cleared.body.quietHours === null, cleared.body);
} catch (e) {
  failures.push(`threw: ${e?.stack ?? e}`);
  console.log(e);
} finally {
  await daemon?.stop();
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) { console.log(failures.map((f) => `  - ${f}`).join('\n')); process.exit(1); }
console.log('ALL P16 NOTIFY CHECKS PASSED');
