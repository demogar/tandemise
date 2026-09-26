// P0 members, team tree and responsibility. Pure rules first, then persistence,
// engine and HTTP sections appended by later tasks.
//
//   npm run build && node scratch/staffing-check.mjs
import {
  indexTeam, mergeStaffing, resolveStaffing, responsibleFor, escalationChain, signOffLead,
  reviewersFor, validateStaffing, validateTeam, BASE_STAFFING, DEFAULT_ESCALATE_AFTER_MS, nextEscalation,
} from '../packages/domain/dist/index.js';

let passed = 0;
const failures = [];
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failures.push(label); console.log(`  FAIL ${label}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`); }
};
const section = (t) => console.log(`\n== ${t}`);
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const T = '2026-09-13T00:00:00.000Z';
const person = (id, over = {}) => ({
  id, workspaceId: 'ws_1', kind: 'person', personId: `per_${id}`, name: id, title: null,
  reportsTo: null, access: 'member', oversight: 'delegate_owns', roleIds: [], runtimeProfileIds: [],
  integrationIds: [], status: 'active', createdAt: T, updatedAt: T, ...over,
});
const agent = (id, owner, over = {}) => ({
  ...person(id), kind: 'agent', personId: null, access: null, reportsTo: owner,
  roleIds: ['design'], runtimeProfileIds: ['rt_fake'], ...over,
});

section('domain: merge');
{
  const s = mergeStaffing({ assignees: ['a'], reviews: [{ by: 'responsible', mode: 'blocking', when: 'always' }] }, { mode: 'pool' }, undefined, { responsible: 'r' });
  check('later layers override field by field', s.assignees[0] === 'a' && s.mode === 'pool' && s.responsible === 'r' && s.reviews.length === 1, s);
  check('base fills unspecified fields', eq(mergeStaffing(), BASE_STAFFING) && BASE_STAFFING.escalateAfterMs === DEFAULT_ESCALATE_AFTER_MS);
  check('explicit empty array overrides', mergeStaffing({ reviews: [{ by: 'responsible', mode: 'after', when: 'always' }] }, { reviews: [] }).reviews.length === 0);
}

// Team: owner Demo; Maria (lead, reports to Demo); Ana reports to Maria; Ana's agent; Bo reports to Demo.
const demo = person('demo', { access: 'owner' });
const maria = person('maria', { reportsTo: 'demo', title: 'Director of Design' });
const ana = person('ana', { reportsTo: 'maria' });
const bo = person('bo', { reportsTo: 'demo' });
const anaAgent = agent('ana_figma', 'ana');
const mariaAgent = agent('maria_od', 'maria');
const team = indexTeam([demo, maria, ana, bo, anaAgent, mariaAgent]);

section('domain: responsibility');
{
  const agentRes = resolveStaffing({ team, roleId: 'design', humanStep: false, layers: { workspace: { assignees: ['ana_figma'] } } });
  check('agent assignee -> executor agent, owner responsible', agentRes.executor === 'agent' && agentRes.agentCandidates[0]?.id === 'ana_figma' && agentRes.responsibleId === 'ana', agentRes);
  const personRes = resolveStaffing({ team, roleId: 'design', humanStep: false, layers: { workspace: { assignees: ['bo'] } } });
  check('person assignee -> executor human, assigned, responsible self', personRes.executor === 'human' && personRes.assigneeId === 'bo' && personRes.responsibleId === 'bo', personRes);
  const delegated = resolveStaffing({ team, roleId: 'design', humanStep: false, layers: { workspace: { assignees: ['maria_od'] }, mission: { responsible: 'ana' } } });
  check('explicit responsible wins (delegation)', delegated.responsibleId === 'ana', delegated);
  const none = resolveStaffing({ team: indexTeam([demo]), roleId: 'qa', humanStep: false, layers: {} });
  check('nothing staffed -> legacy runtime fallback, owner responsible', none.executor === 'agent' && none.agentCandidates.length === 0 && none.responsibleId === 'demo', none);
  const builtIn = resolveStaffing({ team, roleId: 'design', humanStep: false, layers: {} });
  check('built-in: active agents with the role', builtIn.agentCandidates.map((m) => m.id).join() === 'ana_figma,maria_od', builtIn.agentCandidates.map((m) => m.id));
  const human = resolveStaffing({ team, roleId: 'design', humanStep: true, layers: {} });
  // F2: a pool only one person can claim is that person's; a lone owner does not claim their own step.
  check('human step hint, one owner -> the owner is the assignee', human.executor === 'human' && human.assigneeId === 'demo' && eq(human.claimable, ['demo']) && human.responsibleId === 'demo', human);
  const twoOwners = indexTeam([demo, { ...maria, access: 'owner', reportsTo: null }]);
  const humanTwo = resolveStaffing({ team: twoOwners, roleId: 'design', humanStep: true, layers: {} });
  check('human step hint, two owners -> unassigned pool claimable by both', humanTwo.assigneeId === null && eq(humanTwo.claimable, ['demo', 'maria']), humanTwo);
  const poolOfOne = resolveStaffing({ team, roleId: 'qa', humanStep: false, layers: { workspace: { assignees: ['bo'], mode: 'pool' } } });
  check('explicit pool of one person -> that person is the assignee', poolOfOne.executor === 'human' && poolOfOne.assigneeId === 'bo' && eq(poolOfOne.claimable, ['bo']) && poolOfOne.responsibleId === 'bo', poolOfOne);
  const poolOneLeft = resolveStaffing({ team: indexTeam([demo, maria, ana, { ...bo, status: 'removed' }]), roleId: 'qa', humanStep: false, layers: { workspace: { assignees: ['ana', 'bo'], mode: 'pool' } } });
  check('pool of two with one removed -> the one left is the assignee', poolOneLeft.assigneeId === 'ana' && eq(poolOneLeft.claimable, ['ana']), poolOneLeft);
  const pool = resolveStaffing({ team, roleId: 'qa', humanStep: false, layers: { workspace: { assignees: ['ana', 'bo'], mode: 'pool' } } });
  check('pool of people -> claimable, owner responsible until claimed', pool.executor === 'human' && pool.assigneeId === null && eq(pool.claimable, ['ana', 'bo']) && pool.responsibleId === 'demo', pool);
  check('responsibleFor after claim', responsibleFor(team, pool.staffing, 'bo') === 'bo');

  // A person's step only goes to an agent someone put on this mission or task.
  const wsAgentHuman = resolveStaffing({ team, roleId: 'design', humanStep: true, layers: { workspace: { assignees: ['ana_figma'] } } });
  check('human step: a workspace-staffed agent does not take it; owners\' pool',
    wsAgentHuman.executor === 'human' && wsAgentHuman.assigneeId === 'demo' && eq(wsAgentHuman.claimable, ['demo']) && wsAgentHuman.agentCandidates.length === 0, wsAgentHuman);
  const taskAgentHuman = resolveStaffing({ team, roleId: 'design', humanStep: true, layers: { workspace: { assignees: ['ana_figma'] }, task: { assignees: ['ana_figma'] } } });
  check('human step: a task override to an agent does put the agent on it', taskAgentHuman.executor === 'agent' && taskAgentHuman.agentCandidates[0]?.id === 'ana_figma', taskAgentHuman);
  const missionAgentHuman = resolveStaffing({ team, roleId: 'design', humanStep: true, layers: { mission: { assignees: ['maria_od'] } } });
  check('human step: a mission override to an agent does too', missionAgentHuman.executor === 'agent' && missionAgentHuman.agentCandidates[0]?.id === 'maria_od', missionAgentHuman);
  const wsPersonPool = resolveStaffing({ team, roleId: 'design', humanStep: true, layers: { workspace: { assignees: ['ana', 'ana_figma'] } } });
  check('human step: workspace people still apply (a pool of just Ana is Ana\'s)',
    wsPersonPool.executor === 'human' && wsPersonPool.assigneeId === 'ana' && eq(wsPersonPool.claimable, ['ana']), wsPersonPool);
  const wsPersonFirst = resolveStaffing({ team, roleId: 'design', humanStep: true, layers: { workspace: { assignees: ['ana'], mode: 'first_available' } } });
  check('human step: workspace people with first_available assign Ana', wsPersonFirst.executor === 'human' && wsPersonFirst.assigneeId === 'ana' && wsPersonFirst.responsibleId === 'ana', wsPersonFirst);
}

section('domain: inactive members');
{
  const removedAna = indexTeam([demo, maria, { ...ana, status: 'removed' }, bo, anaAgent, mariaAgent]);
  const r = resolveStaffing({ team: removedAna, roleId: 'design', humanStep: false, layers: { workspace: { assignees: ['ana_figma', 'maria_od'] } } });
  check('agent of a removed owner is skipped', r.agentCandidates.map((m) => m.id).join() === 'maria_od' && r.responsibleId === 'maria', r);
  const none = resolveStaffing({ team: removedAna, roleId: 'design', humanStep: false, layers: { workspace: { assignees: ['ana_figma'], responsible: 'maria' } } });
  check('I7: every named assignee inactive -> an unassigned pool for the responsible person\'s chain, not the runtime fallback',
    none.executor === 'human' && none.assigneeId === null && eq(none.claimable, ['maria', 'demo']) && none.responsibleId === 'maria' && eq(none.inactiveAssignees, ['ana_figma']), none);
  const unnamed = resolveStaffing({ team: removedAna, roleId: 'qa', humanStep: false, layers: {} });
  check('I7: nothing named at all keeps the runtime fallback', unnamed.executor === 'agent' && unnamed.agentCandidates.length === 0 && unnamed.inactiveAssignees === undefined, unnamed);
}

section('domain: escalation and sign-off');
{
  check('chain walks reportsTo then owners, deduped', eq(escalationChain(team, 'ana'), ['ana', 'maria', 'demo']), escalationChain(team, 'ana'));
  check('no sign-off lead by default', signOffLead(team, 'ana') === null);
  check('nextEscalation: from the responsible person, one step up', nextEscalation(team, 'ana', ['ana']) === 'maria');
  check('nextEscalation: above the highest-ranked addressee', nextEscalation(team, 'ana', ['ana', 'maria']) === 'demo');
  check('nextEscalation: a card to the lead goes up to the owner, never down to Ana', nextEscalation(team, 'ana', ['maria']) === 'demo', nextEscalation(team, 'ana', ['maria']));
  check('nextEscalation: the order of addressees does not matter', nextEscalation(team, 'ana', ['maria', 'ana']) === 'demo');
  check('nextEscalation: nothing above the owner', nextEscalation(team, 'ana', ['demo']) === null && nextEscalation(team, 'ana', ['ana', 'maria', 'demo']) === null);
  check('nextEscalation: no addressee in the chain starts at the responsible person', nextEscalation(team, 'ana', ['bo']) === 'ana' && nextEscalation(team, 'ana', []) === 'ana',
    [nextEscalation(team, 'ana', ['bo']), nextEscalation(team, 'ana', [])]);
  const strict = indexTeam([demo, { ...maria, oversight: 'both_sign_off' }, ana, bo, anaAgent, mariaAgent]);
  check('both_sign_off lead returned', signOffLead(strict, 'ana') === 'maria');
  check('reviewers: responsible', eq(reviewersFor(team, { by: 'responsible', mode: 'blocking', when: 'always' }, 'ana'), ['ana']));
  check('reviewers: explicit, inactive dropped, falls back to responsible',
    eq(reviewersFor(indexTeam([demo, { ...bo, status: 'removed' }]), { by: ['bo'], mode: 'blocking', when: 'always' }, 'demo'), ['demo']));
}

section('domain: validation');
{
  check('valid staffing has no issues', validateStaffing(team, { assignees: ['ana_figma'], responsible: 'ana', reviews: [{ by: ['maria'], mode: 'after', when: 'task.risk_level >= 2' }] }).length === 0);
  const issues = validateStaffing(team, { assignees: ['ghost'], responsible: 'ana_figma', reviews: [{ by: ['maria_od'], mode: 'blocking', when: 'task.risk_level >=' }] });
  check('unknown assignee, agent responsible, agent reviewer, bad gate all reported', issues.length === 4, issues);
  check('team without owner is invalid', validateTeam([maria]).some((i) => i.includes('owner')), validateTeam([maria]));
  check('cycle is invalid', validateTeam([demo, { ...maria, reportsTo: 'ana' }, ana]).some((i) => i.includes('cycle')));
  const selfIssues = validateTeam([{ ...demo, reportsTo: 'demo' }, maria, ana, bo]);
  check('F13: a self-reference is reported once, as such, not as a cycle for everyone below it',
    eq(selfIssues, ['demo: cannot report to themselves.']), selfIssues);
  check('agent owned by agent is invalid', validateTeam([demo, agent('x', 'ana_figma'), anaAgent, ana, maria]).some((i) => i.includes('person')));
  check('agent with reports is invalid', validateTeam([demo, anaAgent, ana, maria, person('z', { reportsTo: 'ana_figma' })]).some((i) => i.includes('reports')));
}

section('persistence: migration 008 backfill');
{
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const P = await import('../packages/persistence/dist/index.js');
  const dir = mkdtempSync(join(tmpdir(), 'tandemise-staffing-'));
  const db = P.openDatabase({ path: join(dir, 't.db') });
  P.migrate(db, undefined, P.MIGRATIONS.slice(0, 7));
  const h = db.handle;
  const now = '2026-09-13T00:00:00.000Z';
  process.env.TANDEMISE_OWNER_NAME = 'Legacy Owner';
  h.prepare(`INSERT INTO workspaces (id,name,default_repository_id,autonomy,concurrency,routing,default_autonomy_level,knowledge,created_at,updated_at)
             VALUES ('ws_a','A',NULL,'{}','{}',?, 'supervised','{}',?,?)`).run(JSON.stringify({ design: ['rt_1', 'rt_2'], development: ['rt_3'], qa: [] }), now, now);
  h.prepare(`INSERT INTO workspaces (id,name,default_repository_id,autonomy,concurrency,routing,default_autonomy_level,knowledge,created_at,updated_at)
             VALUES ('ws_b','B',NULL,'{}','{}','{}','supervised','{}',?,?)`).run(now, now);
  h.prepare(`INSERT INTO missions (id,workspace_id,title,goal,constraints,success_criteria,status,autonomy,workflow_preset,created_at,updated_at)
             VALUES ('m_a','ws_a','T','G','[]','[]','EXECUTING','balanced','standard',?,?)`).run(now, now);
  h.prepare(`INSERT INTO mission_tasks (id,mission_id,key,title,objective,role_id,required_capabilities,input_artifacts,expected_outputs,execution_policy,approval_policy,retry_policy,status,created_at,updated_at)
             VALUES ('t_a','m_a','k','T','O','design','[]','[]','[]','{}','{}','{}','SUCCEEDED',?,?)`).run(now, now);
  // The run's assignment, profile and target are not part of this fixture; only
  // its role matters to the author backfill, so references are off while it lands.
  h.pragma('foreign_keys = OFF');
  h.prepare(`INSERT INTO runs (id,mission_id,task_id,assignment_id,attempt,status,role_id,runtime_profile_id,execution_target_id,started_at)
             VALUES ('r_a','m_a','t_a','as_a',1,'SUCCEEDED','design','rt_1','tg_a',?)`).run(now);
  h.pragma('foreign_keys = ON');
  h.prepare(`INSERT INTO approvals (id,workspace_id,mission_id,kind,status,risk,title,rationale,effect,evidence,options,decided_by,created_at,decided_at)
             VALUES ('ap_a','ws_a','m_a','plan','APPROVED','read','t','r','e','[]','[]','user',?,?)`).run(now, now);
  const artifact = h.prepare(`INSERT INTO artifacts (id,workspace_id,mission_id,task_id,created_by_run_id,type,title,content_ref,media_type,sha256,byte_size,schema_version,created_at)
             VALUES (?,'ws_a','m_a',NULL,?,'ChangeSet',?,'c','text/markdown','x',1,1,?)`);
  artifact.run('ar_run', 'r_a', 'by design run', now);
  artifact.run('ar_gone', 'r_missing', 'by vanished run', now);
  artifact.run('ar_none', null, 'by nobody', now);

  P.migrate(db);
  check('schema is at the new version', P.schemaVersion(db) === P.SCHEMA_VERSION && P.SCHEMA_VERSION >= 9, P.SCHEMA_VERSION);
  const people = h.prepare('SELECT * FROM people').all();
  check('one local person created', people.length === 1 && people[0].display_name === 'Legacy Owner', people);
  const members = h.prepare("SELECT * FROM members WHERE workspace_id='ws_a' ORDER BY kind DESC, name").all();
  const owner = members.find((m) => m.kind === 'person');
  check('workspace owner member created', owner?.access === 'owner' && owner.person_id === people[0].id && owner.name === 'Legacy Owner', members);
  const agents = members.filter((m) => m.kind === 'agent');
  check('routing became agent members owned by the owner', agents.length === 2 && agents.every((a) => a.reports_to === owner.id), agents);
  const design = agents.find((a) => JSON.parse(a.role_ids)[0] === 'design');
  check('agent keeps ranked runtimes', JSON.parse(design.runtime_profile_ids).join() === 'rt_1,rt_2');
  check('agent is named after its role', design.name === 'Design agent', design.name);
  const staffing = JSON.parse(h.prepare("SELECT staffing FROM workspaces WHERE id='ws_a'").get().staffing);
  check('workspace staffing points roles at those agents', staffing.design.assignees[0] === design.id && staffing.development.assignees.length === 1 && staffing.qa === undefined, staffing);
  const wsB = h.prepare("SELECT * FROM members WHERE workspace_id='ws_b'").all();
  check('a workspace without routing still gets an owner', wsB.length === 1 && wsB[0].kind === 'person', wsB);
  const approval = h.prepare("SELECT decided_by FROM approvals WHERE decided_by IS NOT NULL").get();
  check("decided_by 'user' became the owner member", approval?.decided_by === owner.id, approval);
  check('missions record the owner as creator', h.prepare("SELECT created_by FROM missions WHERE id='m_a'").get().created_by === owner.id);
  const art = Object.fromEntries(h.prepare('SELECT id, author_id, responsible_id FROM artifacts').all().map((r) => [r.id, r]));
  check('artifacts are the owner\'s responsibility', Object.values(art).every((a) => a.responsible_id === owner.id), art);
  check('a run artifact is authored by the role agent', art.ar_run.author_id === design.id, art.ar_run);
  check('an artifact of an unknown run is authored by the runtime', art.ar_gone.author_id === 'system:runtime', art.ar_gone);
  check('an artifact with no run has no author', art.ar_none.author_id === null, art.ar_none);
  let checkKind = null;
  try {
    h.prepare(`INSERT INTO approvals (id,workspace_id,kind,status,risk,title,rationale,effect,evidence,options,created_at)
               VALUES ('ap_c','ws_a','check','PENDING','read','t','r','e','[]','[]',?)`).run(now);
  } catch (e) { checkKind = String(e.message ?? e); }
  check("approvals accept kind 'check'", checkKind === null, checkKind);
  let badKind = null;
  try {
    h.prepare(`INSERT INTO approvals (id,workspace_id,kind,status,risk,title,rationale,effect,evidence,options,created_at)
               VALUES ('ap_x','ws_a','nope','PENDING','read','t','r','e','[]','[]',?)`).run(now);
  } catch (e) { badKind = String(e.message ?? e); }
  check('approvals still reject an unknown kind', badKind !== null);
  check('artifact FTS triggers still fire', h.prepare("SELECT count(*) c FROM artifacts_fts WHERE artifacts_fts MATCH 'vanished'").get().c === 1);
  check('integrity_check is clean', h.pragma('integrity_check', { simple: true }) === 'ok');
  // 008 and 009 ran back to back above; 009 recreates the FTS table over rows 008 just backfilled.
  let ftsAfterBoth = true;
  try { h.prepare("INSERT INTO artifacts_fts (artifacts_fts) VALUES ('integrity-check')").run(); } catch (e) { ftsAfterBoth = String(e.message ?? e); }
  check('after 008 and 009 back to back, the FTS index agrees with the artifacts table', ftsAfterBoth === true, ftsAfterBoth);
  let agentWithoutOwner = null;
  try {
    h.prepare(`INSERT INTO members (id,workspace_id,kind,name,created_at,updated_at) VALUES ('mem_x','ws_a','agent','x',?,?)`).run(now, now);
  } catch (e) { agentWithoutOwner = String(e.message ?? e); }
  check('an agent without an owner is rejected by the schema', agentWithoutOwner !== null);
  P.migrate(db);
  check('re-running migrate is a no-op', h.prepare('SELECT count(*) c FROM people').get().c === 1);
  db.close();
  delete process.env.TANDEMISE_OWNER_NAME;
}

section('persistence: repositories round-trip');
{
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { ids, systemClock } = await import('../packages/shared/dist/index.js');
  const { Container, compose } = await import('../packages/kernel/dist/index.js');
  const P = await import('../packages/persistence/dist/index.js');
  const dir = mkdtempSync(join(tmpdir(), 'tandemise-staffing-repo-'));
  const container = new Container();
  compose(container, P.persistenceModule({ path: join(dir, 't.db'), clock: systemClock }));
  const people = container.resolve(P.PERSON_REPOSITORY);
  const members = container.resolve(P.MEMBER_REPOSITORY);
  const workspaces = container.resolve(P.WORKSPACE_REPOSITORY);
  const missions = container.resolve(P.MISSION_REPOSITORY);
  const tasks = container.resolve(P.TASK_REPOSITORY);
  const approvals = container.resolve(P.APPROVAL_REPOSITORY);
  const artifacts = container.resolve(P.ARTIFACT_REPOSITORY);
  const runs = container.resolve(P.RUN_REPOSITORY);
  const events = container.resolve(P.EVENT_REPOSITORY);
  const db = container.resolve(P.DATABASE);
  const now = () => systemClock.now();

  const wsId = ids.workspace();
  const ws = workspaces.create({
    id: wsId, name: 'W', defaultRepositoryId: null,
    autonomy: { planApproval: 'ask', localCodeChanges: 'auto', externalWrites: 'policy', productionRelease: 'ask', financialActions: 'deny' },
    concurrency: { maxTotalWorkers: 3, perRuntime: {} }, routing: {}, defaultAutonomyLevel: 'balanced',
    knowledge: { productVision: null, architecturePrinciples: null, codingStandards: null, designSystem: null, glossary: null },
    staffing: { design: { assignees: ['mem_a'], mode: 'pool' } },
  });
  check('workspace staffing round-trips', eq(workspaces.get(wsId).staffing, ws.staffing), workspaces.get(wsId).staffing);
  const wsPatched = workspaces.update(wsId, { staffing: { qa: { responsible: null } } });
  check('workspace staffing updates through applyPatch', eq(workspaces.get(wsId).staffing, { qa: { responsible: null } }) && eq(wsPatched.staffing, { qa: { responsible: null } }));

  // Migrating a fresh database already created the local person.
  const peopleBefore = people.list().length;
  const perId = ids.person();
  const person = people.create({ id: perId, displayName: 'Ana', handles: { github: 'ana' }, accountId: null });
  check('person create stamps timestamps', typeof person.createdAt === 'string' && person.removedAt === null);
  check('person get round-trips every field', eq(people.get(perId), person), people.get(perId));
  const renamed = people.update(perId, { displayName: 'Ana B', handles: { github: 'anab', slack: 'U1' }, accountId: 'acc_1' });
  check('person update round-trips', eq(people.get(perId), renamed) && renamed.handles.slack === 'U1' && renamed.accountId === 'acc_1');
  const otherPer = people.create({ id: ids.person(), displayName: 'Bo', handles: {}, accountId: null });
  people.update(otherPer.id, { removedAt: now() });
  check('person list hides removed people by default', people.list().length === peopleBefore + 1 && people.list({ includeRemoved: true }).length === peopleBefore + 2);
  check('person get of unknown id is undefined', people.get('per_nope') === undefined);

  const ownerId = ids.member();
  const owner = members.create({
    id: ownerId, workspaceId: wsId, kind: 'person', personId: perId, name: 'Ana B', title: null,
    reportsTo: null, access: 'owner', oversight: 'delegate_owns', roleIds: [], runtimeProfileIds: [],
    integrationIds: [], status: 'active',
  });
  check('member get round-trips every field incl. nulls', eq(members.get(ownerId), owner), members.get(ownerId));
  const agentId = ids.member();
  const agent = members.create({
    id: agentId, workspaceId: wsId, kind: 'agent', personId: null, name: 'Figma agent', title: 'Designer',
    reportsTo: ownerId, access: null, oversight: 'delegate_owns', roleIds: ['design', 'ux'],
    runtimeProfileIds: ['rt_1', 'rt_2'], integrationIds: ['int_figma'], status: 'active',
  });
  check('agent member round-trips JSON arrays', eq(members.get(agentId), agent), members.get(agentId));
  const updated = members.update(agentId, { title: null, runtimeProfileIds: ['rt_2'], status: 'removed' });
  check('member update round-trips', eq(members.get(agentId), updated) && updated.title === null && updated.status === 'removed' && updated.kind === 'agent');
  check('listByWorkspace hides removed members by default',
    members.listByWorkspace(wsId).length === 1 && members.listByWorkspace(wsId, { includeRemoved: true }).length === 2);
  check('findPersonMember finds the seat', members.findPersonMember(wsId, perId)?.id === ownerId && members.findPersonMember(wsId, otherPer.id) === undefined);

  const mId = ids.mission();
  const mission = missions.create({ id: mId, workspaceId: wsId, repositoryId: null, title: 'M', goal: 'g', createdBy: ownerId, staffing: { design: { responsible: ownerId } } });
  check('mission createdBy and staffing round-trip', missions.get(mId).createdBy === ownerId && eq(missions.get(mId).staffing, mission.staffing));
  const legacyMission = missions.create({ id: ids.mission(), workspaceId: wsId, repositoryId: null, title: 'L', goal: 'g' });
  check('mission without actor defaults', legacyMission.createdBy === null && eq(missions.get(legacyMission.id).staffing, {}));

  const tId = ids.task();
  const baseTask = {
    id: tId, missionId: mId, key: 'k', title: 'T', objective: 'o', roleId: 'design', dependsOn: [],
    requiredCapabilities: [], inputArtifacts: [], expectedOutputs: [],
    executionPolicy: { isolation: 'none', maxWallTimeMs: 1000, capabilities: [] },
    approvalPolicy: { beforeStart: false, onCompletion: false }, retryPolicy: { maxAttempts: 1, backoffMs: 0, onExhausted: 'fail' },
    completionGate: null, status: 'READY', statusReason: null, attempts: 0, remediatesTaskId: null,
    repositoryId: null, executor: 'agent', waitPolicy: null, orderHint: 0,
    createdAt: now(), updatedAt: now(), startedAt: null, finishedAt: null,
  };
  tasks.add(baseTask);
  const legacyTask = tasks.get(tId);
  check('task without staffing fields reads defaults',
    legacyTask.staffing === null && legacyTask.staffingOverride === null && legacyTask.assigneeId === null
    && legacyTask.responsibleId === null && legacyTask.needsAttention === false, legacyTask);
  const snapshot = { staffing: { assignees: [agentId], mode: 'first_available', responsible: ownerId, reviews: [], escalateAfterMs: 1, notify: [] }, executor: 'agent', claimable: [], agentCandidateIds: [agentId] };
  const t2 = tasks.update(tId, { staffing: snapshot, staffingOverride: { mode: 'pool' }, assigneeId: agentId, responsibleId: ownerId, needsAttention: true });
  const t2r = tasks.get(tId);
  check('task staffing fields round-trip', eq(t2r.staffing, snapshot) && eq(t2r.staffingOverride, { mode: 'pool' })
    && t2r.assigneeId === agentId && t2r.responsibleId === ownerId && t2r.needsAttention === true && t2.needsAttention === true, t2r);

  // The run's assignment and target are outside this fixture; only its columns matter here.
  db.handle.pragma('foreign_keys = OFF');
  const rId = ids.run();
  runs.create({
    id: rId, missionId: mId, taskId: tId, assignmentId: 'as_x', attempt: 1, status: 'RUNNING', roleId: 'design',
    runtimeProfileId: 'rt_1', executionTargetId: 'tg_x', externalSessionId: null, pid: null, exitCode: null,
    errorCode: null, errorMessage: null, usage: null, startedAt: now(), finishedAt: null, heartbeatAt: null, agentMemberId: agentId,
  });
  check('run agentMemberId round-trips', runs.get(rId).agentMemberId === agentId);
  check('run agentMemberId updates', runs.update(rId, { agentMemberId: null }).agentMemberId === null && runs.get(rId).agentMemberId === null);
  db.handle.pragma('foreign_keys = ON');

  const ev = events.append({ id: ids.event(), workspaceId: wsId, missionId: mId, body: { type: 'note', text: 'hi' }, createdAt: now(), actorId: ownerId });
  check('event actorId round-trips', ev.actorId === ownerId && events.listByMission(mId)[0].actorId === ownerId);
  const ev2 = events.append({ id: ids.event(), workspaceId: wsId, missionId: mId, body: { type: 'note', text: 'hi' }, createdAt: now() });
  check('event without actor reads null', ev2.actorId === null && events.listByMission(mId)[1].actorId === null);

  const aId = ids.artifact();
  artifacts.create({
    id: aId, workspaceId: wsId, missionId: mId, taskId: tId, createdByRunId: rId, type: 'DesignBrief', title: 'Brief',
    contentRef: 'c', mediaType: 'text/markdown', sha256: 'x', byteSize: 1, schemaVersion: 1, sourceRefs: [],
    supersedes: null, summary: null, createdAt: now(), authorId: agentId, responsibleId: ownerId, recordedBy: 'system',
  });
  const ar = artifacts.get(aId);
  check('artifact actor fields round-trip', ar.authorId === agentId && ar.responsibleId === ownerId && ar.recordedBy === 'system', ar);

  const apId = ids.approval();
  const escalateAt = now();
  approvals.create({
    id: apId, workspaceId: wsId, missionId: mId, taskId: tId, runId: null, kind: 'check', status: 'PENDING', risk: 'read',
    title: 't', rationale: 'r', effect: 'e', evidence: [], options: [], recommendedOptionId: null, selectedOptionId: null,
    decidedBy: null, decisionNote: null, createdAt: now(), decidedAt: null, expiresAt: null,
    addressees: [ownerId, 'mem_b'], escalationLevel: 1, escalateAt, recordedBy: agentId,
  });
  const ap = approvals.get(apId);
  check('approval of kind check with addressees round-trips',
    ap.kind === 'check' && eq(ap.addressees, [ownerId, 'mem_b']) && ap.escalationLevel === 1 && ap.escalateAt === escalateAt && ap.recordedBy === agentId, ap);
  const ap2 = approvals.update(apId, { addressees: [], escalationLevel: 2, escalateAt: null });
  check('approval escalation fields update', eq(approvals.get(apId), ap2) && ap2.escalateAt === null && ap2.escalationLevel === 2);
  await container.dispose();
}

section('services: identity, team and staffing');
{
  const { mkdtempSync, mkdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { Container, compose } = await import('@tandemise/kernel');
  const { createLogger, createPaths, systemClock, ids } = await import('@tandemise/shared');
  const persistenceTokens = await import('@tandemise/persistence');
  const { persistenceModule } = persistenceTokens;
  const { createArtifactsModule, ARTIFACT_STORE: ARTIFACTS_STORE_TOKEN, renderArtifactTemplate, parseArtifact, measureArtifact, deriveHandoff, splitAppendix } = await import('@tandemise/artifacts');
  const { policyModule } = await import('@tandemise/policy');
  const { contextModule } = await import('@tandemise/context');
  const { createEvaluationModule } = await import('@tandemise/evaluation');
  const { runtimesCoreModule } = await import('@tandemise/runtimes-core');
  const { genericRuntimeModule, FAKE_ADAPTER_ID } = await import('@tandemise/runtime-generic');
  const { executionCoreModule, CLOCK: EXEC_CLOCK, LOGGER: EXEC_LOGGER, PATHS: EXEC_PATHS } = await import('@tandemise/execution-core');
  const { executionLocalModule } = await import('@tandemise/execution-local');
  const { integrationsCoreModule, CLOCK: INT_CLOCK, LOGGER: INT_LOGGER } = await import('@tandemise/integrations-core');
  const app = await import('@tandemise/application');

  const HOME = mkdtempSync(join(tmpdir(), 'tandemise-staffing-svc-'));
  const paths = createPaths(HOME);
  mkdirSync(paths.root, { recursive: true });
  const log = createLogger({ level: 'error', base: { component: 'staffing-check' } });
  const container = new Container();
  compose(
    container,
    persistenceModule({ path: paths.db, logger: log }),
    createArtifactsModule({ paths }),
    policyModule, contextModule, createEvaluationModule(), runtimesCoreModule, genericRuntimeModule,
    executionCoreModule, executionLocalModule, integrationsCoreModule, app.createApplicationModule({ localPersonName: 'Demo' }),
  );
  container.bind(EXEC_CLOCK, () => systemClock, { source: 'check' });
  container.bind(EXEC_LOGGER, () => log, { source: 'check' });
  container.bind(EXEC_PATHS, () => paths, { source: 'check' });
  container.bind(INT_CLOCK, () => systemClock, { source: 'check' });
  container.bind(INT_LOGGER, () => log, { source: 'check' });
  const isToken = (v) => typeof v === 'object' && v !== null && typeof v.description === 'string';
  for (const name of Object.keys(app)) {
    const appToken = app[name]; const provider = persistenceTokens[name];
    if (!isToken(appToken) || !isToken(provider)) continue;
    if (!container.has(provider) || container.has(appToken)) continue;
    container.bind(appToken, (r) => r.resolve(provider), { source: `alias:${name}` });
  }
  container.bind(app.ARTIFACT_STORE, (r) => r.resolve(ARTIFACTS_STORE_TOKEN), { source: 'alias' });
  container.bind(app.ARTIFACT_TEMPLATES, () => ({ render: renderArtifactTemplate }), { source: 'check' });
  container.bind(app.ARTIFACT_PARSER, () => ({ parse: parseArtifact }), { source: 'check' });
  container.bind(app.ARTIFACT_MEASURE, () => ({ measure: measureArtifact, deriveHandoff, splitAppendix }), { source: 'check' });
  container.bind(app.EVENT_BUS, () => ({ publish: () => {}, subscribe: () => () => {} }), { source: 'check' });
  container.bind(app.PROJECTION_BUS, () => ({ invalidate: () => {}, subscribe: () => () => {} }), { source: 'check' });
  container.bind(app.SECRET_STORE, () => ({ backend: 'memory', store: async () => 'x', resolve: async () => undefined, remove: async () => {}, list: async () => [] }), { source: 'check' });
  container.bind(app.SETTINGS_STORE, () => app.createMemorySettingsStore(), { source: 'check' });
  container.bind(app.SYSTEM_ENVIRONMENT, () => app.describeEnvironment({ home: HOME, schemaVersion: 1 }), { source: 'check' });
  container.bind(app.PROCESS_LIVENESS, () => app.osProcessLiveness, { source: 'check' });

  const services = app.createServices(container);
  const code = (fn) => { try { fn(); return null; } catch (e) { return e.code ?? String(e); } };
  const error = (fn) => { try { fn(); return null; } catch (e) { return e; } };

  const local = services.identity.localPerson();
  check('identity: a local person exists', typeof local?.id === 'string' && local.id.startsWith('per_'), local);
  check('identity: localPerson is stable', services.identity.localPerson().id === local.id);
  const created = [];
  const emptyPeople = { list: () => created, create: (p) => { const e = { ...p, createdAt: 'now', removedAt: null }; created.push(e); return e; } };
  const fresh = new app.LocalIdentity(emptyPeople, 'Named').localPerson();
  check('identity: with no people, one is created with the given name, once',
    fresh.displayName === 'Named' && new app.LocalIdentity(emptyPeople, 'Other').localPerson().id === fresh.id && created.length === 1, created);
  const removedLocal = { list: () => [{ ...fresh, removedAt: 'then' }, { ...fresh, id: 'per_next', removedAt: null }], create: () => { throw new Error('must not create'); } };
  check('identity: a removed local person is an error, not a silent switch', code(() => new app.LocalIdentity(removedLocal).localPerson()) === 'PRECONDITION_FAILED');
  const caller = { personId: local.id };

  const view = await services.workspaces.create(caller, { name: 'Staffing' });
  const ws = view.workspace.id;
  const me = services.team.me(caller);
  check('me: local person with an owner membership for the new workspace',
    me.person.id === local.id && me.memberships.length === 1 && me.memberships[0].workspaceId === ws && me.memberships[0].access === 'owner', me);
  const ownerId = me.memberships[0].memberId;

  const profile = container.resolve(app.RUNTIME_PROFILE_REPOSITORY).create({
    id: ids.runtimeProfile(), workspaceId: null, adapterId: FAKE_ADAPTER_ID, name: 'fake', executablePath: null,
    args: [], settings: {}, capabilities: [], enabled: true, maxConcurrent: 1,
    createdAt: systemClock.now(), updatedAt: systemClock.now(),
  });
  const fake = profile.id;

  const mariaPer = services.team.createPerson(caller, { displayName: 'Maria' });
  const anaPer = services.team.createPerson(caller, { displayName: 'Ana', handles: { figma: 'ana' } });
  check('people: created and listed', services.team.listPeople().some((p) => p.id === anaPer.id && p.handles.figma === 'ana'));
  const maria = services.team.addMember(caller, ws, { kind: 'person', personId: mariaPer.id, reportsTo: ownerId, title: 'Director of Design' });
  const ana = services.team.addMember(caller, ws, { kind: 'person', personId: anaPer.id, reportsTo: maria.id });
  const anaAgent = services.team.addMember(caller, ws, { kind: 'agent', name: 'Ana Figma', reportsTo: ana.id, roleIds: ['design'], runtimeProfileIds: [fake] });
  check('team: person member takes the person\'s name, agent is owned', ana.name === 'Ana' && anaAgent.ownerName === 'Ana' && anaAgent.active === true, anaAgent);
  const team1 = services.team.team(ws);
  check('team: no issues, four members, owner is the root', team1.issues.length === 0 && team1.members.length === 4 && team1.roots.includes(ownerId), team1);

  check('team: an agent reporting to an agent is VALIDATION',
    code(() => services.team.addMember(caller, ws, { kind: 'agent', name: 'Nested', reportsTo: anaAgent.id, roleIds: ['design'] })) === 'VALIDATION');
  check('team: removing the last owner is CONFLICT', code(() => services.team.removeMember(caller, ownerId)) === 'CONFLICT');

  // ---- final M2: the tree's invariants hold through every mutation, not only on add
  check('M2: a reporting cycle made through updateMember is VALIDATION', code(() => services.team.updateMember(caller, maria.id, { reportsTo: ana.id })) === 'VALIDATION',
    code(() => services.team.updateMember(caller, maria.id, { reportsTo: ana.id })));
  check('M2: and it is not written', services.team.team(ws).members.find((m) => m.id === maria.id)?.reportsTo === ownerId);
  check('M2: demoting the last owner is CONFLICT', code(() => services.team.updateMember(caller, ownerId, { access: 'admin' })) === 'CONFLICT');
  // Removing your own seat is refused on its own (I6), so the last-owner rule is checked with someone else removing the owner.
  const lastOwnerRemoval = error(() => services.team.removeMember({ personId: mariaPer.id }, ownerId));
  check('M2: another member removing the last owner is CONFLICT for that reason', lastOwnerRemoval?.code === 'CONFLICT' && /at least one owner/.test(lastOwnerRemoval.message), lastOwnerRemoval?.message);
  {
    const leaverPer = services.team.createPerson(caller, { displayName: 'Leaver' });
    const leaverSeat = services.team.addMember(caller, ws, { kind: 'person', personId: leaverPer.id, reportsTo: ownerId });
    services.team.removePerson(caller, leaverPer.id);
    const kept = services.team.team(ws).members.find((m) => m.id === leaverSeat.id);
    const keptPerson = services.team.listPeople().find((p) => p.id === leaverPer.id)
      ?? container.resolve(app.PERSON_REPOSITORY).get(leaverPer.id);
    check('M2: removePerson removes their seat but keeps the rows, so history still names them',
      kept?.status === 'removed' && kept?.name === 'Leaver' && keptPerson?.removedAt != null && services.team.me({ personId: leaverPer.id }).memberships.length === 0,
      { seat: kept && [kept.status, kept.name], removedAt: keptPerson?.removedAt });
    // final M1: a removed person cannot be brought back through their old seat.
    const revived = error(() => services.team.updateMember(caller, leaverSeat.id, { status: 'active' }));
    check('M1: reactivating the seat of a removed person is VALIDATION, as adding them is', revived?.code === 'VALIDATION', revived?.code ?? 'no error');
    check('M1: and the seat stays removed', services.team.team(ws).members.find((m) => m.id === leaverSeat.id)?.status === 'removed');
  }

  services.staffing.patchWorkspace(caller, ws, { design: { assignees: [anaAgent.id] } });
  services.staffing.patchWorkspace(caller, ws, { development: { mode: 'pool' } });
  const staffed = services.staffing.workspace(ws);
  check('staffing: per-role merge keeps other roles (A14)', eq(staffed.design?.assignees, [anaAgent.id]) && staffed.development?.mode === 'pool', staffed);
  services.staffing.patchWorkspace(caller, ws, { design: { responsible: ana.id } });
  check('staffing: fields merge within a role', eq(services.staffing.workspace(ws).design, { assignees: [anaAgent.id], responsible: ana.id }), services.staffing.workspace(ws).design);
  services.staffing.patchWorkspace(caller, ws, { development: null });
  check('staffing: null deletes a role', services.staffing.workspace(ws).development === undefined);

  services.workspaces.update(ws, { routing: { qa: [fake] } });
  const afterRouting = services.staffing.workspace(ws);
  const qaAgent = services.team.team(ws).members.find((m) => m.kind === 'agent' && m.name === 'Qa agent');
  check('routing compat: design staffing intact', eq(afterRouting.design?.assignees, [anaAgent.id]), afterRouting);
  check('routing compat: a Qa agent member is created and staffed', qaAgent !== undefined && eq(qaAgent.runtimeProfileIds, [fake]) && eq(afterRouting.qa?.assignees, [qaAgent?.id]), { qaAgent, afterRouting });
  services.workspaces.update(ws, { routing: { qa: [fake, 'rt_other'] } });
  const qaAgents = services.team.team(ws).members.filter((m) => m.kind === 'agent' && m.name === 'Qa agent');
  check('routing compat: the Qa agent is reused, not duplicated', qaAgents.length === 1 && eq(qaAgents[0].runtimeProfileIds, [fake, 'rt_other']), qaAgents);
  const wsView = services.workspaces.view(ws);
  check('routing compat: view derives routing from staffing', eq(wsView.workspace.routing.design, [fake]) && eq(wsView.workspace.routing.qa, [fake, 'rt_other']), wsView.workspace.routing);

  const bad = error(() => services.staffing.patchWorkspace(caller, ws, { design: { assignees: ['mem_ghost'] } }));
  check('staffing: unknown member is VALIDATION with the issue path', bad?.code === 'VALIDATION' && JSON.stringify(bad.details).includes('design.assignees.0'), bad?.details);
  check('staffing: a rejected patch writes nothing', eq(services.staffing.workspace(ws).design?.assignees, [anaAgent.id]));

  const members = container.resolve(app.MEMBER_REPOSITORY);
  const onBehalf = app.actorFor({ members }, ws, caller, ana.id);
  check('actorFor: onBehalfOf a person member', onBehalf.actorId === ana.id && onBehalf.recordedBy === ownerId, onBehalf);
  const self = app.actorFor({ members }, ws, caller);
  check('actorFor: without onBehalfOf the principal is both', self.actorId === ownerId && self.recordedBy === ownerId, self);
  check('actorFor: onBehalfOf an agent is VALIDATION', code(() => app.actorFor({ members }, ws, caller, anaAgent.id)) === 'VALIDATION');
  const stranger = services.team.createPerson(caller, { displayName: 'Stranger' });
  check('actorFor: a person who is not a member is PERMISSION_DENIED', code(() => app.actorFor({ members }, ws, { personId: stranger.id })) === 'PERMISSION_DENIED');
  const guestPer = services.team.createPerson(caller, { displayName: 'Guest' });
  const guest = services.team.addMember(caller, ws, { kind: 'person', personId: guestPer.id, access: 'guest', reportsTo: ownerId });
  const asGuest = app.actorFor({ members }, ws, { personId: guestPer.id });
  const forGuest = app.actorFor({ members }, ws, caller, guest.id);
  check('actorFor: access is not enforced in P0 (a guest may act and be acted for)',
    asGuest.actorId === guest.id && forGuest.actorId === guest.id && forGuest.recordedBy === ownerId, { asGuest, forGuest });

  const mission = await services.missions.create(caller, { workspaceId: ws, goal: 'Design the onboarding', title: 'Onboarding' });
  const patchedMission = services.staffing.patchMission(caller, mission.id, { design: { reviews: [{ by: 'responsible', mode: 'blocking', when: 'always' }] } });
  check('staffing: mission patch stored per role', patchedMission.design?.reviews?.length === 1, patchedMission);
  check('staffing: mission patch validates', code(() => services.staffing.patchMission(caller, mission.id, { design: { responsible: anaAgent.id } })) === 'VALIDATION');

  const tasks = container.resolve(app.TASK_REPOSITORY);
  const task_ = (id) => tasks.get(id);
  const now = systemClock.now();
  const taskBase = {
    missionId: mission.id, title: 'Design', objective: 'o', roleId: 'design', dependsOn: [],
    requiredCapabilities: [], inputArtifacts: [], expectedOutputs: [],
    executionPolicy: { isolation: 'none', maxWallTimeMs: 1000, capabilities: [] },
    approvalPolicy: { beforeStart: false, onCompletion: false }, retryPolicy: { maxAttempts: 1, backoffMs: 0, onExhausted: 'fail' },
    completionGate: null, statusReason: null, attempts: 0, remediatesTaskId: null,
    repositoryId: null, executor: 'agent', waitPolicy: null, orderHint: 0,
    createdAt: now, updatedAt: now, startedAt: null, finishedAt: null,
  };
  const taskId = ids.task();
  tasks.add({ ...taskBase, id: taskId, key: 'design', status: 'PENDING' });
  const preview = services.staffing.preview(taskId);
  check('preview: agent executor, Ana\'s agent candidate, Ana responsible',
    preview.resolved.executor === 'agent' && preview.resolved.agentCandidates[0]?.id === anaAgent.id
    && preview.resolved.responsible.id === ana.id && preview.resolved.responsible.name === 'Ana', preview);
  check('preview: escalation chain Ana -> Maria -> owner', eq(preview.escalation.map((a) => a.id), [ana.id, maria.id, ownerId]), preview.escalation);
  const taskView = services.staffing.patchTask(caller, taskId, { assignees: [maria.id] });
  check('patchTask: stores the override and returns the view', eq(taskView.staffingOverride, { assignees: [maria.id] }) && Array.isArray(taskView.claimable), taskView.staffingOverride);
  check('patchTask: preview follows the override', services.staffing.preview(taskId).resolved.executor === 'human');
  const runningId = ids.task();
  tasks.add({ ...taskBase, id: runningId, key: 'design_2', status: 'RUNNING' });
  check('patchTask: CONFLICT once RUNNING', code(() => services.staffing.patchTask(caller, runningId, null)) === 'CONFLICT');

  // ---- final I6: every team and staffing change needs a seat in the workspace
  {
    const outsider = { personId: services.team.createPerson(caller, { displayName: 'Outsider' }).id };
    const seatless = [
      ['addMember', () => services.team.addMember(outsider, ws, { kind: 'agent', name: 'Sneaky', reportsTo: ownerId, roleIds: ['design'] })],
      ['updateMember', () => services.team.updateMember(outsider, maria.id, { title: 'Hijacked' })],
      ['removeMember', () => services.team.removeMember(outsider, maria.id)],
      ['patchWorkspace', () => services.staffing.patchWorkspace(outsider, ws, { design: { mode: 'pool' } })],
      ['patchMission', () => services.staffing.patchMission(outsider, mission.id, { design: { mode: 'pool' } })],
      ['patchTask', () => services.staffing.patchTask(outsider, taskId, null)],
    ];
    for (const [name, fn] of seatless) check(`I6: ${name} by a person with no seat is PERMISSION_DENIED`, code(fn) === 'PERMISSION_DENIED', code(fn));
    const asyncCode = async (fn) => { try { await fn(); return null; } catch (e) { return e.code ?? String(e); } };
    check('I6: retryTask by a person with no seat is PERMISSION_DENIED', await asyncCode(() => services.missions.retryTask(outsider, runningId, {})) === 'PERMISSION_DENIED');
    check('I6: skipTask by a person with no seat is PERMISSION_DENIED', await asyncCode(() => services.missions.skipTask(outsider, runningId)) === 'PERMISSION_DENIED');
    check('I6: nothing the outsider tried was written', maria.title === services.team.team(ws).members.find((m) => m.id === maria.id)?.title
      && services.team.team(ws).members.every((m) => m.name !== 'Sneaky') && task_(runningId).status === 'RUNNING');

    // Removing your own seat: another owner has to do it.
    const coOwnerPer = services.team.createPerson(caller, { displayName: 'Co-owner' });
    const coOwner = services.team.addMember(caller, ws, { kind: 'person', personId: coOwnerPer.id, access: 'owner' });
    check('I6: removing your own seat is CONFLICT, even with another owner', code(() => services.team.removeMember(caller, ownerId)) === 'CONFLICT');
    check('I6: another member may remove a seat that is not theirs', code(() => services.team.removeMember({ personId: coOwnerPer.id }, guest.id)) === null);
    services.team.removeMember(caller, coOwner.id);
  }

  // ---- final C5: a preview in a workspace that lost every owner is a precondition, not a 500
  {
    const lost = (await services.workspaces.create(caller, { name: 'Ownerless' })).workspace.id;
    const lostOwner = services.team.me(caller).memberships.find((m) => m.workspaceId === lost).memberId;
    const lostMission = await services.missions.create(caller, { workspaceId: lost, goal: 'Nobody answers for this', title: 'Ownerless' });
    const lostTask = ids.task();
    tasks.add({ ...taskBase, missionId: lostMission.id, id: lostTask, key: 'orphan', status: 'PENDING' });
    members.update(lostOwner, { status: 'removed' });
    const previewError = error(() => services.staffing.preview(lostTask));
    check('C5: staffing preview with no active owner is PRECONDITION_FAILED', previewError?.code === 'PRECONDITION_FAILED', previewError?.code ?? String(previewError));
    members.update(lostOwner, { status: 'active' });
  }

  check('people: removing yourself is CONFLICT', code(() => services.team.removePerson(caller, local.id)) === 'CONFLICT');
  const temp = services.team.createPerson(caller, { displayName: 'Temp' });
  services.team.removePerson(caller, temp.id);
  services.team.removePerson(caller, stranger.id);
  check('identity: stable after people are added and removed', services.identity.localPerson().id === local.id && services.team.me(caller).person.id === local.id);

  services.team.removeMember(caller, ana.id);
  const afterRemoval = services.team.team(ws).members.find((m) => m.id === anaAgent.id);
  check('team: removing the owner leaves the agent inactive', afterRemoval?.active === false && afterRemoval.status === 'active', afterRemoval);
  check('team: removed person\'s membership is gone from me', services.team.me({ personId: anaPer.id }).memberships.length === 0);

  await container.dispose();
}

/**
 * A real engine over a real SQLite file: every module composed as the daemon
 * does, with the fake runtime. Composing twice over the same HOME is how a
 * section simulates a daemon restart.
 */
async function engineHarness(HOME, component) {
  const { mkdirSync } = await import('node:fs');
  const { Container, compose } = await import('@tandemise/kernel');
  const { createLogger, createPaths, systemClock } = await import('@tandemise/shared');
  const persistenceTokens = await import('@tandemise/persistence');
  const { persistenceModule } = persistenceTokens;
  const { createArtifactsModule, ARTIFACT_STORE: ARTIFACTS_STORE_TOKEN, renderArtifactTemplate, parseArtifact, measureArtifact, deriveHandoff, splitAppendix } = await import('@tandemise/artifacts');
  const { policyModule } = await import('@tandemise/policy');
  const { contextModule } = await import('@tandemise/context');
  const { createEvaluationModule } = await import('@tandemise/evaluation');
  const { runtimesCoreModule } = await import('@tandemise/runtimes-core');
  const { genericRuntimeModule } = await import('@tandemise/runtime-generic');
  const { executionCoreModule, CLOCK: EXEC_CLOCK, LOGGER: EXEC_LOGGER, PATHS: EXEC_PATHS } = await import('@tandemise/execution-core');
  const { executionLocalModule } = await import('@tandemise/execution-local');
  const {
    integrationsCoreModule, CLOCK: INT_CLOCK, LOGGER: INT_LOGGER, COMMAND_EXECUTOR, BACKGROUND_PROCESS_LAUNCHER,
  } = await import('@tandemise/integrations-core');
  const app = await import('@tandemise/application');

  const paths = createPaths(HOME);
  mkdirSync(paths.root, { recursive: true });
  const log = createLogger({ level: 'error', base: { component } });
  const container = new Container();
  compose(
    container,
    persistenceModule({ path: paths.db, logger: log }),
    createArtifactsModule({ paths }),
    policyModule, contextModule, createEvaluationModule(), runtimesCoreModule, genericRuntimeModule,
    executionCoreModule, executionLocalModule, integrationsCoreModule, app.createApplicationModule({ localPersonName: 'Demo' }),
  );
  container.bind(EXEC_CLOCK, () => systemClock, { source: 'check' });
  container.bind(EXEC_LOGGER, () => log, { source: 'check' });
  container.bind(EXEC_PATHS, () => paths, { source: 'check' });
  container.bind(INT_CLOCK, () => systemClock, { source: 'check' });
  container.bind(INT_LOGGER, () => log, { source: 'check' });
  container.bind(COMMAND_EXECUTOR, () => ({ run: async () => ({ exitCode: 0, stdout: '', stderr: '' }) }), { source: 'check' });
  container.bind(BACKGROUND_PROCESS_LAUNCHER, () => ({ launch: async () => { throw new Error('unused'); } }), { source: 'check' });
  const isToken = (v) => typeof v === 'object' && v !== null && typeof v.description === 'string';
  for (const name of Object.keys(app)) {
    const appToken = app[name]; const provider = persistenceTokens[name];
    if (!isToken(appToken) || !isToken(provider)) continue;
    if (!container.has(provider) || container.has(appToken)) continue;
    container.bind(appToken, (r) => r.resolve(provider), { source: `alias:${name}` });
  }
  container.bind(app.ARTIFACT_STORE, (r) => r.resolve(ARTIFACTS_STORE_TOKEN), { source: 'alias' });
  container.bind(app.ARTIFACT_TEMPLATES, () => ({ render: renderArtifactTemplate }), { source: 'check' });
  container.bind(app.ARTIFACT_PARSER, () => ({ parse: parseArtifact }), { source: 'check' });
  container.bind(app.ARTIFACT_MEASURE, () => ({ measure: measureArtifact, deriveHandoff, splitAppendix }), { source: 'check' });
  container.bind(app.EVENT_BUS, () => ({ publish: () => {}, subscribe: () => () => {} }), { source: 'check' });
  container.bind(app.PROJECTION_BUS, () => ({ invalidate: () => {}, subscribe: () => () => {} }), { source: 'check' });
  container.bind(app.SECRET_STORE, () => ({ backend: 'memory', store: async () => 'x', resolve: async () => undefined, remove: async () => {}, list: async () => [] }), { source: 'check' });
  container.bind(app.SETTINGS_STORE, () => app.createMemorySettingsStore(), { source: 'check' });
  container.bind(app.SYSTEM_ENVIRONMENT, () => app.describeEnvironment({ home: HOME, schemaVersion: 1 }), { source: 'check' });
  container.bind(app.PROCESS_LIVENESS, () => app.osProcessLiveness, { source: 'check' });

  const services = app.createServices(container);
  const scheduler = container.resolve(app.SCHEDULER);
  const repo = {
    tasks: container.resolve(app.TASK_REPOSITORY),
    missions: container.resolve(app.MISSION_REPOSITORY),
    runs: container.resolve(app.RUN_REPOSITORY),
    events: container.resolve(app.EVENT_REPOSITORY),
    artifacts: container.resolve(app.ARTIFACT_REPOSITORY),
    profiles: container.resolve(app.RUNTIME_PROFILE_REPOSITORY),
    approvals: container.resolve(app.APPROVAL_REPOSITORY),
    feedback: container.resolve(app.FEEDBACK_REPOSITORY),
  };
  const gates = container.resolve(app.GATE_SERVICE);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // Ticks the scheduler between polls: the check owns the loop instead of a timer.
  const until = async (fn, ms = 8000, every = 40) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      await scheduler.tick();
      const v = fn();
      if (v) return v;
      await sleep(every);
    }
    return fn();
  };
  return { app, container, services, scheduler, repo, gates, paths, until, sleep };
}

section('engine: resolution');
{
  const { mkdtempSync, mkdirSync } = await import('node:fs');
  const { execFileSync } = await import('node:child_process');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { systemClock, ids } = await import('@tandemise/shared');
  const { FAKE_ADAPTER_ID } = await import('@tandemise/runtime-generic');

  // Timeouts in the engine are unref'd; nothing else keeps a script alive while a run is delayed.
  const keepAlive = setInterval(() => {}, 1000);
  // Short: a run's tool socket lives under HOME, and a Unix socket path is capped near 104 bytes.
  const HOME = mkdtempSync(join(tmpdir(), 'tse-'));
  const { app, container, services, scheduler, repo, gates, paths, until } = await engineHarness(HOME, 'staffing-engine-check');
  const codeOf = async (fn) => { try { await fn(); return null; } catch (e) { return e.code ?? String(e); } };

  const brief = [
    '---', 'type: DesignBrief', 'title: Onboarding design', 'handoff:', '  headline: Onboarding flow designed step by step',
    'flows:', '  - onboarding', '---', '',
    '# Onboarding', '', 'The onboarding flow, step by step.', '',
  ].join('\n');
  const writeBrief = { kind: 'write-file', path: '.tandemise/out/DesignBrief.md', content: brief };
  // Global profiles created before any workspace, as on a real install, so a
  // new workspace's seeded routing names them.
  const now = () => systemClock.now();
  const profile = (name, steps) => repo.profiles.create({
    id: ids.runtimeProfile(), workspaceId: null, adapterId: FAKE_ADAPTER_ID, name, executablePath: null,
    args: [], settings: { script: { steps } }, capabilities: [], enabled: true, maxConcurrent: 2,
    createdAt: now(), updatedAt: now(),
  });
  const fast = profile('fast', [writeBrief, { kind: 'complete', summary: 'done' }]).id;
  const slow = profile('slow', [{ kind: 'delay', ms: 1200 }, writeBrief, { kind: 'complete', summary: 'done' }]).id;

  const caller = { personId: services.identity.localPerson().id };
  const ownerOf = (ws) => services.team.me(caller).memberships.find((m) => m.workspaceId === ws).memberId;
  const newWorkspace = async (name) => {
    const ws = (await services.workspaces.create(caller, { name })).workspace.id;
    return { ws, owner: ownerOf(ws) };
  };
  let seq = 0;
  const addMission = async (ws, tasks) => {
    const mission = await services.missions.create(caller, { workspaceId: ws, goal: 'Design the onboarding', title: `M${++seq}` });
    // A local target still reads the checkout's branch, so the mission folder is a repository.
    const dir = paths.mission(ws, mission.id);
    mkdirSync(dir, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main', dir]);
    execFileSync('git', ['-C', dir, '-c', 'user.name=check', '-c', 'user.email=check@example.com', 'commit', '-q', '--allow-empty', '-m', 'init']);
    const rows = tasks.map((t, i) => ({
      id: ids.task(), missionId: mission.id, key: t.key, title: t.key, objective: 'o', roleId: t.roleId ?? 'design',
      dependsOn: t.dependsOn ?? [], requiredCapabilities: [], inputArtifacts: [], expectedOutputs: t.expectedOutputs ?? ['DesignBrief'],
      executionPolicy: { isolation: 'none', maxWallTimeMs: 60000, capabilities: t.capabilities ?? [] },
      approvalPolicy: { beforeStart: false, onCompletion: false }, retryPolicy: { maxAttempts: 1, backoffMs: 0, onExhausted: 'fail' },
      completionGate: null, status: t.status ?? ((t.dependsOn ?? []).length === 0 ? 'READY' : 'PENDING'), statusReason: null,
      attempts: 0, remediatesTaskId: null, repositoryId: null, executor: t.executor ?? 'agent', waitPolicy: null, orderHint: i,
      staffingOverride: t.staffingOverride ?? null,
      createdAt: now(), updatedAt: now(), startedAt: null, finishedAt: null,
    }));
    for (const row of rows) repo.tasks.add(row);
    if (tasks.every((t) => t.dispatch !== false)) repo.missions.update(mission.id, { status: 'EXECUTING' });
    return { mission, ids: Object.fromEntries(rows.map((r) => [r.key, r.id])) };
  };
  const task = (id) => repo.tasks.get(id);

  // ---- A1: zero configuration, before anyone is added
  {
    const { ws, owner } = await newWorkspace('Zero');
    const { ids: t } = await addMission(ws, [{ key: 'design' }]);
    const done = await until(() => ['SUCCEEDED', 'FAILED', 'BLOCKED'].includes(task(t.design).status));
    const row = task(t.design);
    check('A1: a zero-config task runs on an available profile', done && row.status === 'SUCCEEDED', `${row.status}: ${row.statusReason}`);
    const run = repo.runs.listByTask(t.design)[0];
    const art = repo.artifacts.listByTask(t.design)[0];
    check('A1: no agent member on the run', run !== undefined && (run.agentMemberId ?? null) === null, run?.agentMemberId);
    check('A1: the artifact is authored by system:runtime and answered for by the owner',
      art?.authorId === 'system:runtime' && art?.responsibleId === owner, art && { authorId: art.authorId, responsibleId: art.responsibleId, owner });
    check('A1: the task is snapshotted with the owner responsible', row.staffing != null && row.staffing.executor === 'agent' && row.responsibleId === owner, row.staffing);

    // F2: the lone owner's own human step is theirs, not up for grabs.
    const { ids: h } = await addMission(ws, [{ key: 'docs', roleId: 'docs', executor: 'human', expectedOutputs: [] }]);
    await until(() => task(h.docs).status === 'AWAITING_HUMAN');
    const solo = task(h.docs);
    const soloName = services.team.team(ws).members.find((m) => m.id === owner).name;
    check('F2 (A1): a solo owner\'s human step is assigned to them, not a pool to claim',
      solo.status === 'AWAITING_HUMAN' && solo.assigneeId === owner && eq(solo.staffing?.claimable, [owner]) && solo.statusReason === `Waiting for ${soloName}.`,
      { s: solo.status, a: solo.assigneeId, c: solo.staffing?.claimable, r: solo.statusReason });
  }

  // ---- the team used by the rest of the section
  const { ws, owner } = await newWorkspace('Team');
  const anaPer = services.team.createPerson(caller, { displayName: 'Ana' });
  const boPer = services.team.createPerson(caller, { displayName: 'Bo' });
  const ana = services.team.addMember(caller, ws, { kind: 'person', personId: anaPer.id, reportsTo: owner });
  const bo = services.team.addMember(caller, ws, { kind: 'person', personId: boPer.id, reportsTo: owner });
  const anaAgent = services.team.addMember(caller, ws, { kind: 'agent', name: 'Ana Figma', reportsTo: ana.id, roleIds: ['design'], runtimeProfileIds: [fast] });
  services.staffing.patchWorkspace(caller, ws, { design: { assignees: [anaAgent.id] } });

  // ---- 1: a task staffed to Ana's agent
  {
    const { ids: t } = await addMission(ws, [{ key: 'design' }]);
    await until(() => ['SUCCEEDED', 'FAILED', 'BLOCKED'].includes(task(t.design).status));
    const row = task(t.design);
    check('1: the staffed design task completes', row.status === 'SUCCEEDED', `${row.status}: ${row.statusReason}`);
    const run = repo.runs.listByTask(t.design)[0];
    check('1: run.agentMemberId is Ana\'s agent', run?.agentMemberId === anaAgent.id, run?.agentMemberId);
    const art = repo.artifacts.listByTask(t.design)[0];
    check('1: artifact author is the agent, Ana answers for it', art?.authorId === anaAgent.id && art?.responsibleId === ana.id, art && { a: art.authorId, r: art.responsibleId });
    check('1: task.responsibleId is Ana and the agent is the assignee', row.responsibleId === ana.id && row.assigneeId === anaAgent.id, { r: row.responsibleId, a: row.assigneeId });
    const events = run === undefined ? [] : repo.events.listByRun(run.id);
    check('1: the run\'s events carry the agent as actor', events.length > 0 && events.every((e) => e.actorId === anaAgent.id), events.map((e) => e.actorId));
  }

  // ---- 3: a task staffed to one person
  {
    const { ids: t } = await addMission(ws, [{ key: 'design', staffingOverride: { assignees: [bo.id] } }]);
    await until(() => task(t.design).status === 'AWAITING_HUMAN');
    const row = task(t.design);
    check('3 (A3): staffed to Bo, the task waits for Bo as a human task, keeping its role',
      row.status === 'AWAITING_HUMAN' && row.assigneeId === bo.id && row.executor === 'human' && row.roleId === 'design',
      { s: row.status, a: row.assigneeId, e: row.executor, r: row.roleId });
    check('3: the reason names Bo', row.statusReason === 'Waiting for Bo.', row.statusReason);
    check('3: the owner cannot complete Bo\'s task as themselves', await codeOf(() => services.missions.completeTask(caller, t.design, { result: 'figma.com/x' })) === 'CONFLICT');
    await services.missions.completeTask(caller, t.design, { result: 'https://figma.com/file/x', onBehalfOf: bo.id });
    const art = repo.artifacts.listByTask(t.design)[0];
    check('3 (A6): recorded for Bo by the owner', task(t.design).status === 'SUCCEEDED' && art?.authorId === bo.id && art?.recordedBy === owner && art?.responsibleId === bo.id,
      art && { a: art.authorId, rb: art.recordedBy, r: art.responsibleId });
  }

  // ---- F1: a name that ends in a period does not get a second one
  {
    const cyPer = services.team.createPerson(caller, { displayName: 'Cy Jr.' });
    const cy = services.team.addMember(caller, ws, { kind: 'person', personId: cyPer.id, reportsTo: owner });
    const { ids: t } = await addMission(ws, [
      { key: 'design', staffingOverride: { assignees: [cy.id] } },
      { key: 'pooled', staffingOverride: { assignees: [ana.id, cy.id], mode: 'pool' } },
    ]);
    await until(() => task(t.design).status === 'AWAITING_HUMAN' && task(t.pooled).status === 'AWAITING_HUMAN');
    check('F1: waiting for a name ending in "." has one period', task(t.design).statusReason === 'Waiting for Cy Jr.', task(t.design).statusReason);
    await services.missions.claimTask(caller, t.pooled, { onBehalfOf: cy.id });
    check('F1: claiming for a name ending in "." has one period', task(t.pooled).statusReason === 'Waiting for Cy Jr.', task(t.pooled).statusReason);
    const { waitingForName } = app;
    check('F1: "!" and "?" end a sentence too', typeof waitingForName === 'function' && waitingForName('Bo!') === 'Waiting for Bo!' && waitingForName('Bo?') === 'Waiting for Bo?' && waitingForName('Bo') === 'Waiting for Bo.',
      typeof waitingForName === 'function' ? [waitingForName('Bo!'), waitingForName('Bo')] : 'not exported');
    await services.missions.cancel(task(t.design).missionId, 'check done');
    services.team.removeMember(caller, cy.id);
  }

  // ---- F3: a person's Evidence is their text, stored as Markdown the reader can show
  {
    const { ids: t } = await addMission(ws, [{ key: 'docs', roleId: 'docs', executor: 'human', expectedOutputs: ['Evidence'], staffingOverride: { assignees: [owner] } }]);
    await until(() => task(t.docs).status === 'AWAITING_HUMAN');
    await services.missions.completeTask(caller, t.docs, { result: 'Checked the docs build: all green.' });
    const art = repo.artifacts.listByTask(t.docs)[0];
    const read = art === undefined ? undefined : await services.artifacts.read(art.id);
    check('F3: a person\'s Evidence is stored as text/markdown', art?.type === 'Evidence' && art?.mediaType === 'text/markdown', art && { type: art.type, mediaType: art.mediaType });
    check('F3: and reads back as the text they typed', read?.body?.includes('Checked the docs build: all green.') === true && read?.manifest?.mediaType === 'text/markdown', read && { body: read.body, mt: read.manifest.mediaType });
  }

  // ---- 4: a pool of people
  {
    const { ids: t } = await addMission(ws, [{ key: 'design', staffingOverride: { assignees: [ana.id, bo.id], mode: 'pool' } }]);
    await until(() => task(t.design).status === 'AWAITING_HUMAN');
    let row = task(t.design);
    check('4 (A7): a pool waits unassigned', row.status === 'AWAITING_HUMAN' && row.assigneeId === null && row.statusReason === 'Waiting for someone to claim this.', { a: row.assigneeId, r: row.statusReason });
    check('4: someone outside the pool cannot claim', await codeOf(() => services.missions.claimTask(caller, t.design, {})) === 'CONFLICT');
    await services.missions.claimTask(caller, t.design, { onBehalfOf: bo.id });
    row = task(t.design);
    check('4: claiming for Bo assigns Bo and makes Bo responsible', row.assigneeId === bo.id && row.responsibleId === bo.id, { a: row.assigneeId, r: row.responsibleId });
    check('4: Ana, who did not claim it, cannot complete it',
      await codeOf(() => services.missions.completeTask(caller, t.design, { result: 'x', onBehalfOf: ana.id })) === 'CONFLICT');
  }

  // ---- ruling 2: a READY task's override takes effect, and preview reads the snapshot
  {
    const { ids: t } = await addMission(ws, [{ key: 'design', dispatch: false }, { key: 'later', dependsOn: ['design'], dispatch: false }]);
    services.staffing.patchTask(caller, t.design, { assignees: [bo.id] });
    const row = task(t.design);
    check('patchTask on READY re-snapshots', row.staffing?.executor === 'human' && row.assigneeId === bo.id && row.executor === 'human', row.staffing);
    services.staffing.patchTask(caller, t.design, null);
    check('clearing the override on READY re-snapshots back to the agent', task(t.design).staffing?.executor === 'agent' && task(t.design).executor === 'agent');
    services.staffing.patchWorkspace(caller, ws, { design: { assignees: [bo.id] } });
    check('preview of a READY task is its snapshot', services.staffing.preview(t.design).resolved.executor === 'agent');
    check('preview of a PENDING task is a fresh resolution', services.staffing.preview(t.later).resolved.executor === 'human');
    services.staffing.patchWorkspace(caller, ws, { design: { assignees: [anaAgent.id] } });
  }

  // ---- final I3: a waiting task's override takes effect; one that already ran cannot be restaffed
  {
    const { ids: t } = await addMission(ws, [
      { key: 'waits', roleId: 'qa', executor: 'human', expectedOutputs: [], staffingOverride: { assignees: [ana.id], mode: 'first_available' } },
      { key: 'to_agent', roleId: 'qa', executor: 'human', expectedOutputs: [], staffingOverride: { assignees: [ana.id], mode: 'first_available' } },
    ]);
    await until(() => task(t.waits).status === 'AWAITING_HUMAN' && task(t.to_agent).status === 'AWAITING_HUMAN');
    services.staffing.patchTask(caller, t.waits, { assignees: [bo.id], mode: 'first_available' });
    const moved = task(t.waits);
    check('I3: patching an AWAITING_HUMAN task person to person reassigns it',
      moved.status === 'AWAITING_HUMAN' && moved.assigneeId === bo.id && moved.responsibleId === bo.id && eq(moved.staffing?.claimable, [bo.id]) && moved.statusReason === 'Waiting for Bo.',
      { s: moved.status, a: moved.assigneeId, r: moved.responsibleId, c: moved.staffing?.claimable, why: moved.statusReason });
    repo.tasks.update(t.to_agent, { staffing: { ...task(t.to_agent).staffing, escalatedTo: [owner] } });
    services.staffing.patchTask(caller, t.to_agent, { assignees: [anaAgent.id] });
    const toAgent = task(t.to_agent);
    check('I3: patching an AWAITING_HUMAN task to an agent moves it to READY, clearing the escalation',
      ['READY', 'RUNNING', 'SUCCEEDED'].includes(toAgent.status) && toAgent.staffing?.executor === 'agent' && toAgent.executor === 'agent' && (toAgent.staffing?.escalatedTo ?? []).length === 0,
      { s: toAgent.status, e: toAgent.executor, snap: toAgent.staffing });
    await services.missions.cancel(task(t.waits).missionId, 'check done');

    const { ids: r } = await addMission(ws, [{ key: 'ran', dispatch: false }]);
    repo.tasks.update(r.ran, { status: 'BLOCKED', statusReason: 'Stopped after a run.', attempts: 1, startedAt: now() });
    check('I3: patching a task that already ran is CONFLICT', await codeOf(() => services.staffing.patchTask(caller, r.ran, { assignees: [bo.id] })) === 'CONFLICT');
    repo.tasks.update(r.ran, { status: 'AWAITING_APPROVAL', statusReason: 'Approve the output?' });
    check('I3: so is one waiting for approval of its output', await codeOf(() => services.staffing.patchTask(caller, r.ran, { assignees: [bo.id] })) === 'CONFLICT');
  }

  const ownerName = services.team.team(ws).members.find((m) => m.id === owner).name;

  // ---- review fix 2: a migrated workspace's "<Role> agent" does not take a person's step
  {
    services.workspaces.update(ws, { routing: { review: [fast] } });
    const reviewAgent = services.team.team(ws).members.find((m) => m.kind === 'agent' && m.name === 'Review agent');
    check('migrated-style: routing made a staffed Review agent', reviewAgent !== undefined && eq(services.staffing.workspace(ws).review?.assignees, [reviewAgent?.id]));
    const { ids: t } = await addMission(ws, [{ key: 'signoff', roleId: 'review', executor: 'human', expectedOutputs: [] }]);
    await until(() => task(t.signoff).status === 'AWAITING_HUMAN' || repo.runs.listByTask(t.signoff).length > 0);
    const row = task(t.signoff);
    check('migrated-style: the human review step waits for a person, not the Review agent',
      row.status === 'AWAITING_HUMAN' && row.executor === 'human' && eq(row.staffing?.claimable, [owner]) && row.assigneeId === owner && repo.runs.listByTask(t.signoff).length === 0,
      { s: row.status, e: row.executor, snap: row.staffing });
    check('review fix 3 (F2): a pool only the owner can claim is the owner\'s and names them', row.statusReason === `Waiting for ${ownerName}.`, row.statusReason);
  }

  // ---- review fix 1: re-completing a human task supersedes its earlier output
  {
    const { DATABASE } = await import('@tandemise/persistence');
    const db = container.resolve(DATABASE);
    const { ids: t } = await addMission(ws, [{ key: 'direction', executor: 'human' }]);
    await until(() => task(t.direction).status === 'AWAITING_HUMAN');
    await services.missions.completeTask(caller, t.direction, { result: 'https://figma.com/file/first' });
    const first = repo.artifacts.listByTask(t.direction)[0];
    await services.missions.retryTask(caller, t.direction, {});
    await until(() => task(t.direction).status === 'AWAITING_HUMAN');
    await services.missions.completeTask(caller, t.direction, { result: 'https://figma.com/file/second' });
    const all = repo.artifacts.listByTask(t.direction);
    const live = all.filter((a) => !all.some((b) => b.supersedes === a.id));
    const second = all.find((a) => a.id !== first?.id);
    const backPointer = first === undefined ? undefined : db.handle.prepare('SELECT superseded_by FROM artifacts WHERE id = ?').get(first.id)?.superseded_by;
    check('review fix 1: one live DesignBrief after re-completing, and the first is superseded',
      all.length === 2 && live.length === 1 && live[0].id === second?.id && second?.supersedes === first?.id && backPointer === second?.id,
      { count: all.length, live: live.map((a) => a.id), supersedes: second?.supersedes, backPointer });
  }

  // ---- fix 1: a human step keeps being a human step across re-resolution
  {
    // qa has no agents here, so an agent fallback and a human pool are distinguishable.
    const { ids: t } = await addMission(ws, [{ key: 'check', roleId: 'qa', executor: 'human', expectedOutputs: [], dispatch: false }]);
    services.staffing.patchTask(caller, t.check, { assignees: [anaAgent.id] });
    const staffedToAgent = task(t.check);
    check('fix1: a human step staffed to an agent runs as an agent, remembering its origin',
      staffedToAgent.executor === 'agent' && staffedToAgent.staffing?.humanStep === true, staffedToAgent.staffing);
    services.staffing.patchTask(caller, t.check, null);
    const cleared = task(t.check);
    check('fix1: clearing the override on READY re-resolves as a human step, not the agent fallback',
      cleared.executor === 'human' && cleared.staffing?.executor === 'human' && eq(cleared.staffing?.claimable, [owner]) && cleared.staffing?.humanStep === true,
      { e: cleared.executor, snap: cleared.staffing });
  }

  // ---- fix 2: a retried task whose assignee left is resolved again
  // A person's step is a pool by default, so naming one person needs first_available to assign them.
  {
    const { ids: t } = await addMission(ws, [{ key: 'sign', roleId: 'qa', executor: 'human', expectedOutputs: [], staffingOverride: { assignees: [bo.id], mode: 'first_available' } }]);
    await until(() => task(t.sign).status === 'AWAITING_HUMAN');
    check('fix2: the human step waits for Bo', task(t.sign).assigneeId === bo.id, task(t.sign).assigneeId);
    // Retry's precondition: the task has stopped (a human task only stops when someone blocks it).
    repo.tasks.update(t.sign, { status: 'BLOCKED', statusReason: 'Stopped by hand.' });
    services.team.removeMember(caller, bo.id);
    await services.missions.retryTask(caller, t.sign, {});
    await until(() => task(t.sign).status === 'AWAITING_HUMAN');
    const row = task(t.sign);
    check('fix2 (F2): after Bo is removed, the retried task falls back to the lone owner instead of staying Bo\'s',
      row.status === 'AWAITING_HUMAN' && row.assigneeId === owner && eq(row.staffing?.claimable, [owner]) && row.statusReason === `Waiting for ${ownerName}.`,
      { s: row.status, a: row.assigneeId, c: row.staffing?.claimable, r: row.statusReason });

    const { ids: k } = await addMission(ws, [{ key: 'keep', roleId: 'qa', executor: 'human', expectedOutputs: [], staffingOverride: { assignees: [ana.id], mode: 'first_available' } }]);
    await until(() => task(k.keep).status === 'AWAITING_HUMAN');
    repo.tasks.update(k.keep, { status: 'BLOCKED', statusReason: 'Stopped by hand.' });
    services.staffing.patchWorkspace(caller, ws, { qa: { responsible: owner } });
    await services.missions.retryTask(caller, k.keep, {});
    await until(() => task(k.keep).status === 'AWAITING_HUMAN');
    check('fix2: a retried task whose people are all active keeps its snapshot despite a staffing edit',
      task(k.keep).assigneeId === ana.id && task(k.keep).staffing?.staffing.responsible === null && task(k.keep).responsibleId === ana.id,
      { a: task(k.keep).assigneeId, snap: task(k.keep).staffing?.staffing });
    services.staffing.patchWorkspace(caller, ws, { qa: null });
  }

  // ---- round 2, item 5: a team's human step with nobody staffed falls to its single owner
  {
    const localId = services.identity.localPerson().id;
    const before = services.team.listPeople().find((p) => p.id === localId).displayName;
    services.team.updatePerson(caller, localId, { displayName: 'Demo G.' });
    const { ids: t } = await addMission(ws, [{ key: 'notes', roleId: 'docs', executor: 'human', expectedOutputs: [] }]);
    await until(() => task(t.notes).status === 'AWAITING_HUMAN');
    const row = task(t.notes);
    check('team fallback: with Ana and Bo on the team, an unstaffed human step is assigned to the single owner',
      row.assigneeId === owner && eq(row.staffing?.claimable, [owner]) && services.team.team(ws).members.filter((m) => m.kind === 'person' && m.active).length > 1,
      { a: row.assigneeId, c: row.staffing?.claimable });
    check('team fallback: the reason names the owner with one period', row.statusReason === 'Waiting for Demo G.', row.statusReason);
    await services.missions.cancel(row.missionId, 'check done');
    services.team.updatePerson(caller, localId, { displayName: before });
  }

  // ---- 5: mid-mission change (A12)
  {
    const b = await newWorkspace('Mid');
    services.workspaces.update(b.ws, { concurrency: { maxTotalWorkers: 1, perRuntime: {} } });
    const bbPer = services.team.createPerson(caller, { displayName: 'Bea' });
    const bea = services.team.addMember(caller, b.ws, { kind: 'person', personId: bbPer.id, reportsTo: b.owner });
    const archAgent = services.team.addMember(caller, b.ws, { kind: 'agent', name: 'Architect', reportsTo: b.owner, roleIds: ['architecture'], runtimeProfileIds: [slow] });
    const devAgent = services.team.addMember(caller, b.ws, { kind: 'agent', name: 'Developer', reportsTo: b.owner, roleIds: ['development'], runtimeProfileIds: [fast] });
    const { ids: t } = await addMission(b.ws, [
      { key: 'arch', roleId: 'architecture', expectedOutputs: [] },
      { key: 'build', roleId: 'development', dependsOn: ['arch'], expectedOutputs: [] },
      { key: 'early', roleId: 'development', expectedOutputs: [] },
    ]);
    await until(() => task(t.arch).status === 'RUNNING');
    check('5: arch is running and early is READY with an agent snapshot',
      task(t.arch).status === 'RUNNING' && task(t.early).status === 'READY' && eq(task(t.early).staffing?.agentCandidateIds, [devAgent.id]),
      { arch: task(t.arch).status, early: task(t.early).status, snap: task(t.early).staffing });
    services.staffing.patchWorkspace(caller, b.ws, { development: { assignees: [bea.id] } });
    await until(() => task(t.build).status === 'AWAITING_HUMAN' && task(t.early).status === 'SUCCEEDED', 10000);
    check('5 (A12): the PENDING task resolves with the new staffing', task(t.build).status === 'AWAITING_HUMAN' && task(t.build).assigneeId === bea.id, { s: task(t.build).status, r: task(t.build).statusReason });
    check('5: the task already READY keeps its snapshot and runs on the agent',
      task(t.early).status === 'SUCCEEDED' && repo.runs.listByTask(t.early)[0]?.agentMemberId === devAgent.id,
      { s: task(t.early).status, r: task(t.early).statusReason });
    void archAgent;
  }

  // ---- 6: a removed person's agent is skipped (A11)
  {
    const ownAgent = services.team.addMember(caller, ws, { kind: 'agent', name: 'House designer', reportsTo: owner, roleIds: ['design'], runtimeProfileIds: [fast, slow] });
    services.staffing.patchWorkspace(caller, ws, { design: { assignees: [anaAgent.id, ownAgent.id] } });
    services.team.removeMember(caller, ana.id);
    check('view routing follows the first active staffed agent', eq(services.workspaces.view(ws).workspace.routing.design, [fast, slow]), services.workspaces.view(ws).workspace.routing.design);
    const { ids: t } = await addMission(ws, [{ key: 'design' }]);
    await until(() => ['SUCCEEDED', 'FAILED', 'BLOCKED'].includes(task(t.design).status));
    const run = repo.runs.listByTask(t.design)[0];
    check('6 (A11): Ana\'s agent is skipped for the next candidate', task(t.design).status === 'SUCCEEDED' && run?.agentMemberId === ownAgent.id && task(t.design).responsibleId === owner,
      { s: task(t.design).status, agent: run?.agentMemberId, r: task(t.design).responsibleId });

    services.staffing.patchWorkspace(caller, ws, { design: { assignees: [anaAgent.id] } });
    const { mission: m2, ids: t2 } = await addMission(ws, [{ key: 'design' }]);
    await until(() => ['SUCCEEDED', 'FAILED', 'BLOCKED', 'AWAITING_HUMAN'].includes(task(t2.design).status));
    const row2 = task(t2.design);
    // final I7 (F11): changed from "falls back to the legacy runtimes". Staffing named an agent, so its work
    // never widens to every enabled runtime; somebody picks who does it instead.
    check('6 / I7 (F11): with the only staffed agent inactive, the task waits for a person and no run starts',
      row2.status === 'AWAITING_HUMAN' && repo.runs.listByTask(t2.design).length === 0 && row2.executor === 'human' && row2.assigneeId === null,
      { s: row2.status, r: row2.statusReason, e: row2.executor, a: row2.assigneeId, runs: repo.runs.listByTask(t2.design).length });
    check('I7: the reason names the role and the inactive agent',
      row2.statusReason === 'Nobody active is staffed for design: Ana Figma (inactive). Pick who does it.', row2.statusReason);
    check('I7: the responsible person\'s escalation chain can claim it', eq(row2.staffing?.claimable, [owner]) && row2.responsibleId === owner,
      { c: row2.staffing?.claimable, r: row2.responsibleId });
    await services.missions.claimTask(caller, t2.design, {});
    check('I7: and an owner can take it', task(t2.design).assigneeId === owner, task(t2.design).assigneeId);
    await services.missions.cancel(m2.id, 'check done');

    // Every runtime of the staffed agent disabled: blocked with the agent named, never widened.
    const offline = repo.profiles.create({
      id: ids.runtimeProfile(), workspaceId: null, adapterId: FAKE_ADAPTER_ID, name: 'offline', executablePath: null,
      args: [], settings: { script: { steps: [writeBrief, { kind: 'complete', summary: 'done' }] } }, capabilities: [], enabled: false, maxConcurrent: 2,
      createdAt: now(), updatedAt: now(),
    }).id;
    const dormant = services.team.addMember(caller, ws, { kind: 'agent', name: 'Dormant designer', reportsTo: owner, roleIds: ['design'], runtimeProfileIds: [offline] });
    const { mission: m3, ids: t3 } = await addMission(ws, [{ key: 'design', staffingOverride: { assignees: [dormant.id] } }]);
    await until(() => ['SUCCEEDED', 'FAILED', 'BLOCKED', 'AWAITING_HUMAN'].includes(task(t3.design).status));
    const row3 = task(t3.design);
    check('I7: an agent whose every runtime is disabled blocks the task with the agent named, and no run starts',
      row3.status === 'BLOCKED' && row3.statusReason === 'Dormant designer has no enabled runtime.' && repo.runs.listByTask(t3.design).length === 0,
      { s: row3.status, r: row3.statusReason, runs: repo.runs.listByTask(t3.design).map((r) => r.runtimeProfileId) });
    await services.missions.cancel(m3.id, 'check done');
  }

  // ---- 7: risk facts
  {
    const { ids: t } = await addMission(ws, [
      { key: 'ship', roleId: 'release', capabilities: ['release', 'repository.read'], dispatch: false },
      { key: 'look', roleId: 'review', capabilities: ['repository.read'], dispatch: false },
    ]);
    const ship = gates.factsFor(task(t.ship));
    const look = gates.factsFor(task(t.look));
    check('7: task.risk_level is 5 for a release capability', ship['task.risk_level'] === 5 && ship['task.risk'] === 'release', ship);
    check('7: task.risk_level is 0 for read-only', look['task.risk_level'] === 0 && look['task.risk'] === 'read', look);
    check('7: task.role and task.attempt are facts', look['task.role'] === 'review' && look['task.attempt'] === 0, look);
  }

  await scheduler.drain();
  clearInterval(keepAlive);
  await container.dispose();
}

section('engine: reviews and escalation');
{
  const { mkdtempSync, mkdirSync } = await import('node:fs');
  const { execFileSync } = await import('node:child_process');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { systemClock, ids } = await import('@tandemise/shared');
  const { FAKE_ADAPTER_ID } = await import('@tandemise/runtime-generic');
  const { BUILT_IN_TOOLS } = await import('@tandemise/integrations-core');
  const D = await import('@tandemise/domain');

  const keepAlive = setInterval(() => {}, 1000);
  const HOME = mkdtempSync(join(tmpdir(), 'tsr-'));
  let h = await engineHarness(HOME, 'staffing-reviews-check');
  const now = () => systemClock.now();

  const brief = ['---', 'type: DesignBrief', 'title: Brief', 'handoff:', '  headline: Onboarding brief ready', 'flows:', '  - onboarding', '---', '', '# Brief', '', 'Body.', ''].join('\n');
  const fast = h.repo.profiles.create({
    id: ids.runtimeProfile(), workspaceId: null, adapterId: FAKE_ADAPTER_ID, name: 'fast', executablePath: null, args: [],
    settings: { script: { steps: [{ kind: 'write-file', path: '.tandemise/out/DesignBrief.md', content: brief }, { kind: 'complete', summary: 'done' }] } },
    capabilities: [], enabled: true, maxConcurrent: 4, createdAt: now(), updatedAt: now(),
  }).id;

  const caller = { personId: h.services.identity.localPerson().id };
  const ws = (await h.services.workspaces.create(caller, { name: 'Reviews' })).workspace.id;
  const owner = h.services.team.me(caller).memberships.find((m) => m.workspaceId === ws).memberId;
  const person = (name, reportsTo) => h.services.team.addMember(caller, ws, {
    kind: 'person', personId: h.services.team.createPerson(caller, { displayName: name }).id, reportsTo,
  });
  const maria = person('Maria', owner);
  const ana = person('Ana', maria.id);
  const anaAgent = h.services.team.addMember(caller, ws, { kind: 'agent', name: 'Ana Figma', reportsTo: ana.id, roleIds: ['design'], runtimeProfileIds: [fast] });
  const blocking = { by: 'responsible', mode: 'blocking', when: 'always' };
  h.services.staffing.patchWorkspace(caller, ws, { design: { assignees: [anaAgent.id], reviews: [blocking] } });

  let seq = 0;
  const addMission = (tasks) => addMissionIn(ws, tasks);
  const addMissionIn = async (ws, tasks) => {
    const mission = await h.services.missions.create(caller, { workspaceId: ws, goal: 'Review things', title: `R${++seq}` });
    const dir = h.paths.mission(ws, mission.id);
    mkdirSync(dir, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main', dir]);
    execFileSync('git', ['-C', dir, '-c', 'user.name=check', '-c', 'user.email=check@example.com', 'commit', '-q', '--allow-empty', '-m', 'init']);
    const rows = tasks.map((t, i) => ({
      id: ids.task(), missionId: mission.id, key: t.key, title: t.key, objective: 'o', roleId: t.roleId ?? 'design',
      dependsOn: t.dependsOn ?? [], requiredCapabilities: [], inputArtifacts: [], expectedOutputs: t.expectedOutputs ?? ['DesignBrief'],
      executionPolicy: { isolation: 'none', maxWallTimeMs: 60000, capabilities: t.capabilities ?? [] },
      approvalPolicy: { beforeStart: false, onCompletion: t.onCompletion ?? false }, retryPolicy: { maxAttempts: 1, backoffMs: 0, onExhausted: 'fail' },
      completionGate: null, status: (t.dependsOn ?? []).length === 0 ? 'READY' : 'PENDING', statusReason: null,
      attempts: 0, remediatesTaskId: null, repositoryId: null, executor: t.executor ?? 'agent', waitPolicy: null, orderHint: i,
      staffingOverride: t.staffingOverride ?? null, createdAt: now(), updatedAt: now(), startedAt: null, finishedAt: null,
    }));
    for (const row of rows) h.repo.tasks.add(row);
    if (tasks.every((t) => t.dispatch !== false)) h.repo.missions.update(mission.id, { status: 'EXECUTING' });
    return { mission, ids: Object.fromEntries(rows.map((r) => [r.key, r.id])) };
  };
  const task = (id) => h.repo.tasks.get(id);
  const settled = (id) => h.until(() => ['SUCCEEDED', 'FAILED', 'BLOCKED', 'AWAITING_APPROVAL', 'AWAITING_HUMAN'].includes(task(id).status));
  const pending = (id) => h.repo.approvals.pendingForTask(id);
  const eventsOf = (missionId, type) => h.repo.events.listByMission(missionId).filter((e) => e.body.type === type);
  const moved = (id) => !['PENDING', 'BLOCKED'].includes(task(id).status);

  // ---- A2: a product task with a blocking review by the responsible person
  {
    const { ids: t } = await addMission([
      { key: 'spec', roleId: 'product', staffingOverride: { reviews: [blocking] } },
      { key: 'next', roleId: 'product', executor: 'human', dependsOn: ['spec'], expectedOutputs: [] },
    ]);
    await settled(t.spec);
    const cards = pending(t.spec);
    check('A2: the product task waits for one approval addressed to the owner',
      task(t.spec).status === 'AWAITING_APPROVAL' && cards.length === 1 && eq(cards[0].addressees, [owner]),
      { s: task(t.spec).status, r: task(t.spec).statusReason, a: cards.map((c) => c.addressees) });
    await h.services.approvals.decide(caller, cards[0].id, { optionId: 'approve' });
    await h.until(() => moved(t.next));
    check('A2: deciding it succeeds the task and moves downstream on', task(t.spec).status === 'SUCCEEDED' && moved(t.next),
      { spec: task(t.spec).status, next: task(t.next).status });
  }

  // ---- regression: approvalPolicy.onCompletion with no staffing reviews
  {
    const { ids: t } = await addMission([{ key: 'legacy', roleId: 'qa', onCompletion: true }]);
    await settled(t.legacy);
    const cards = pending(t.legacy);
    check('onCompletion without reviews: one approval, addressed to the responsible person',
      task(t.legacy).status === 'AWAITING_APPROVAL' && cards.length === 1 && eq(cards[0].addressees, [task(t.legacy).responsibleId]),
      { s: task(t.legacy).status, a: cards.map((c) => c.addressees), r: task(t.legacy).responsibleId });
  }

  // ---- A4 + A6: Ana's agent's design is Ana's to approve; the owner records it for her
  {
    const { ids: t } = await addMission([{ key: 'design' }]);
    await settled(t.design);
    const cards = pending(t.design);
    check('A4: the design approval is addressed to Ana only, not Maria',
      cards.length === 1 && eq(cards[0].addressees, [ana.id]), cards.map((c) => c.addressees));
    const view = await h.services.approvals.decide(caller, cards[0].id, { optionId: 'approve', onBehalfOf: ana.id });
    check('A6: decided for Ana, recorded by the owner', view.approval.decidedBy === ana.id && view.approval.recordedBy === owner,
      { d: view.approval.decidedBy, r: view.approval.recordedBy });
    check('A6: the view names Ana as the decider', view.decidedByRef?.name === 'Ana', view.decidedByRef);
    check('A4: with no sign-off lead, approving succeeds the task', task(t.design).status === 'SUCCEEDED', task(t.design).status);
  }

  // ---- A5: Maria signs off after Ana
  {
    h.services.team.updateMember(caller, maria.id, { oversight: 'both_sign_off' });
    const { ids: t } = await addMission([{ key: 'design' }]);
    await settled(t.design);
    const first = pending(t.design)[0];
    await h.services.approvals.decide(caller, first.id, { optionId: 'approve', onBehalfOf: ana.id });
    const second = pending(t.design);
    check('F15: the sign-off after Ana\'s approval says Ana approved it',
      second[0]?.rationale === "Ana approved 'design'. As their lead, Maria signs off on it too before it counts.", second[0]?.rationale);
    check('A5: after Ana approves the task still awaits approval, now addressed to Maria',
      task(t.design).status === 'AWAITING_APPROVAL' && second.length === 1 && eq(second[0].addressees, [maria.id]),
      { s: task(t.design).status, a: second.map((c) => c.addressees) });
    await h.services.approvals.decide(caller, second[0].id, { optionId: 'approve', onBehalfOf: maria.id });
    check('A5: after Maria approves the task succeeds', task(t.design).status === 'SUCCEEDED' && pending(t.design).length === 0, task(t.design).status);
    h.services.team.updateMember(caller, maria.id, { oversight: 'delegate_owns' });
  }

  // ---- A8: an after-the-fact look does not hold anything up
  {
    const { mission, ids: t } = await addMission([
      { key: 'arch', roleId: 'architecture', staffingOverride: { reviews: [{ by: 'responsible', mode: 'after', when: 'always' }] } },
      { key: 'build', roleId: 'development', executor: 'human', dependsOn: ['arch'], expectedOutputs: [] },
    ]);
    await settled(t.arch);
    await h.until(() => moved(t.build));
    const cards = pending(t.arch);
    check('A8: the task succeeds immediately with a pending check',
      task(t.arch).status === 'SUCCEEDED' && cards.length === 1 && cards[0].kind === 'check' && cards[0].title === 'Check arch when you can',
      { s: task(t.arch).status, cards: cards.map((c) => [c.kind, c.title]) });
    check('A8: the check offers looks good (recommended) and needs changes',
      eq(cards[0]?.options.map((o) => o.id), [D.LOOKS_GOOD_OPTION, D.NEEDS_CHANGES_OPTION]) && cards[0]?.recommendedOptionId === 'looks_good',
      cards[0]?.options);
    check('A8: downstream does not wait for the check', moved(t.build), task(t.build).status);
    check('A8: looks good is affirmative for a check', D.isAffirmative('check', 'looks_good') && !D.isAffirmative('check', 'needs_changes'));
    if (cards[0] !== undefined) await h.services.approvals.decide(caller, cards[0].id, { optionId: 'needs_changes', note: 'The service boundary is wrong.' });
    // P2 (spec §10): no run recorded using arch's output - build is a person's step, which records none - so the
    // note starts arch's next round with no dialog. The step is held, though: left waiting on a person it would be
    // completed on the architecture being replaced, so it waits for the round and is offered again after it.
    check('A8: needs changes with a note starts round 2 of the task',
      task(t.arch).round === 2 && task(t.arch).status === 'READY', { r: task(t.arch).round, s: task(t.arch).status });
    check("A8: the person's step downstream waits for arch's round 2",
      task(t.build).status === 'PENDING' && task(t.build).statusReason === "Waiting for round 2 of 'arch'.", { s: task(t.build).status, r: task(t.build).statusReason });
    const [note] = h.repo.feedback.listByTask(t.arch);
    check('A8: the note is feedback carried by that round', note?.text === 'The service boundary is wrong.' && note.status === 'in_round' && note.round === 2, note);
    check('A8: no task.attention flag is raised for it', eventsOf(mission.id, 'task.attention').length === 0 && task(t.arch).needsAttention === false);
  }

  // ---- A9: a review that only applies to risky work
  {
    const risky = { reviews: [{ by: 'responsible', mode: 'blocking', when: 'task.risk_level >= 2' }] };
    const { mission, ids: t } = await addMission([
      { key: 'look', roleId: 'review', staffingOverride: risky },
      { key: 'publish', roleId: 'review', capabilities: ['email.send'], staffingOverride: risky },
    ]);
    await settled(t.look);
    await settled(t.publish);
    const skipped = eventsOf(mission.id, 'review.skipped');
    check('A9: a read-only task gets no approval and records review.skipped',
      task(t.look).status === 'SUCCEEDED' && pending(t.look).length === 0 && skipped.some((e) => e.taskId === t.look && e.body.when === 'task.risk_level >= 2'),
      { s: task(t.look).status, r: task(t.look).statusReason, skipped: skipped.map((e) => e.body) });
    check('A9: the skip records the facts it read', skipped.find((e) => e.taskId === t.look)?.body.facts?.['task.risk_level'] === 0, skipped[0]?.body);
    check('A9: a task with an external side effect gets the approval',
      task(t.publish).status === 'AWAITING_APPROVAL' && pending(t.publish).length === 1, { s: task(t.publish).status, r: task(t.publish).statusReason });
  }

  // ---- final I1: a person's finished step goes through the same reviews an agent's does
  // (F12: updated so the reviewer is someone other than the author; a self-addressed card is now skipped.)
  {
    const byMaria = (mode) => ({ by: [maria.id], mode, when: 'always' });
    const personStep = (reviews) => ({ key: 'by_hand', roleId: 'design', executor: 'human', expectedOutputs: [], staffingOverride: { assignees: [ana.id], mode: 'first_available', reviews } });
    const { ids: t } = await addMission([personStep([byMaria('blocking')])]);
    await h.until(() => task(t.by_hand).status === 'AWAITING_HUMAN');
    await h.services.missions.completeTask(caller, t.by_hand, { result: 'Drew it by hand.', onBehalfOf: ana.id });
    const cards = pending(t.by_hand);
    check('I1: a person\'s step with a blocking review waits for approval instead of succeeding',
      task(t.by_hand).status === 'AWAITING_APPROVAL' && cards.length === 1 && eq(cards[0].addressees, [maria.id]) && task(t.by_hand).statusReason === cards[0].title,
      { s: task(t.by_hand).status, r: task(t.by_hand).statusReason, a: cards.map((c) => c.addressees) });
    if (cards[0] !== undefined) await h.services.approvals.decide(caller, cards[0].id, { optionId: 'approve', onBehalfOf: maria.id });
    check('I1: approving it succeeds the person\'s step', task(t.by_hand).status === 'SUCCEEDED', task(t.by_hand).status);

    h.services.team.updateMember(caller, maria.id, { oversight: 'both_sign_off' });
    const { ids: s } = await addMission([personStep([blocking])]);
    await h.until(() => task(s.by_hand).status === 'AWAITING_HUMAN');
    await h.services.missions.completeTask(caller, s.by_hand, { result: 'Drew it again.', onBehalfOf: ana.id });
    const signOff = pending(s.by_hand);
    check('I1 / F12: with a both_sign_off lead, Maria signs off on Ana\'s step (Ana is not asked to approve her own work)',
      task(s.by_hand).status === 'AWAITING_APPROVAL' && signOff.length === 1 && eq(signOff[0].addressees, [maria.id]) && signOff[0].evidence.some((e) => e.label === 'Sign-off'),
      { s: task(s.by_hand).status, a: signOff.map((c) => c.addressees) });
    if (signOff[0] !== undefined) await h.services.approvals.decide(caller, signOff[0].id, { optionId: 'approve', onBehalfOf: maria.id });
    check('I1 / F12: approving the sign-off succeeds the step', task(s.by_hand).status === 'SUCCEEDED', task(s.by_hand).status);
    h.services.team.updateMember(caller, maria.id, { oversight: 'delegate_owns' });

    const { ids: a } = await addMission([personStep([byMaria('after')])]);
    await h.until(() => task(a.by_hand).status === 'AWAITING_HUMAN');
    await h.services.missions.completeTask(caller, a.by_hand, { result: 'Done, look later.', onBehalfOf: ana.id });
    const checks = pending(a.by_hand);
    check('I1: a person\'s step with an after review succeeds and leaves a check card',
      task(a.by_hand).status === 'SUCCEEDED' && checks.length === 1 && checks[0].kind === 'check' && eq(checks[0].addressees, [maria.id]),
      { s: task(a.by_hand).status, cards: checks.map((c) => [c.kind, c.addressees]) });
  }

  // ---- F12: a person is never asked to review their own work
  {
    // (a) the live case: a solo owner's own step, in a role staffed "AI drafts, responsible approves".
    const soloWs = (await h.services.workspaces.create(caller, { name: 'Solo reviews' })).workspace.id;
    const soloOwner = h.services.team.me(caller).memberships.find((m) => m.workspaceId === soloWs).memberId;
    h.services.staffing.patchWorkspace(caller, soloWs, { product: { reviews: [blocking] } });
    const { mission: sm, ids: so } = await addMissionIn(soloWs, [{ key: 'docs', roleId: 'product', executor: 'human', expectedOutputs: [] }]);
    await h.until(() => task(so.docs).status === 'AWAITING_HUMAN');
    await h.services.missions.completeTask(caller, so.docs, { result: 'Wrote the README paragraph.' });
    const soloSkipped = eventsOf(sm.id, 'review.skipped').filter((e) => e.taskId === so.docs);
    check('F12 (a): a solo owner completing their own reviewed step succeeds with no card',
      task(so.docs).status === 'SUCCEEDED' && pending(so.docs).length === 0 && task(so.docs).assigneeId === soloOwner, { s: task(so.docs).status, cards: pending(so.docs).map((c) => c.addressees) });
    check('F12 (a): and the timeline says the author was the only reviewer',
      soloSkipped.length === 1 && soloSkipped[0].body.reason === 'author is the only reviewer' && soloSkipped[0].body.when === 'always', soloSkipped.map((e) => e.body));

    // (b) Bea completes her step; her responsible review would be her own; her lead (the owner) still signs off.
    const bea = person('Bea', owner);
    h.services.team.updateMember(caller, owner, { oversight: 'both_sign_off' });
    const { ids: b } = await addMission([{ key: 'bea_step', roleId: 'design', executor: 'human', expectedOutputs: [], staffingOverride: { assignees: [bea.id], mode: 'first_available', reviews: [blocking] } }]);
    await h.until(() => task(b.bea_step).status === 'AWAITING_HUMAN');
    await h.services.missions.completeTask(caller, b.bea_step, { result: 'Done by Bea.', onBehalfOf: bea.id });
    const beaCards = pending(b.bea_step);
    check('F12 (b): no card to Bea, one sign-off card to her both_sign_off lead',
      task(b.bea_step).status === 'AWAITING_APPROVAL' && beaCards.length === 1 && eq(beaCards[0].addressees, [owner]) && beaCards[0].evidence.some((e) => e.label === 'Sign-off'),
      { s: task(b.bea_step).status, cards: beaCards.map((c) => [c.addressees, c.evidence.map((e) => e.label)]) });
    const ownerName = h.services.team.team(ws).members.find((m) => m.id === owner).name;
    check('F15: the sign-off after a skipped self-review says Bea did it, not that she approved it',
      beaCards[0]?.rationale === `Bea did 'bea_step' themselves. As their lead, ${ownerName} signs off on it before it counts.`, beaCards[0]?.rationale);
    h.services.team.updateMember(caller, owner, { oversight: 'delegate_owns' });
    // A lead doing their own work: Maria (both_sign_off, Ana's lead) does a step Ana answers for.
    // Ana reviews it; the sign-off would be Maria's own, so it is skipped for the same reason.
    h.services.team.updateMember(caller, maria.id, { oversight: 'both_sign_off' });
    const { mission: lm, ids: l } = await addMission([{ key: 'lead_step', roleId: 'design', executor: 'human', expectedOutputs: [], staffingOverride: { assignees: [maria.id], mode: 'first_available', responsible: ana.id, reviews: [blocking] } }]);
    await h.until(() => task(l.lead_step).status === 'AWAITING_HUMAN');
    await h.services.missions.completeTask(caller, l.lead_step, { result: 'Done by the lead.', onBehalfOf: maria.id });
    const leadCards = pending(l.lead_step);
    check('F12: a lead\'s own step is reviewed by the responsible person, not the lead', leadCards.length === 1 && eq(leadCards[0].addressees, [ana.id]), leadCards.map((x) => x.addressees));
    if (leadCards[0] !== undefined) await h.services.approvals.decide(caller, leadCards[0].id, { optionId: 'approve', onBehalfOf: ana.id });
    const leadSkipped = eventsOf(lm.id, 'review.skipped').filter((e) => e.taskId === l.lead_step);
    check('F12: when the author is the sign-off lead, the sign-off is skipped with the same reason and the step succeeds',
      task(l.lead_step).status === 'SUCCEEDED' && pending(l.lead_step).length === 0 && leadSkipped.some((e) => e.body.reason === 'author is the only reviewer'),
      { s: task(l.lead_step).status, cards: pending(l.lead_step).map((x) => x.addressees), skipped: leadSkipped.map((e) => e.body) });
    h.services.team.updateMember(caller, maria.id, { oversight: 'delegate_owns' });

    // (c) an explicit reviewer list that includes the author addresses only the others.
    const { ids: c } = await addMission([{ key: 'listed', roleId: 'design', executor: 'human', expectedOutputs: [], staffingOverride: { assignees: [bea.id], mode: 'first_available', reviews: [{ by: [bea.id, maria.id], mode: 'blocking', when: 'always' }] } }]);
    await h.until(() => task(c.listed).status === 'AWAITING_HUMAN');
    await h.services.missions.completeTask(caller, c.listed, { result: 'Done by Bea again.', onBehalfOf: bea.id });
    const listed = pending(c.listed);
    check('F12 (c): reviewers [Bea, Maria] with Bea as author address Maria only',
      task(c.listed).status === 'AWAITING_APPROVAL' && listed.length === 1 && eq(listed[0].addressees, [maria.id]), listed.map((x) => x.addressees));
  }

  // ---- final I2: a review's `when` fails closed on an unmeasured fact, and later reviews see the round's facts
  {
    const { mission, ids: t } = await addMission([
      { key: 'unmeasured', staffingOverride: { reviews: [{ by: 'responsible', mode: 'blocking', when: 'diff.files_changed > 0' }] } },
    ]);
    await settled(t.unmeasured);
    const required = eventsOf(mission.id, 'review.required');
    check('I2: a review whose when reads an unmeasured fact is required: an approval, not review.skipped',
      task(t.unmeasured).status === 'AWAITING_APPROVAL' && pending(t.unmeasured).length === 1 && eventsOf(mission.id, 'review.skipped').length === 0,
      { s: task(t.unmeasured).status, r: task(t.unmeasured).statusReason, skipped: eventsOf(mission.id, 'review.skipped').map((e) => e.body) });
    check('I2: the timeline says why, naming the missing fact',
      required.length === 1 && required[0].body.when === 'diff.files_changed > 0' && eq(required[0].body.missingFacts, ['diff.files_changed']), required.map((e) => e.body));

    const changeSet = ['---', 'type: ChangeSet', 'title: Changes', 'handoff:', '  headline: Three files changed', 'branch: feature/x', 'filesChanged: 3', '---', '', '# Changes', '', 'Three files.', ''].join('\n');
    const changes = h.repo.profiles.create({
      id: ids.runtimeProfile(), workspaceId: null, adapterId: FAKE_ADAPTER_ID, name: 'changes', executablePath: null, args: [],
      settings: { script: { steps: [{ kind: 'write-file', path: '.tandemise/out/ChangeSet.md', content: changeSet }, { kind: 'complete', summary: 'done' }] } },
      capabilities: [], enabled: true, maxConcurrent: 4, createdAt: now(), updatedAt: now(),
    }).id;
    const coder = h.services.team.addMember(caller, ws, { kind: 'agent', name: 'Coder', reportsTo: ana.id, roleIds: ['design'], runtimeProfileIds: [changes] });
    const { mission: m2, ids: c } = await addMission([{
      key: 'coded', expectedOutputs: ['ChangeSet'], staffingOverride: {
        assignees: [coder.id],
        reviews: [blocking, { by: [maria.id], mode: 'blocking', when: 'diff.files_changed > 2' }, { by: [maria.id], mode: 'blocking', when: 'diff.files_changed > 5' }],
      },
    }]);
    await settled(c.coded);
    const first = pending(c.coded);
    check('I2: the round measured the diff, and its first review is pending',
      task(c.coded).status === 'AWAITING_APPROVAL' && first.length === 1 && eq(first[0].addressees, [ana.id]),
      { s: task(c.coded).status, r: task(c.coded).statusReason, a: first.map((x) => x.addressees) });
    if (first[0] !== undefined) await h.services.approvals.decide(caller, first[0].id, { optionId: 'approve', onBehalfOf: ana.id });
    const second = pending(c.coded);
    check('I2: after the first is approved, a review with when diff.files_changed > 2 sees the value and asks Maria',
      task(c.coded).status === 'AWAITING_APPROVAL' && second.length === 1 && eq(second[0].addressees, [maria.id])
        && eventsOf(m2.id, 'review.required').length === 0,
      { s: task(c.coded).status, a: second.map((x) => x.addressees), req: eventsOf(m2.id, 'review.required').map((e) => e.body) });
    if (second[0] !== undefined) await h.services.approvals.decide(caller, second[0].id, { optionId: 'approve', onBehalfOf: maria.id });
    const skipped = eventsOf(m2.id, 'review.skipped');
    check('I2: and a later one with when diff.files_changed > 5 is skipped on the same measured value',
      task(c.coded).status === 'SUCCEEDED' && skipped.length === 1 && skipped[0].body.facts['diff.files_changed'] === 3,
      { s: task(c.coded).status, skipped: skipped.map((e) => e.body) });
  }

  // ---- final C1: a task with a check and a blocking card points at the blocking one
  {
    const { ids: t } = await addMission([{ key: 'both', staffingOverride: { reviews: [blocking] } }]);
    await settled(t.both);
    const { APPROVAL_FACTORY } = await import('@tandemise/policy');
    // Filed earlier than the blocking card, so "the first pending card" is the check.
    const earlierCheck = { ...h.container.resolve(APPROVAL_FACTORY).createOrThrow({
      workspaceId: ws, missionId: task(t.both).missionId, taskId: t.both, kind: 'check', risk: 'read',
      title: 'Check both when you can', rationale: 'r', effect: 'e', evidence: [{ kind: 'text', label: 'x', value: 'y' }],
      options: [{ id: D.LOOKS_GOOD_OPTION, label: 'Looks good' }, { id: D.NEEDS_CHANGES_OPTION, label: 'Needs changes' }], addressees: [ana.id],
    }), createdAt: '2000-01-01T00:00:00.000Z' };
    h.repo.approvals.create(earlierCheck);
    const cards = pending(t.both);
    const blockingCard = cards.find((c) => c.kind !== 'check');
    check('C1: pendingApprovalId prefers the blocking card over a check filed before it',
      cards.length === 2 && cards[0].kind === 'check' && blockingCard !== undefined && h.services.projections.taskView(t.both).pendingApprovalId === blockingCard.id,
      { kinds: cards.map((c) => c.kind), pending: h.services.projections.taskView(t.both).pendingApprovalId });
  }

  // ---- final C2 / C3: a retry starts clean - no attention flag, no escalation - and a new round does not carry the flag
  {
    const { ids: t } = await addMission([{ key: 'flagged', dispatch: false }, { key: 'revised', dispatch: false }]);
    const escalatedSnapshot = { staffing: { ...D.BASE_STAFFING }, executor: 'human', claimable: [ana.id, owner], agentCandidateIds: [], humanStep: true, escalatedTo: [owner] };
    h.repo.tasks.update(t.flagged, { status: 'BLOCKED', statusReason: 'Stopped.', needsAttention: true, executor: 'human', assigneeId: ana.id, staffing: escalatedSnapshot });
    await h.services.missions.retryTask(caller, t.flagged, {});
    check('C2: retrying clears needsAttention', task(t.flagged).needsAttention === false, task(t.flagged).needsAttention);
    check('C3: retrying clears escalatedTo', (task(t.flagged).staffing?.escalatedTo ?? []).length === 0, task(t.flagged).staffing?.escalatedTo);

    // A READY task never carries an escalation into its next wait, however it got back to READY.
    const { ids: r } = await addMission([{ key: 'back', roleId: 'qa', executor: 'human', expectedOutputs: [], staffingOverride: { assignees: [ana.id, maria.id], mode: 'pool', escalateAfterMs: 60_000 } }]);
    await h.until(() => task(r.back).status === 'AWAITING_HUMAN');
    h.repo.tasks.update(r.back, { status: 'READY', staffing: { ...task(r.back).staffing, escalatedTo: [owner], claimable: [ana.id, maria.id, owner] } });
    await h.until(() => task(r.back).status === 'AWAITING_HUMAN');
    check('C3: a task that re-enters READY by any path loses its escalation before it waits again',
      task(r.back).status === 'AWAITING_HUMAN' && (task(r.back).staffing?.escalatedTo ?? []).length === 0, task(r.back).staffing);

    h.repo.tasks.update(t.revised, { status: 'AWAITING_APPROVAL', needsAttention: true, attempts: 1 });
    const { APPROVAL_FACTORY } = await import('@tandemise/policy');
    const card = h.container.resolve(APPROVAL_FACTORY).createOrThrow({
      workspaceId: ws, missionId: task(t.revised).missionId, taskId: t.revised, kind: 'action', risk: 'write_reversible',
      title: 'Approve the output of revised?', rationale: 'r', effect: 'e',
      evidence: [{ kind: 'text', label: 'Review', value: '1/1' }], addressees: [ana.id],
    });
    h.repo.approvals.create(card);
    await h.services.approvals.decide(caller, card.id, { optionId: 'reject', note: 'Tighten the copy.', onBehalfOf: ana.id });
    const revision = h.repo.tasks.listByMission(task(t.revised).missionId).find((x) => x.key === 'revised_revision_1');
    check('C2: the note starts round 2 of the same task, which does not carry needsAttention',
      revision === undefined && task(t.revised).round === 2 && task(t.revised).needsAttention === false,
      { clone: revision?.key, r: task(t.revised).round, n: task(t.revised).needsAttention, s: task(t.revised).status });
    const [asked] = h.repo.feedback.listByTask(t.revised);
    check('C2: the note is authored by Ana and recorded by the owner', asked?.authorId === ana.id && asked.recordedBy === owner, asked);
  }

  // ---- A10: an unanswered approval climbs the team tree
  {
    const { mission, ids: t } = await addMission([{ key: 'design', staffingOverride: { escalateAfterMs: 50 } }]);
    await settled(t.design);
    const seen = [];
    const final = await h.until(() => {
      const card = pending(t.design)[0];
      if (card === undefined) return null;
      const last = seen[seen.length - 1];
      if (last === undefined || !eq(last, card.addressees)) seen.push(card.addressees);
      return card.addressees.length === 3 && card.escalateAt === null ? card : null;
    }, 3000, 10);
    check('A10: addressees grow Ana -> Maria -> owner', eq(seen, [[ana.id], [ana.id, maria.id], [ana.id, maria.id, owner]]), seen);
    check('A10: escalation level 2 and nothing left to escalate to', final?.escalationLevel === 2 && final?.escalateAt === null,
      final && { l: final.escalationLevel, at: final.escalateAt });
    const escalated = eventsOf(mission.id, 'approval.escalated');
    check('A10: each step is an approval.escalated event', escalated.length === 2 && escalated[1].body.level === 2 && eq(escalated[1].body.to, [owner]),
      escalated.map((e) => e.body));
    check('A10: the approval is still pending, and still Ana\'s to answer', final?.status === 'PENDING' && final?.addressees[0] === ana.id);
  }

  // ---- ruling 1: a pool nobody claims reaches the owners; a person who left is replaced
  // A pool of one is that person's (F2), so the pool that escalates has two people.
  {
    const { mission, ids: t } = await addMission([
      { key: 'pool', roleId: 'qa', executor: 'human', expectedOutputs: [], staffingOverride: { assignees: [ana.id, maria.id], mode: 'pool', escalateAfterMs: 50 } },
    ]);
    await h.until(() => task(t.pool).status === 'AWAITING_HUMAN');
    const escalated = await h.until(() => task(t.pool).staffing?.claimable.includes(owner), 3000, 10);
    check('pool: unclaimed past escalateAfterMs, the owners can claim it too',
      escalated && eq(task(t.pool).staffing.claimable, [ana.id, maria.id, owner]) && task(t.pool).assigneeId === null, task(t.pool).staffing?.claimable);
    check('pool: the escalation is a task.status event', eventsOf(mission.id, 'task.status').some((e) => e.taskId === t.pool && e.body.reason === 'Escalated: nobody claimed it.'));

    // Round 2, item 1: a one-person explicit pool is that person's (F2) but still escalates to the owners.
    const bo = person('Bo', owner);
    const { mission: m1, ids: one } = await addMission([
      { key: 'solo_pool', roleId: 'qa', executor: 'human', expectedOutputs: [], staffingOverride: { assignees: [bo.id], mode: 'pool', escalateAfterMs: 50 } },
    ]);
    await h.until(() => task(one.solo_pool).status === 'AWAITING_HUMAN');
    check('pool of one: Bo is the assignee', task(one.solo_pool).assigneeId === bo.id && eq(task(one.solo_pool).staffing?.claimable, [bo.id]), task(one.solo_pool).staffing?.claimable);
    const opened = await h.until(() => task(one.solo_pool).staffing?.claimable.includes(owner), 3000, 10);
    check('pool of one: unanswered past escalateAfterMs, the owners are added and Bo keeps it',
      opened === true && eq(task(one.solo_pool).staffing.claimable, [bo.id, owner]) && task(one.solo_pool).assigneeId === bo.id, { c: task(one.solo_pool).staffing?.claimable, a: task(one.solo_pool).assigneeId });
    check('pool of one: the escalation is the same task.status event',
      eventsOf(m1.id, 'task.status').some((e) => e.taskId === one.solo_pool && e.body.reason === 'Escalated: nobody claimed it.'));
    const takeCode = async (fn) => { try { await fn(); return null; } catch (e) { return e.code ?? String(e); } };
    check('round 3: the escalation is recorded on the snapshot', eq(task(one.solo_pool).staffing?.escalatedTo, [owner]), task(one.solo_pool).staffing?.escalatedTo);
    check('round 3: Maria, neither claimable nor escalated to, cannot claim the escalated pool of one',
      await takeCode(() => h.services.missions.claimTask(caller, one.solo_pool, { onBehalfOf: maria.id })) === 'CONFLICT');
    check('round 3: nor complete it', await takeCode(() => h.services.missions.completeTask(caller, one.solo_pool, { result: 'x', onBehalfOf: maria.id })) === 'CONFLICT');
    const view = h.services.projections.taskView(one.solo_pool);
    check('round 3: the task view carries escalatedTo', eq(view.escalatedTo?.map((a) => a.id), [owner]), view.escalatedTo);
    check('pool of one: an owner the escalation reached can take it', await takeCode(() => h.services.missions.claimTask(caller, one.solo_pool, {})) === null && task(one.solo_pool).assigneeId === owner,
      task(one.solo_pool).assigneeId);

    // An owner the escalation reached may also complete it without claiming, and the takeover is noted.
    const { mission: m3, ids: three } = await addMission([
      { key: 'solo_done', roleId: 'qa', executor: 'human', expectedOutputs: [], staffingOverride: { assignees: [bo.id], mode: 'pool', escalateAfterMs: 50 } },
    ]);
    await h.until(() => task(three.solo_done).staffing?.escalatedTo?.includes(owner), 3000, 10);
    check('round 3: an owner in escalatedTo can complete it without claiming',
      await takeCode(() => h.services.missions.completeTask(caller, three.solo_done, { result: 'Done by the owner.' })) === null
      && task(three.solo_done).status === 'SUCCEEDED' && task(three.solo_done).assigneeId === owner, { s: task(three.solo_done).status, a: task(three.solo_done).assigneeId });
    const ownerName = h.services.team.team(ws).members.find((m) => m.id === owner).name;
    check('round 3: completing it records the takeover note, as a claim does',
      eventsOf(m3.id, 'note').some((e) => e.taskId === three.solo_done && e.actorId === owner && e.body.text === `${ownerName} took 'solo_done'.`),
      eventsOf(m3.id, 'note').map((e) => e.body.text));

    // An owner-fallback pool of two owners: once one claims it, the other cannot take it.
    {
      const ws2 = (await h.services.workspaces.create(caller, { name: 'Two owners' })).workspace.id;
      const o1 = h.services.team.me(caller).memberships.find((m) => m.workspaceId === ws2).memberId;
      const o2 = h.services.team.addMember(caller, ws2, { kind: 'person', personId: h.services.team.createPerson(caller, { displayName: 'Olga' }).id, access: 'owner' });
      const { mission: m4, ids: f } = await addMissionIn(ws2, [{ key: 'fallback', roleId: 'qa', executor: 'human', expectedOutputs: [] }]);
      await h.until(() => task(f.fallback).status === 'AWAITING_HUMAN');
      check('round 3: two owners and nobody staffed make a pool of both', task(f.fallback).assigneeId === null && eq([...task(f.fallback).staffing.claimable].sort(), [o1, o2.id].sort()), task(f.fallback).staffing?.claimable);
      await h.services.missions.claimTask(caller, f.fallback, {});
      check('round 3: after O1 claims, O2 cannot claim', await takeCode(() => h.services.missions.claimTask(caller, f.fallback, { onBehalfOf: o2.id })) === 'CONFLICT');
      check('round 3: nor complete', await takeCode(() => h.services.missions.completeTask(caller, f.fallback, { result: 'x', onBehalfOf: o2.id })) === 'CONFLICT');
      await h.services.missions.cancel(m4.id, 'check done');
    }
    const { ids: two } = await addMission([
      { key: 'duo', roleId: 'qa', executor: 'human', expectedOutputs: [], staffingOverride: { assignees: [bo.id, maria.id], mode: 'pool', escalateAfterMs: 60_000 } },
    ]);
    await h.until(() => task(two.duo).status === 'AWAITING_HUMAN');
    await h.services.missions.claimTask(caller, two.duo, { onBehalfOf: bo.id });
    check('pool of two: once Bo claims it, Maria still cannot take it', await takeCode(() => h.services.missions.claimTask(caller, two.duo, { onBehalfOf: maria.id })) === 'CONFLICT');

    const temp = person('Temp', owner);
    const { mission: m2, ids: k } = await addMission([
      { key: 'solo', roleId: 'qa', executor: 'human', expectedOutputs: [], staffingOverride: { assignees: [temp.id], mode: 'first_available' } },
    ]);
    await h.until(() => task(k.solo).status === 'AWAITING_HUMAN');
    check('left: the step waits for Temp', task(k.solo).assigneeId === temp.id);
    h.services.team.removeMember(caller, temp.id);
    await h.until(() => task(k.solo).assigneeId !== temp.id, 3000, 10);
    const row = task(k.solo);
    check('left (F2): once Temp is removed the waiting step falls to the lone owner',
      row.status === 'AWAITING_HUMAN' && row.assigneeId === owner && eq(row.staffing?.claimable, [owner]), { a: row.assigneeId, c: row.staffing?.claimable });
    check('left: the reassignment is a task.status event', eventsOf(m2.id, 'task.status').some((e) => e.taskId === k.solo && e.body.from === 'AWAITING_HUMAN' && e.body.to === 'AWAITING_HUMAN'));
  }

  // ---- 8: ask_human from Ana's agent is addressed to Ana
  {
    const { ids: t } = await addMission([{ key: 'asking', dispatch: false }]);
    h.repo.tasks.update(t.asking, { status: 'RUNNING', assigneeId: anaAgent.id, responsibleId: ana.id });
    const tool = h.container.resolveAll(BUILT_IN_TOOLS).find((x) => x.name === 'ask_human');
    const controller = new AbortController();
    const mission = task(t.asking).missionId;
    const call = tool.execute({
      assignment: { workspaceId: ws, missionId: mission, taskId: t.asking, roleId: 'design' }, assignmentId: 'wa_none', runId: null, signal: controller.signal,
    }, { question: 'Which flow first?' });
    const card = await h.until(() => pending(t.asking)[0], 2000, 10);
    check('8: ask_human from Ana\'s agent is addressed to Ana', card !== undefined && eq(card.addressees, [ana.id]), card?.addressees);
    const requested = h.repo.events.listByMission(mission).find((e) => e.body.type === 'approval.requested' && e.body.approvalId === card?.id);
    check('F9: the approval.requested event of ask_human carries the agent as actor', requested?.actorId === anaAgent.id, requested && { actor: requested.actorId });
    controller.abort();
    await call.catch(() => {});

    // Inside a real run the run's agent is the actor, whatever the task row says.
    const { DATABASE } = await import('@tandemise/persistence');
    const { ids: r } = await addMission([{ key: 'asking_run', dispatch: false }]);
    h.repo.tasks.update(r.asking_run, { status: 'RUNNING', assigneeId: null, responsibleId: ana.id });
    const db = h.container.resolve(DATABASE);
    db.handle.pragma('foreign_keys = OFF');
    const runId = ids.run();
    h.repo.runs.create({
      id: runId, missionId: task(r.asking_run).missionId, taskId: r.asking_run, assignmentId: 'wa_none', attempt: 1, status: 'RUNNING', roleId: 'design',
      runtimeProfileId: fast, executionTargetId: 'et_none', externalSessionId: null, pid: null, exitCode: null, errorCode: null, errorMessage: null,
      usage: null, startedAt: now(), finishedAt: null, heartbeatAt: null, agentMemberId: anaAgent.id,
    });
    db.handle.pragma('foreign_keys = ON');
    const inRun = new AbortController();
    const runCall = tool.execute({
      assignment: { workspaceId: ws, missionId: task(r.asking_run).missionId, taskId: r.asking_run, roleId: 'design' }, assignmentId: 'wa_none', runId, signal: inRun.signal,
    }, { question: 'Which flow second?' });
    const runCard = await h.until(() => pending(r.asking_run)[0], 2000, 10);
    const runRequested = h.repo.events.listByMission(task(r.asking_run).missionId).find((e) => e.body.type === 'approval.requested' && e.body.approvalId === runCard?.id);
    check('F9: inside a run, ask_human\'s approval.requested carries the run\'s agent', runRequested?.actorId === anaAgent.id && runRequested?.runId === runId,
      runRequested && { actor: runRequested.actorId, run: runRequested.runId });
    inRun.abort();
    await runCall.catch(() => {});
  }

  // ---- concern 4: a tool approval is the responsible person's, and it escalates
  {
    const { APPROVAL_GATE } = await import('@tandemise/integrations-core');
    const { DATABASE } = await import('@tandemise/persistence');
    const { mission, ids: t } = await addMission([{ key: 'tooling', dispatch: false }]);
    const snapshot = { staffing: { ...D.BASE_STAFFING, escalateAfterMs: 50 }, executor: 'agent', claimable: [], agentCandidateIds: [anaAgent.id], humanStep: false };
    h.repo.tasks.update(t.tooling, { status: 'RUNNING', assigneeId: anaAgent.id, responsibleId: ana.id, staffing: snapshot });
    // The assignment's profile and target rows are outside this fixture.
    const db = h.container.resolve(DATABASE);
    db.handle.pragma('foreign_keys = OFF');
    const assignment = h.container.resolve(h.app.ASSIGNMENT_REPOSITORY).create({
      id: ids.workerAssignment(), workspaceId: ws, missionId: mission.id, taskId: t.tooling, roleId: 'design',
      runtimeProfileId: fast, executionTargetId: 'et_none', grants: [], budgets: { maxWallTimeMs: 60000, maxAttempts: 1 }, createdAt: now(),
    });
    db.handle.pragma('foreign_keys = ON');
    const controller = new AbortController();
    const asked = h.container.resolve(APPROVAL_GATE).requestApproval({
      toolName: 'email.send', capability: 'email.send', assignmentId: assignment.id, risk: 'external_side_effect',
      reason: 'this workspace asks before external writes', inputSummary: 'send the launch email',
    }, controller.signal);
    const card = await h.until(() => pending(t.tooling)[0], 2000, 10);
    check('concern 4: a tool approval on Ana\'s agent\'s task is addressed to Ana', card !== undefined && eq(card.addressees, [ana.id]), card?.addressees);
    const climbed = await h.until(() => pending(t.tooling)[0]?.addressees.includes(maria.id), 2000, 10);
    check('concern 4: and it escalates up Ana\'s chain', climbed === true && pending(t.tooling)[0]?.escalationLevel >= 1, pending(t.tooling)[0]?.addressees);
    const toolRequested = eventsOf(mission.id, 'approval.requested').find((e) => e.body.approvalId === card?.id);
    check('F9: a tool approval\'s approval.requested carries the agent as actor', toolRequested?.actorId === anaAgent.id, toolRequested && { actor: toolRequested.actorId });
    controller.abort();
    await asked.catch(() => {});
    const withdrawn = h.repo.approvals.get(card.id);
    check('fix 2: a tool card whose run ended is withdrawn, not left pending', withdrawn?.status === 'CANCELLED' && withdrawn?.escalateAt === null,
      { s: withdrawn?.status, at: withdrawn?.escalateAt });
    const level = withdrawn?.escalationLevel;
    await h.sleep(80);
    await h.scheduler.tick();
    check('fix 2: and it does not escalate afterwards', h.repo.approvals.get(card.id)?.escalationLevel === level);

    // Defensive: a card left PENDING on work nothing waits on any more (a
    // daemon that died mid-call, say) stops escalating instead of climbing.
    const { APPROVAL_FACTORY } = await import('@tandemise/policy');
    h.repo.tasks.update(t.tooling, { status: 'SUCCEEDED' });
    const stray = h.container.resolve(APPROVAL_FACTORY).createOrThrow({
      workspaceId: ws, missionId: mission.id, taskId: t.tooling, kind: 'action', risk: 'external_side_effect',
      title: 'Allow email.send?', rationale: 'r', effect: 'e', evidence: [{ kind: 'text', label: 'x', value: 'y' }],
      addressees: [ana.id], escalateAfterMs: 1,
    });
    h.repo.approvals.create(stray);
    await h.sleep(10);
    await h.scheduler.tick();
    const after = h.repo.approvals.get(stray.id);
    check('fix 2: the sweep never escalates a card whose task is no longer waiting', eq(after?.addressees, [ana.id]) && after?.escalateAt === null && after?.escalationLevel === 0,
      after && { a: after.addressees, at: after.escalateAt, l: after.escalationLevel });
  }

  // ---- round 2: a "not converging" card on a succeeded task in a blocked mission still escalates
  {
    const { APPROVAL_FACTORY } = await import('@tandemise/policy');
    const { mission, ids: t } = await addMission([{ key: 'converge', roleId: 'review', dispatch: false }]);
    // The state remediation leaves when its cycles run out: the evaluator
    // succeeded, the mission is BLOCKED on the intervention card.
    h.repo.tasks.update(t.converge, { status: 'SUCCEEDED', assigneeId: anaAgent.id, responsibleId: ana.id });
    h.repo.missions.update(mission.id, { status: 'BLOCKED', statusReason: 'not converging' });
    const card = h.container.resolve(APPROVAL_FACTORY).createOrThrow({
      workspaceId: ws, missionId: mission.id, taskId: t.converge, kind: 'intervention', risk: 'read',
      title: 'converge is not converging', rationale: 'r', effect: 'e', evidence: [{ kind: 'text', label: 'x', value: 'y' }],
      addressees: [ana.id], escalateAfterMs: 1,
    });
    h.repo.approvals.create(card);
    await h.sleep(10);
    await h.scheduler.tick();
    const after = h.repo.approvals.get(card.id);
    check('round 2: an intervention on a blocked mission escalates to the next person up',
      eq(after?.addressees, [ana.id, maria.id]) && after?.escalationLevel === 1 && after?.escalateAt !== null,
      after && { a: after.addressees, l: after.escalationLevel, at: after.escalateAt });
  }

  // ---- fix 3: a sign-off card climbs from the lead, never down to Ana
  {
    h.services.team.updateMember(caller, maria.id, { oversight: 'both_sign_off' });
    const { mission, ids: t } = await addMission([{ key: 'signed', staffingOverride: { escalateAfterMs: 60000 } }]);
    await settled(t.signed);
    await h.services.approvals.decide(caller, pending(t.signed)[0].id, { optionId: 'approve', onBehalfOf: ana.id });
    const signOff = pending(t.signed)[0];
    check('fix 3: the sign-off card is addressed to Maria', eq(signOff?.addressees, [maria.id]), signOff?.addressees);
    // Due now, rather than waiting a real escalation period.
    h.repo.approvals.update(signOff.id, { escalateAt: new Date(Date.now() - 1).toISOString() });
    await h.scheduler.tick();
    const climbed = h.repo.approvals.get(signOff.id);
    check('fix 3: it escalates to the owner, not to Ana', eq(climbed?.addressees, [maria.id, owner]) && climbed?.escalationLevel === 1, climbed?.addressees);
    h.services.team.updateMember(caller, maria.id, { oversight: 'delegate_owns' });
    void mission;
  }

  // ---- concern 5: a plan approval is for whoever asked for the mission
  {
    const planCard = async (missionId) => {
      // A DRAFT is planned only once it has a Done-when criterion (P6); rows written straight to the repository have none.
      const ledger = h.container.resolve(h.app.MISSION_CRITERIA_REPOSITORY);
      if (ledger.listActive(missionId).length === 0) ledger.addUserCriteria(missionId, ['The onboarding plan exists']);
      await h.services.planning.plan(missionId);
      return h.repo.approvals.list({ missionId, statuses: ['PENDING'] }).find((a) => a.kind === 'plan');
    };
    const created = await h.services.missions.create(caller, { workspaceId: ws, goal: 'Plan the onboarding', title: 'Planned' });
    const byCreator = await planCard(created.id);
    check('concern 5: a plan approval is addressed to the mission\'s creator', created.createdBy === owner && eq(byCreator?.addressees, [owner]),
      { createdBy: created.createdBy, a: byCreator?.addressees });
    const planDoc = h.repo.artifacts.listByMission(created.id).find((a) => a.type === 'MissionPlan');
    check('C4: the MissionPlan artifact is by the runtime and answered for by the mission\'s creator',
      planDoc?.authorId === 'system:runtime' && planDoc?.responsibleId === owner, planDoc && { a: planDoc.authorId, r: planDoc.responsibleId });
    const anonymous = h.repo.missions.create({ id: ids.mission(), workspaceId: ws, repositoryId: null, title: 'Nobody\'s', goal: 'Plan something' });
    const byOwners = await planCard(anonymous.id);
    check('concern 5: with no creator it is addressed to the owners', anonymous.createdBy === null && eq(byOwners?.addressees, [owner]),
      { createdBy: anonymous.createdBy, a: byOwners?.addressees });
    const leaver = person('Leaver', owner);
    h.services.team.removeMember(caller, leaver.id);
    const orphaned = h.repo.missions.create({ id: ids.mission(), workspaceId: ws, repositoryId: null, title: 'Left behind', goal: 'Plan something', createdBy: leaver.id });
    const byOwnersAgain = await planCard(orphaned.id);
    check('fix 6: a creator who has left the team is passed over for the owners', eq(byOwnersAgain?.addressees, [owner]), byOwnersAgain?.addressees);
  }

  // ---- ruling 2: the pipeline position survives a restart
  // The daemon restarts while review 1 of 2 is pending, so only the card's own
  // evidence can tell the fresh one that a second review follows.
  {
    const { ids: t } = await addMission([{ key: 'twice', staffingOverride: { reviews: [blocking, { by: [maria.id], mode: 'blocking', when: 'always' }] } }]);
    await settled(t.twice);
    const first = pending(t.twice);
    check('restart: review 1/2 is pending for Ana before the restart',
      first.length === 1 && eq(first[0].addressees, [ana.id]) && first[0].evidence.some((e) => e.label === 'Review' && e.value === '1/2'),
      first.map((c) => [c.addressees, c.evidence.filter((e) => e.label === 'Review')]));
    await h.scheduler.drain();
    await h.container.dispose();
    h = await engineHarness(HOME, 'staffing-reviews-restart');
    if (first[0] !== undefined) await h.services.approvals.decide(caller, first[0].id, { optionId: 'approve', onBehalfOf: ana.id });
    const second = pending(t.twice);
    check('restart: the fresh daemon files Review 2/2 for Maria and keeps the task waiting',
      task(t.twice).status === 'AWAITING_APPROVAL' && second.length === 1 && eq(second[0].addressees, [maria.id])
        && second[0].evidence.some((e) => e.label === 'Review' && e.value === '2/2'),
      { s: task(t.twice).status, cards: second.map((c) => [c.addressees, c.evidence.filter((e) => e.label === 'Review')]) });
    if (second[0] !== undefined) await h.services.approvals.decide(caller, second[0].id, { optionId: 'approve', onBehalfOf: maria.id });
    check('restart: only approving Review 2/2 succeeds the task',
      second[0] !== undefined && task(t.twice).status === 'SUCCEEDED' && pending(t.twice).length === 0, { s: task(t.twice).status });
  }

  await h.scheduler.drain();
  clearInterval(keepAlive);
  await h.container.dispose();
}

section('http: principal, team and staffing routes');
{
  const { mkdtempSync, writeFileSync, rmSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFileSync } = await import('node:child_process');

  // Short on purpose: macOS caps unix socket paths at 104 bytes.
  const root = mkdtempSync(join(tmpdir(), 'tdh-'));
  const home = join(root, 'h');
  const repo = join(root, 'r');
  // The daemon names the local person from git; a private global config keeps that deterministic.
  const gitConfig = join(root, 'gitconfig');
  writeFileSync(gitConfig, '[user]\n\tname = Http Tester\n\temail = http@example.com\n');
  const savedEnv = { GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, TANDEMISE_OWNER_NAME: process.env.TANDEMISE_OWNER_NAME };
  process.env.GIT_CONFIG_GLOBAL = gitConfig;
  delete process.env.TANDEMISE_OWNER_NAME;
  const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { stdio: 'ignore' });
  writeFileSync(join(repo, 'README.md'), '# http check\n');
  git('add', '.');
  git('commit', '-q', '-m', 'init');

  const { startDaemon } = await import('../apps/daemon/dist/main.js');
  let daemon = await startDaemon({ home, logLevel: 'error', tickIntervalMs: 200 });
  let token = JSON.parse(readFileSync(join(home, 'daemon.json'), 'utf8')).token;
  const api = async (method, path, body) => {
    const res = await fetch(`${daemon.url}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`, 'x-tandemise-api-version': 'v1',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined };
  };
  const errCode = (r) => `${r.status} ${r.body?.error?.code}`;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const poll = async (fn, ms = 60_000) => {
    for (const until = Date.now() + ms; Date.now() < until; await sleep(250)) {
      const v = await fn();
      if (v) return v;
    }
    return undefined;
  };

  try {
    const me0 = await api('GET', '/v1/me');
    check('http: GET /v1/me names the local person from git config', me0.status === 200 && me0.body?.person?.displayName === 'Http Tester' && eq(me0.body.memberships, []), me0);

    const wsRes = await api('POST', '/v1/workspaces', { name: 'Http', repositoryPath: repo });
    const ws = wsRes.body?.workspace?.id;
    const me = await api('GET', '/v1/me');
    const owner = me.body?.memberships?.[0]?.memberId;
    check('http: the creator owns the new workspace', wsRes.status === 200 && me.body?.memberships?.length === 1 && me.body.memberships[0].access === 'owner' && me.body.memberships[0].workspaceId === ws, me.body);

    // ---- people
    const ana = (await api('POST', '/v1/people', { displayName: 'Ana' })).body;
    const bo = (await api('POST', '/v1/people', { displayName: 'Bo' })).body;
    const leaver = (await api('POST', '/v1/people', { displayName: 'Leaver' })).body;
    const renamed = await api('PATCH', `/v1/people/${bo?.id}`, { displayName: 'Bob' });
    check('http: people create and rename', typeof ana?.id === 'string' && renamed.status === 200 && renamed.body?.displayName === 'Bob', renamed);
    const badPerson = await api('POST', '/v1/people', { displayName: '' });
    check('http: an empty person name is 400 VALIDATION', errCode(badPerson) === '400 VALIDATION', badPerson.body);
    const people = await api('GET', '/v1/people');
    check('http: GET /v1/people lists them', people.status === 200 && ['Http Tester', 'Ana', 'Bob', 'Leaver'].every((n) => people.body?.some((p) => p.displayName === n)), people.body);

    // ---- members
    const anaM = await api('POST', `/v1/workspaces/${ws}/members`, { kind: 'person', personId: ana.id, reportsTo: owner });
    const boM = await api('POST', `/v1/workspaces/${ws}/members`, { kind: 'person', personId: bo.id, reportsTo: owner });
    const leaverM = await api('POST', `/v1/workspaces/${ws}/members`, { kind: 'person', personId: leaver.id });
    const agentM = await api('POST', `/v1/workspaces/${ws}/members`, { kind: 'agent', name: 'Ana agent', reportsTo: anaM.body?.id, roleIds: ['design'] });
    check('http: members added (person and agent)', [anaM, boM, leaverM, agentM].every((r) => r.status === 200) && agentM.body?.ownerName === 'Ana' && boM.body?.name === 'Bob', [anaM, boM, agentM].map(errCode));
    const agentless = await api('POST', `/v1/workspaces/${ws}/members`, { kind: 'agent', name: 'Nobody', roleIds: ['design'] });
    check('http: an agent without an owner is 400 VALIDATION', errCode(agentless) === '400 VALIDATION', agentless.body);
    const titled = await api('PATCH', `/v1/members/${boM.body?.id}`, { title: 'QA lead' });
    check('http: PATCH /v1/members/:id', titled.status === 200 && titled.body?.title === 'QA lead', titled.body);
    const lastOwner = await api('DELETE', `/v1/members/${owner}`);
    check('http: removing the last owner is 409 CONFLICT', errCode(lastOwner) === '409 CONFLICT', lastOwner.body);
    const demote = await api('PATCH', `/v1/members/${owner}`, { access: 'member' });
    check('http: demoting the last owner is 409 CONFLICT', errCode(demote) === '409 CONFLICT', demote.body);
    {
      // F13: the member drawer saving the top owner. The drawer sends every field it shows; "Nobody (top of the team)" is null.
      const drawerBody = { reportsTo: null, access: 'owner', oversight: 'both_sign_off', title: null, roleIds: [] };
      const saved = await api('PATCH', `/v1/members/${owner}`, drawerBody);
      check('F13: saving the top owner from the drawer stores oversight and keeps reportsTo null',
        saved.status === 200 && saved.body?.oversight === 'both_sign_off' && saved.body?.reportsTo === null, saved.body);
      // What the drawer used to send for a top member: its own id.
      const selfRef = await api('PATCH', `/v1/members/${owner}`, { ...drawerBody, reportsTo: owner });
      check('F13: reporting to yourself is 400 VALIDATION naming the self-reference, not a cycle for every member',
        errCode(selfRef) === '400 VALIDATION' && /report to themselves/.test(selfRef.body?.error?.message ?? '') && !/cycle/.test(selfRef.body?.error?.message ?? ''), selfRef.body);
      const empty = await api('PATCH', `/v1/members/${owner}`, { ...drawerBody, reportsTo: '' });
      check('F13: an empty reportsTo is 400 VALIDATION, not an id', errCode(empty) === '400 VALIDATION', empty.body);
      const after = (await api('GET', `/v1/workspaces/${ws}/members`)).body?.find((m) => m.id === owner);
      check('F13: the rejected saves changed nothing', after?.reportsTo === null && after?.oversight === 'both_sign_off', after && { r: after.reportsTo, o: after.oversight });
      await api('PATCH', `/v1/members/${owner}`, { oversight: 'delegate_owns' });
    }
    const removedSeat = await api('DELETE', `/v1/members/${leaverM.body?.id}`);
    const removedPerson = await api('DELETE', `/v1/people/${leaver.id}`);
    check('http: DELETE member and person answer 204', removedSeat.status === 204 && removedPerson.status === 204, [removedSeat.status, removedPerson.status]);
    const members = await api('GET', `/v1/workspaces/${ws}/members`);
    check('http: GET members includes the removed seat as removed',
      members.status === 200 && members.body.length === 5 && members.body.find((m) => m.id === leaverM.body?.id)?.status === 'removed', Array.isArray(members.body) ? members.body.map((m) => [m.name, m.status]) : members.body);
    const team = await api('GET', `/v1/workspaces/${ws}/team`);
    check('http: GET team has the owner as a root and no issues', team.status === 200 && team.body.roots.includes(owner) && eq(team.body.issues, []), team.body);

    // ---- workspace staffing, per role (A14 over HTTP)
    const fake = (await api('POST', '/v1/runtimes', { adapterId: 'fake', name: 'Fake', workspaceId: ws })).body?.id;
    const s1 = await api('PATCH', `/v1/workspaces/${ws}/staffing`, { design: { assignees: [agentM.body?.id] } });
    const s2 = await api('PATCH', `/v1/workspaces/${ws}/staffing`, { qa: { assignees: [anaM.body?.id, boM.body?.id], mode: 'pool' } });
    check('http: PATCH staffing for one role keeps the others (A14)',
      s1.status === 200 && s2.status === 200 && eq(s2.body?.design?.assignees, [agentM.body?.id]) && s2.body?.qa?.mode === 'pool', s2.body);
    const routed = await api('PATCH', `/v1/workspaces/${ws}`, { routing: { review: [fake] } });
    const s3 = await api('GET', `/v1/workspaces/${ws}/staffing`);
    check('http: PATCH routing for one role keeps other roles\' staffing (A14)',
      routed.status === 200 && s3.status === 200 && eq(s3.body?.design?.assignees, [agentM.body?.id]) && s3.body?.qa?.mode === 'pool' && s3.body?.review?.assignees?.length === 1, s3.body);
    const unknown = await api('PATCH', `/v1/workspaces/${ws}/staffing`, { design: { assignees: ['mem_nope'] } });
    check('http: an unknown member in staffing is 400 VALIDATION', errCode(unknown) === '400 VALIDATION', unknown.body);
    const agentResponsible = await api('PATCH', `/v1/workspaces/${ws}/staffing`, { design: { responsible: agentM.body?.id } });
    check('http: an agent as responsible is 400 VALIDATION', errCode(agentResponsible) === '400 VALIDATION', agentResponsible.body);

    // ---- mission, plan approval on behalf, mission/task staffing, preview, claim
    const badCreate = await api('POST', '/v1/missions', { workspaceId: ws, goal: 'Update the readme', onBehalfOf: agentM.body?.id });
    check('http: createMission onBehalfOf an agent is 400 VALIDATION', errCode(badCreate) === '400 VALIDATION', badCreate.body);
    const created = await api('POST', '/v1/missions', { workspaceId: ws, goal: 'Update the readme with a usage section', successCriteria: ['The readme has a usage section'], onBehalfOf: anaM.body?.id });
    const missionId = created.body?.mission?.id;
    check('http: createMission onBehalfOf a person', created.status === 200 && created.body?.mission?.createdBy === anaM.body?.id, created.body?.mission ?? created.body);
    await api('POST', `/v1/missions/${missionId}/plan`);
    const planned = await poll(async () => {
      const d = await api('GET', `/v1/missions/${missionId}`);
      return d.body?.mission?.status !== 'PLANNING' ? d.body : undefined;
    });
    const tasks = planned?.tasks ?? [];
    check('http: the mission planned into tasks', tasks.length > 1, planned?.mission?.status);
    const first = tasks.find((t) => t.dependsOn.length === 0);
    const later = tasks.find((t) => t.dependsOn.length > 0);
    check('http: a PENDING task view carries wouldBe with a responsible person',
      later?.status === 'PENDING' && typeof later?.wouldBe?.responsible?.id === 'string' && ['agent', 'human'].includes(later?.wouldBe?.executor), later && { status: later.status, wouldBe: later.wouldBe });

    // Escalates a few seconds after it starts waiting, so the inbox check below sees it both ways.
    const ms = await api('PATCH', `/v1/missions/${missionId}/staffing`, { [first?.roleId]: { assignees: [anaM.body?.id, boM.body?.id], mode: 'pool', escalateAfterMs: 3000 } });
    const ms2 = await api('PATCH', `/v1/missions/${missionId}/staffing`, { zzz: { mode: 'first_available' } });
    check('http: PATCH mission staffing merges per role', ms.status === 200 && ms2.status === 200 && ms2.body?.[first?.roleId]?.mode === 'pool' && ms2.body?.zzz?.mode === 'first_available', ms2.body);
    const ts = await api('PATCH', `/v1/tasks/${later?.id}/staffing`, { assignees: [boM.body?.id] });
    check('http: PATCH task staffing sets the override', ts.status === 200 && eq(ts.body?.staffingOverride?.assignees, [boM.body?.id]), ts.body?.staffingOverride ?? ts.body);
    const cleared = await api('PATCH', `/v1/tasks/${later?.id}/staffing`, null);
    check('http: PATCH task staffing with null clears the override', cleared.status === 200 && (cleared.body?.staffingOverride ?? null) === null, cleared.body?.staffingOverride ?? cleared.body);
    const badTask = await api('PATCH', `/v1/tasks/${later?.id}/staffing`, { assignees: ['mem_nope'] });
    check('http: an unknown member in a task override is 400 VALIDATION', errCode(badTask) === '400 VALIDATION', badTask.body);
    const preview = await api('GET', `/v1/tasks/${first?.id}/staffing/preview`);
    check('http: preview resolves the pool without saving',
      preview.status === 200 && preview.body?.resolved?.executor === 'human' && eq(preview.body.resolved.claimable.map((a) => a.name).sort(), ['Ana', 'Bob']) && preview.body.escalation.length > 0, preview.body);

    const start = await api('POST', `/v1/missions/${missionId}/start`);
    const approvalId = start.body?.error?.details?.approvalId;
    check('http: start asks for plan approval first', start.status === 428 && typeof approvalId === 'string', start.body);
    const badDecide = await api('POST', `/v1/approvals/${approvalId}/decide`, { optionId: 'approve', onBehalfOf: agentM.body?.id });
    check('http: decide onBehalfOf an agent is 400 VALIDATION', errCode(badDecide) === '400 VALIDATION', badDecide.body);
    const decided = await api('POST', `/v1/approvals/${approvalId}/decide`, { optionId: 'approve', onBehalfOf: anaM.body?.id });
    check('http: decide onBehalfOf records Ana, recorded by the principal',
      decided.status === 200 && decided.body?.decidedByRef?.id === anaM.body?.id && decided.body?.recordedByRef?.id === owner, decided.body && { d: decided.body.decidedByRef, r: decided.body.recordedByRef, e: decided.body.error });
    const started = await api('POST', `/v1/missions/${missionId}/start`);
    check('http: the mission starts', started.status === 200, started.body);

    const waiting = await poll(async () => {
      const d = await api('GET', `/v1/missions/${missionId}`);
      return d.body?.tasks?.find((t) => t.id === first?.id && t.status === 'AWAITING_HUMAN');
    });
    check('http: the pooled task waits for a person', waiting !== undefined);
    {
      // final I4: one request for everything waiting on a person.
      const other = await api('POST', '/v1/missions', { workspaceId: ws, goal: 'Write a changelog entry for the usage section', successCriteria: ['The changelog names the usage section'], planNow: true });
      const inboxOf = () => api('GET', `/v1/inbox?workspaceId=${ws}`);
      const withPlan = await poll(async () => {
        const r = await inboxOf();
        return r.body?.approvals?.some((v) => v.approval.missionId === other.body?.mission?.id) ? r : undefined;
      });
      const inbox = withPlan ?? await inboxOf();
      const plan = inbox.body?.approvals?.find((v) => v.approval.missionId === other.body?.mission?.id);
      check('http: GET /v1/inbox lists a pending approval addressed to me, as an approval view',
        inbox.status === 200 && plan?.approval?.status === 'PENDING' && plan?.addressees?.some((a) => a.id === owner) && typeof plan?.missionTitle === 'string'
          && (inbox.body?.approvals ?? []).every((v) => v.approval.status === 'PENDING'),
        inbox.body?.approvals?.map((v) => [v.approval.kind, v.approval.status, v.addressees]) ?? inbox.body);
      const human = inbox.body?.tasks?.find((t) => t.id === first?.id);
      check('http: GET /v1/inbox lists the human task, light: named people and its mission, not a full task view',
        human !== undefined && eq(Object.keys(human).sort(), ['assignee', 'claimable', 'escalatedTo', 'id', 'key', 'missionId', 'missionTitle', 'responsible', 'statusReason', 'title', 'updatedAt'])
          && human.missionId === missionId && human.missionTitle === planned?.mission?.title && eq(human.claimable.map((a) => a.name).sort(), ['Ana', 'Bob']) && human.assignee === null
          && typeof human.responsible?.id === 'string',
        human ?? inbox.body?.tasks);
      const escalated = await poll(async () => (await inboxOf()).body?.tasks?.find((t) => t.id === first?.id && t.escalatedTo.length > 0), 15_000);
      check('http: GET /v1/inbox shows an escalated pool with who it reached', escalated !== undefined && eq(escalated.escalatedTo.map((a) => a.id), [owner]) && escalated.claimable.some((a) => a.id === owner),
        escalated ?? (await inboxOf()).body?.tasks);
      const missing = await api('GET', '/v1/inbox');
      check('http: GET /v1/inbox without a workspace is 400 VALIDATION', errCode(missing) === '400 VALIDATION', missing.body);
      await api('POST', `/v1/missions/${other.body?.mission?.id}/cancel`, { reason: 'check done' });
    }
    {
      const d = await api('GET', `/v1/missions/${missionId}`);
      const decided = (d.body?.tasks ?? []).filter((t) => t.status !== 'PENDING');
      check('http: a task past PENDING (READY or later) carries no wouldBe',
        decided.length > 0 && decided.every((t) => t.wouldBe === null), decided.map((t) => [t.status, t.wouldBe]));
    }
    const badClaim = await api('POST', `/v1/tasks/${first?.id}/claim`, { onBehalfOf: agentM.body?.id });
    check('http: claim onBehalfOf an agent is 400 VALIDATION', errCode(badClaim) === '400 VALIDATION', badClaim.body);
    const claimed = await api('POST', `/v1/tasks/${first?.id}/claim`, { onBehalfOf: boM.body?.id });
    check('http: claim onBehalfOf Bob assigns Bob', claimed.status === 200 && claimed.body?.assignee?.id === boM.body?.id && claimed.body?.responsible?.id === boM.body?.id, claimed.body && { a: claimed.body.assignee, r: claimed.body.responsible, e: claimed.body.error });
    const done = await api('POST', `/v1/tasks/${first?.id}/complete`, { result: 'Wrote it.', onBehalfOf: boM.body?.id });
    check('http: complete onBehalfOf Bob', done.status === 200, done.body?.error ?? done.body?.status);
    {
      const d = await api('GET', `/v1/missions/${missionId}`);
      const art = d.body?.tasks?.find((t) => t.id === first?.id)?.outputArtifacts?.[0];
      const read = await api('GET', `/v1/artifacts/${art?.id}`);
      check('http: GET /v1/artifacts/:id carries author and responsible from the database',
        read.status === 200 && read.body?.manifest?.author?.id === boM.body?.id && read.body?.manifest?.responsible?.id === boM.body?.id && read.body?.manifest?.recordedByRef?.id === owner,
        read.body?.manifest && { a: read.body.manifest.author, r: read.body.manifest.responsible, rec: read.body.manifest.recordedByRef });
      const listed = await api('GET', `/v1/artifacts?workspaceId=${ws}`);
      const ids = (listed.body ?? []).map((a) => a.id);
      const times = (listed.body ?? []).map((a) => a.createdAt);
      check('http: an empty artifact search lists the workspace newest first, without superseded versions',
        listed.status === 200 && ids.includes(art?.id) && times.every((t, i) => i === 0 || times[i - 1] >= t) && (listed.body ?? []).every((a) => !ids.includes(a.supersedes)),
        { status: listed.status, n: ids.length });
    }
    const lateEdit = await api('PATCH', `/v1/tasks/${first?.id}/staffing`, { assignees: [anaM.body?.id] });
    check('http: editing a started task\'s staffing is 409 CONFLICT', errCode(lateEdit) === '409 CONFLICT', lateEdit.body);
    await api('POST', `/v1/missions/${missionId}/cancel`, { reason: 'check done' });

    // ---- final I5: staffing sent with the create request is in place before planning can make anything READY
    {
      const autonomy = (await api('GET', `/v1/workspaces/${ws}`)).body?.workspace?.autonomy;
      await api('PATCH', `/v1/workspaces/${ws}`, { autonomy: { ...autonomy, planApproval: 'auto' } });
      const countBefore = (await api('GET', `/v1/missions?workspaceId=${ws}`)).body?.length;
      const badStaffed = await api('POST', '/v1/missions', { workspaceId: ws, goal: 'Update the readme with a usage section', staffing: { [first?.roleId]: { assignees: ['mem_nope'] } } });
      check('http: createMission with invalid staffing is 400 VALIDATION', errCode(badStaffed) === '400 VALIDATION', badStaffed.body);
      check('http: the rejected create made no mission', (await api('GET', `/v1/missions?workspaceId=${ws}`)).body?.length === countBefore);
      const staffedCreate = await api('POST', '/v1/missions', {
        workspaceId: ws, goal: 'Update the readme with a usage section', successCriteria: ['The readme has a usage section'], planNow: true,
        staffing: { [first?.roleId]: { assignees: [boM.body?.id], mode: 'first_available' } },
      });
      const staffedId = staffedCreate.body?.mission?.id;
      check('http: createMission stores its staffing with the mission', staffedCreate.status === 200 && eq(staffedCreate.body?.mission?.staffing?.[first?.roleId]?.assignees, [boM.body?.id]),
        staffedCreate.body?.mission?.staffing ?? staffedCreate.body);
      // Auto plan approval leaves the plan ready to start with no card to decide.
      await poll(async () => ((await api('GET', `/v1/missions/${staffedId}`)).body?.tasks?.length ?? 0) > 0);
      const startedStaffed = await api('POST', `/v1/missions/${staffedId}/start`);
      check('http: the auto-approved plan starts without a plan approval', startedStaffed.status === 200, startedStaffed.body);
      const firstStaffed = await poll(async () => {
        const d = await api('GET', `/v1/missions/${staffedId}`);
        return d.body?.tasks?.find((t) => t.dependsOn.length === 0 && t.status !== 'PENDING' && t.staffing != null);
      });
      check('http: with auto plan approval, the first READY task\'s snapshot already reflects the create request\'s staffing',
        firstStaffed !== undefined && firstStaffed.staffing?.executor === 'human' && eq(firstStaffed.staffing?.staffing?.assignees, [boM.body?.id]) && firstStaffed.assignee?.id === boM.body?.id,
        firstStaffed ? { s: firstStaffed.status, snap: firstStaffed.staffing, a: firstStaffed.assignee } : await (async () => { const d = (await api('GET', `/v1/missions/${staffedId}`)).body; return { m: d?.mission?.status, r: d?.mission?.statusReason, t: d?.tasks?.map((t) => [t.key, t.roleId, t.status, t.dependsOn, t.staffing]) }; })());
      await api('POST', `/v1/missions/${staffedId}/cancel`, { reason: 'check done' });
      await api('PATCH', `/v1/workspaces/${ws}`, { autonomy });
    }

    // ---- final I6: over HTTP, a principal without a seat in the workspace is refused
    {
      const ws2 = (await api('POST', '/v1/workspaces', { name: 'Seatless' })).body?.workspace?.id;
      const me2 = (await api('GET', '/v1/me')).body?.memberships?.find((m) => m.workspaceId === ws2)?.memberId;
      await api('POST', `/v1/workspaces/${ws2}/members`, { kind: 'person', personId: ana.id, access: 'owner' });
      // The daemon's one token always acts as the local person, so the seat is taken away underneath it.
      const { openDatabase } = await import('../packages/persistence/dist/index.js');
      const { createPaths } = await import('@tandemise/shared');
      const side = openDatabase({ path: createPaths(home).db });
      side.handle.prepare("UPDATE members SET status = 'removed' WHERE id = ?").run(me2);
      side.handle.close();
      const staffing403 = await api('PATCH', `/v1/workspaces/${ws2}/staffing`, { design: { mode: 'pool' } });
      check('http: PATCH staffing without a seat is 403 PERMISSION_DENIED', errCode(staffing403) === '403 PERMISSION_DENIED', staffing403.body);
      const member403 = await api('POST', `/v1/workspaces/${ws2}/members`, { kind: 'person', personId: bo.id });
      check('http: adding a member without a seat is 403 PERMISSION_DENIED', errCode(member403) === '403 PERMISSION_DENIED', member403.body);
      const otherSeat = await api('DELETE', `/v1/members/${boM.body?.id}`);
      check('http: in a workspace where the principal has a seat, removing someone else\'s seat still works', otherSeat.status === 204, otherSeat.body);
      const ownSeat = await api('DELETE', `/v1/members/${owner}`);
      check('http: removing your own seat is 409 CONFLICT', errCode(ownSeat) === '409 CONFLICT', ownSeat.body);
    }

    // ---- the git name is adopted once and never over a name the user chose
    await api('PATCH', `/v1/people/${me0.body.person.id}`, { displayName: 'Chosen' });
    await daemon.stop();
    daemon = await startDaemon({ home, logLevel: 'error', tickIntervalMs: 200 });
    token = JSON.parse(readFileSync(join(home, 'daemon.json'), 'utf8')).token;
    const meAfter = await api('GET', '/v1/me');
    check('http: a restart keeps a name the user changed', meAfter.body?.person?.displayName === 'Chosen', meAfter.body?.person);
  } finally {
    await daemon.stop();
    for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    rmSync(root, { recursive: true, force: true });
  }
}

section('runtimes: names in reasons and capability overrides');
{
  const { RuntimeManager, RuntimeRegistry, describeRejections } = await import('@tandemise/runtimes-core');
  const { GenericCliAdapter, FakeRuntimeAdapter } = await import('@tandemise/runtime-generic');
  const { CodexAdapter } = await import('@tandemise/runtime-codex');
  const { ClaudeCodeAdapter } = await import('@tandemise/runtime-claude');
  const { systemClock, ids } = await import('@tandemise/shared');
  const generic = new GenericCliAdapter();
  const manager = new RuntimeManager({ registry: new RuntimeRegistry([generic, new FakeRuntimeAdapter()]), clock: systemClock });
  const profile = (over) => ({
    id: ids.runtimeProfile(), workspaceId: null, adapterId: generic.id, name: 'Scripted agent', executablePath: null, args: [],
    settings: { command: '/bin/echo', versionArgs: ['1.0.0'] }, capabilities: [], enabled: true, maxConcurrent: 1,
    createdAt: systemClock.now(), updatedAt: systemClock.now(), ...over,
  });

  // F4: a blocked reason names the runtime, not its id.
  const lacking = profile({ capabilities: ['reasoning'] });
  const rejected = await manager.select([lacking], ['reasoning', 'mcp']);
  const line = rejected.ok || typeof describeRejections !== 'function' ? '' : describeRejections(rejected.error.rejections);
  check('F4: a missing-capabilities rejection is described by the profile\'s quoted name',
    !rejected.ok && line === "'Scripted agent': missing capabilities: mcp" && !line.includes(lacking.id), rejected.ok ? 'selected' : { line, rejections: rejected.error.rejections });

  // F5: the profile's capabilities override what the adapter reports.
  const overridden = profile({ capabilities: ['reasoning', 'tool_calling', 'mcp'] });
  check('F5: generic CLI honours profile.capabilities', generic.capabilities(overridden).includes('mcp'), generic.capabilities(overridden));
  const picked = await manager.select([overridden], ['reasoning', 'mcp']);
  check('F5: a generic profile with mcp only on the profile is selectable for a role that needs mcp', picked.ok && picked.value.profile.id === overridden.id,
    picked.ok ? picked.value.profile.id : describeRejections?.(picked.error.rejections));
  if (picked.ok) picked.value.reservation.release();
  const viaSettings = profile({ capabilities: ['reasoning', 'tool_calling'], settings: { command: '/bin/echo', capabilities: ['reasoning', 'mcp'] } });
  check('F5: capabilities declared in settings still count when the profile carries the adapter defaults', generic.capabilities(viaSettings).includes('mcp'), generic.capabilities(viaSettings));
  const narrowed = profile({ capabilities: [...generic.baseCapabilities], settings: { command: '/bin/echo', capabilities: ['reasoning'] } });
  check('F5 round 2: stored capabilities equal to the adapter defaults are no override, so settings can narrow', eq([...generic.capabilities(narrowed)], ['reasoning']), generic.capabilities(narrowed));
  const extra = profile({ capabilities: [...generic.baseCapabilities, 'mcp'], settings: { command: '/bin/echo', capabilities: ['reasoning'] } });
  check('F5 round 2: an explicit extra capability on the profile is still gained', eq([...generic.capabilities(extra)].sort(), ['mcp', 'reasoning', 'tool_calling']), generic.capabilities(extra));
  const reordered = profile({ capabilities: [...generic.baseCapabilities].reverse(), settings: { command: '/bin/echo', capabilities: ['reasoning'] } });
  check('F5 round 2: the defaults in another order are still no override', eq([...generic.capabilities(reordered)], ['reasoning']), generic.capabilities(reordered));
  check('F5: no override and no settings keeps the adapter\'s own report', eq([...generic.capabilities(profile({}))].sort(), [...generic.baseCapabilities].sort()), generic.capabilities(profile({})));
  const codex = new CodexAdapter();
  check('F5: Codex honours profile.capabilities too', codex.capabilities(profile({ adapterId: codex.id, settings: {}, capabilities: ['computer_use'] })).includes('computer_use'));
  const claude = new ClaudeCodeAdapter();
  check('F5: Claude honours profile.capabilities too', claude.capabilities(profile({ adapterId: claude.id, settings: {}, capabilities: ['computer_use'] })).includes('computer_use'));
}

section('domain: staffing presets');
{
  const domain = await import('../packages/domain/dist/index.js');
  const { presetToStaffing, staffingToPreset, STAFFING_PRESETS } = domain;
  check('presets: exported', typeof presetToStaffing === 'function' && typeof staffingToPreset === 'function' && Array.isArray(STAFFING_PRESETS));
  if (typeof presetToStaffing === 'function') {
    const team = indexTeam([
      person('maria', { access: 'owner' }), person('ana', { reportsTo: 'maria' }), person('bo', { reportsTo: 'maria' }),
      agent('figma', 'ana'), agent('coder', 'maria', { roleIds: ['engineering'] }),
    ]);
    const picks = { agents: ['figma', 'coder'], people: ['ana', 'bo'] };
    for (const preset of STAFFING_PRESETS.filter((p) => p !== 'custom')) {
      const staffing = presetToStaffing(preset, picks);
      const back = staffingToPreset(staffing, team);
      check(`presets: ${preset} round-trips`, back.preset === preset, { staffing, back });
    }
    const person1 = staffingToPreset(presetToStaffing('person', picks), team);
    check('presets: person keeps the chosen person', eq(person1.people, ['ana']) && eq(person1.agents, []), person1);
    const pool = staffingToPreset(presetToStaffing('pool', picks), team);
    check('presets: pool keeps every person', eq(pool.people, ['ana', 'bo']), pool);
    const ai = staffingToPreset(presetToStaffing('ai_then_approve', picks), team);
    check('presets: agents are kept in order', eq(ai.agents, ['figma', 'coder']), ai);
    const twoReviews = { assignees: ['figma'], mode: 'first_available', reviews: [
      { by: 'responsible', mode: 'blocking', when: 'always' }, { by: ['bo'], mode: 'after', when: 'always' },
    ] };
    check('presets: two reviews is custom', staffingToPreset(twoReviews, team).preset === 'custom');
    check('presets: an explicit responsible is custom', staffingToPreset({ ...presetToStaffing('ai_only', picks), responsible: 'bo' }, team).preset === 'custom');
    check('presets: a person in an AI preset is custom', staffingToPreset({ assignees: ['ana', 'figma'], mode: 'first_available', reviews: [] }, team).preset === 'custom');
    check('presets: an agent in a pool is custom', staffingToPreset({ assignees: ['figma'], mode: 'pool', reviews: [] }, team).preset === 'custom');
  }
}

// ---- later sections are appended above this line ----
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) process.exit(1);
