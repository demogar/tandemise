# P0 Members, Team Tree and Responsibility: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to carry out this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every piece of Tandemise work record who did it, who is responsible (always a real person) and who recorded it. Staffing is configurable per workspace, mission and task. Requests are addressed to the responsible person and escalate up a team tree.

**Architecture:**
- Pure domain types and functions (`member.ts`, `staffing.ts`) hold every rule.
- Persistence adds `people` and `members` tables and actor columns, backfilled by migration 008.
- Application services (team, staffing, identity) and the scheduler/executor consume the pure functions.
- The daemon passes a `Caller` resolved from the bearer token.
- The desktop gets a Team screen, a staffing editor, an Inbox and attribution chips.

**Tech stack:** TypeScript (ESM, `tsc -b`), zod, better-sqlite3, the custom node:http router, React 19 + electron-vite. Tests are `scratch/*.mjs` node scripts against built `dist/`, registered in `scripts/run-checks.mjs`.

**Spec:** `docs/superpowers/specs/2026-09-13-p0-members-responsibility-design.md` (read it first; this plan argues from it).

## Global constraints

- Node 22 (`.nvmrc` 22.23.1). Build with `npm run build`. CI runs `npm run ci` (build, boundaries, design, licenses, desktop typecheck, offline checks).
- Layering is enforced by `npm run check:boundaries`:
  - `@tandemise/domain` may import only `@tandemise/shared` and `zod`.
  - `@tandemise/application` may not import providers (`better-sqlite3`, `node:child_process`, `electron`, …).
- Released migrations are immutable. Only append `008`.
- Ids use `newId(prefix)` from `@tandemise/shared`. New prefixes: `per` (person) and `mem` (member).
- Actor columns hold a member id, or one of the literals `system` or `system:runtime`.
- With zero configuration, behaviour must stay identical to today (acceptance A1). Every existing offline check must still pass.
- The desktop must pass `npm run check:design`: no raw colours, tokens only. See `docs/DESIGN_SYSTEM.md`.
- Comment style: explain *why*, in full sentences, matching the surrounding files.
- Commits use Conventional Commits and end with `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.
- Tests are written first (a failing check section), then the implementation.

---

## File map

| File | Responsibility |
|---|---|
| `packages/shared/src/ids.ts` (modify) | `PersonId` and `MemberId` brands, plus `ids.person()` and `ids.member()` |
| `packages/domain/src/entities/member.ts` (create) | `Person`, `Member`, access/oversight/status enums, actor literals |
| `packages/domain/src/staffing.ts` (create) | `Staffing` types, zod schemas, and the pure functions merge, resolve, responsible, escalation, reviewers, validate |
| `packages/domain/src/ports/repositories.ts` (modify) | `PersonRepositoryPort`, `MemberRepositoryPort`, plus new fields on existing ports |
| `packages/domain/src/entities/{workspace,mission,task,artifact,approval,run}.ts` (modify) | New fields |
| `packages/persistence/src/migrations/008_members_responsibility.ts` (create) | Schema and backfill |
| `packages/persistence/src/repositories/{person,member}-repository.ts` (create) | SQLite repositories |
| `packages/persistence/src/repositories/*` (modify) | Map the new columns |
| `packages/application/src/services/team-service.ts` (create) | People and members CRUD, team invariants, the local person |
| `packages/application/src/services/staffing-service.ts` (create) | Get/patch staffing per level, preview |
| `packages/application/src/support/identity.ts` (create) | `Caller`, `IdentityPort`, `actorFor()` |
| `packages/application/src/engine/staffing-resolver.ts` (create) | Loads layers and calls `resolveStaffing` for a task |
| `packages/application/src/engine/reviews.ts` (create) | Completion review pipeline and the escalation sweep |
| `packages/application/src/engine/{scheduler,task-executor}.ts`, `services/{approval,mission,workspace}-service.ts`, `tools/ask-human.ts`, `planning/*`, `support/approval-view.ts` (modify) | Wiring |
| `packages/evaluation/src/facts.ts` (modify) | `task.attempt`, `task.risk`, `task.risk_level`, `task.role`, `diff.files_changed` |
| `packages/api-contract/src/{requests,views}.ts` (modify) | Schemas and views |
| `apps/daemon/src/{routes.ts,http/router.ts,http/server.ts}` (modify) | Principal on requests, new routes |
| `apps/desktop/src/renderer/src/screens/team/*` (create) | Team tree, member forms, staffing editor |
| `apps/desktop/src/renderer/src/screens/Inbox.tsx` (create, replaces the Approvals route) | Approvals and human tasks, with filters |
| `apps/desktop/src/renderer/src/components/ActorChip.tsx` (create) | "by X · responsible Y" |
| `scratch/staffing-check.mjs` (create) | Offline check (domain, persistence, engine, HTTP) |
| `scratch/acceptance/p0/*` (create) | Controlled real-app harness and scenario drivers |

---

### Task 1: Domain model and pure staffing rules

**Files:**
- Modify: `packages/shared/src/ids.ts`
- Create: `packages/domain/src/entities/member.ts`, `packages/domain/src/staffing.ts`
- Modify: `packages/domain/src/index.ts` (export both)
- Create: `scratch/staffing-check.mjs` (section "domain")
- Modify: `scripts/run-checks.mjs` (add `'staffing-check'` to `OFFLINE_CHECKS`, alphabetically)

**Interfaces produced** (every later task uses these names):

```ts
// shared/ids.ts
export type PersonId = Brand<string, 'PersonId'>;
export type MemberId = Brand<string, 'MemberId'>;
ids.person = () => newId<'PersonId'>('per'); ids.member = () => newId<'MemberId'>('mem');

// domain/entities/member.ts
export const ACCESS_LEVELS = ['owner', 'admin', 'member', 'guest'] as const;
export type AccessLevel = (typeof ACCESS_LEVELS)[number];
export const OVERSIGHT_MODES = ['delegate_owns', 'both_sign_off'] as const;
export type OversightMode = (typeof OVERSIGHT_MODES)[number];
export const MEMBER_KINDS = ['person', 'agent'] as const;
export type MemberKind = (typeof MEMBER_KINDS)[number];
export const MEMBER_STATUSES = ['active', 'removed'] as const;
export type MemberStatus = (typeof MEMBER_STATUSES)[number];
export const SYSTEM_ACTOR = 'system';
export const RUNTIME_ACTOR = 'system:runtime';
export type ActorId = string; // a MemberId, SYSTEM_ACTOR or RUNTIME_ACTOR

export interface Person {
  readonly id: PersonId; readonly displayName: string;
  readonly handles: Readonly<Record<string, string>>;
  readonly accountId: string | null; readonly createdAt: Timestamp; readonly removedAt: Timestamp | null;
}
export interface Member {
  readonly id: MemberId; readonly workspaceId: WorkspaceId; readonly kind: MemberKind;
  readonly personId: PersonId | null; readonly name: string; readonly title: string | null;
  readonly reportsTo: MemberId | null; readonly access: AccessLevel | null;
  readonly oversight: OversightMode; readonly roleIds: readonly string[];
  readonly runtimeProfileIds: readonly string[]; readonly integrationIds: readonly string[];
  readonly status: MemberStatus; readonly createdAt: Timestamp; readonly updatedAt: Timestamp;
}

// domain/staffing.ts
export interface StaffingReview { readonly by: 'responsible' | readonly string[]; readonly mode: 'blocking' | 'after'; readonly when: string }
export interface Staffing {
  readonly assignees: readonly string[]; readonly mode: 'first_available' | 'pool';
  readonly responsible: string | null; readonly reviews: readonly StaffingReview[];
  readonly escalateAfterMs: number | null; readonly notify: readonly string[];
}
export type StaffingPatch = Partial<Staffing>;
export type RoleStaffing = Readonly<Record<string, StaffingPatch>>;
export const DEFAULT_ESCALATE_AFTER_MS = 86_400_000;
export const BASE_STAFFING: Staffing;
export const staffingPatchSchema: z.ZodType<StaffingPatch>;
export const roleStaffingSchema: z.ZodType<RoleStaffing>;
export interface Team { readonly members: readonly Member[]; readonly byId: ReadonlyMap<string, Member>; readonly owners: readonly Member[] }
export function indexTeam(members: readonly Member[]): Team;
export function isActiveMember(team: Team, id: string): boolean;
export function mergeStaffing(...layers: ReadonlyArray<StaffingPatch | undefined>): Staffing;
export interface StaffingLayers { readonly workspace?: StaffingPatch; readonly mission?: StaffingPatch; readonly task?: StaffingPatch }
export interface ResolvedStaffing {
  readonly staffing: Staffing;
  readonly executor: 'agent' | 'human';
  readonly agentCandidates: readonly Member[];  // active agents, in order; empty = legacy runtime fallback
  readonly assigneeId: string | null;            // set for a person assignee; for agents, set after runtime selection
  readonly claimable: readonly string[];         // person member ids who may claim (pool / fallback)
  readonly responsibleId: string;
}
export function resolveStaffing(input: { team: Team; roleId: string; humanStep: boolean; layers: StaffingLayers }): ResolvedStaffing;
export function responsibleFor(team: Team, staffing: Staffing, assigneeId: string | null): string;
export function escalationChain(team: Team, responsibleId: string): readonly string[];
export function signOffLead(team: Team, responsibleId: string): string | null;
export function reviewersFor(team: Team, review: StaffingReview, responsibleId: string): readonly string[];
export function validateStaffing(team: Team, patch: StaffingPatch): readonly string[];   // issues, empty = valid
export function validateTeam(members: readonly Member[]): readonly string[];            // invariant issues
```

- [ ] **Step 1: Write the failing domain section of the check**

Create `scratch/staffing-check.mjs`:

```js
// P0 members, team tree and responsibility. Pure rules first, then persistence,
// engine and HTTP sections appended by later tasks.
//
//   npm run build && node scratch/staffing-check.mjs
import {
  indexTeam, mergeStaffing, resolveStaffing, responsibleFor, escalationChain, signOffLead,
  reviewersFor, validateStaffing, validateTeam, BASE_STAFFING, DEFAULT_ESCALATE_AFTER_MS,
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
  check('human step hint -> unassigned pool claimable by owners', human.executor === 'human' && human.assigneeId === null && eq(human.claimable, ['demo']), human);
  const pool = resolveStaffing({ team, roleId: 'qa', humanStep: false, layers: { workspace: { assignees: ['ana', 'bo'], mode: 'pool' } } });
  check('pool of people -> claimable, owner responsible until claimed', pool.executor === 'human' && pool.assigneeId === null && eq(pool.claimable, ['ana', 'bo']) && pool.responsibleId === 'demo', pool);
  check('responsibleFor after claim', responsibleFor(team, pool.staffing, 'bo') === 'bo');
}

section('domain: inactive members');
{
  const removedAna = indexTeam([demo, maria, { ...ana, status: 'removed' }, bo, anaAgent, mariaAgent]);
  const r = resolveStaffing({ team: removedAna, roleId: 'design', humanStep: false, layers: { workspace: { assignees: ['ana_figma', 'maria_od'] } } });
  check('agent of a removed owner is skipped', r.agentCandidates.map((m) => m.id).join() === 'maria_od' && r.responsibleId === 'maria', r);
}

section('domain: escalation and sign-off');
{
  check('chain walks reportsTo then owners, deduped', eq(escalationChain(team, 'ana'), ['ana', 'maria', 'demo']), escalationChain(team, 'ana'));
  check('no sign-off lead by default', signOffLead(team, 'ana') === null);
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
  check('agent owned by agent is invalid', validateTeam([demo, agent('x', 'ana_figma'), anaAgent, ana, maria]).some((i) => i.includes('person')));
  check('agent with reports is invalid', validateTeam([demo, anaAgent, ana, maria, person('z', { reportsTo: 'ana_figma' })]).some((i) => i.includes('reports')));
}

// ---- later sections are appended above this line ----
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) process.exit(1);
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npm run build && node scratch/staffing-check.mjs`
Expected: the import fails with a SyntaxError about `indexTeam` not being exported.

- [ ] **Step 3: Implement `ids`, `member.ts` and `staffing.ts`**

`packages/shared/src/ids.ts`: add the two brands next to the others, and `person: () => newId<'PersonId'>('per')` and `member: () => newId<'MemberId'>('mem')` to `ids`.

`packages/domain/src/entities/member.ts`: exactly the interfaces in *Interfaces produced*, each with a short comment on why. For example, why agents have `access: null`: an agent's authority comes from its owner, following Buzz's NIP-AA model.

`packages/domain/src/staffing.ts`:

```ts
import { z } from 'zod';
import type { Member } from './entities/member.js';
import { validateGate } from './gate.js';

/**
 * Who does a role's work, who answers for it, and who has to look at it.
 *
 * Kept as data and pure functions so the same rules run in the scheduler, the
 * preview endpoint and the Team screen - three places that must never disagree
 * about who is responsible for a task.
 */
export interface StaffingReview {
  readonly by: 'responsible' | readonly string[];
  readonly mode: 'blocking' | 'after';
  /** `always`, or a gate expression over the task's measured facts. */
  readonly when: string;
}

export interface Staffing {
  readonly assignees: readonly string[];
  readonly mode: 'first_available' | 'pool';
  readonly responsible: string | null;
  readonly reviews: readonly StaffingReview[];
  readonly escalateAfterMs: number | null;
  readonly notify: readonly string[];
}

export type StaffingPatch = Partial<Staffing>;
export type RoleStaffing = Readonly<Record<string, StaffingPatch>>;

export const DEFAULT_ESCALATE_AFTER_MS = 86_400_000;

export const BASE_STAFFING: Staffing = {
  assignees: [], mode: 'first_available', responsible: null, reviews: [],
  escalateAfterMs: DEFAULT_ESCALATE_AFTER_MS, notify: [],
};

const reviewSchema = z.object({
  by: z.union([z.literal('responsible'), z.array(z.string().min(1)).min(1)]),
  mode: z.enum(['blocking', 'after']),
  when: z.string().min(1),
}).strict();

export const staffingPatchSchema = z.object({
  assignees: z.array(z.string().min(1)),
  mode: z.enum(['first_available', 'pool']),
  responsible: z.string().min(1).nullable(),
  reviews: z.array(reviewSchema),
  escalateAfterMs: z.number().int().positive().nullable(),
  notify: z.array(z.string().min(1)),
}).partial().strict();

export const roleStaffingSchema = z.record(z.string().min(1), staffingPatchSchema);

export interface Team {
  readonly members: readonly Member[];
  readonly byId: ReadonlyMap<string, Member>;
  readonly owners: readonly Member[];
}

export function indexTeam(members: readonly Member[]): Team {
  const byId = new Map(members.map((m) => [m.id as string, m]));
  const owners = members.filter((m) => m.kind === 'person' && m.status === 'active' && m.access === 'owner');
  return { members, byId, owners };
}

/**
 * Active means usable right now. An agent is only as active as its owner: a
 * person who leaves takes their agents' authority with them (Buzz NIP-AA).
 */
export function isActiveMember(team: Team, id: string): boolean {
  const m = team.byId.get(id);
  if (m === undefined || m.status !== 'active') return false;
  if (m.kind === 'agent') return m.reportsTo !== null && isActivePerson(team, m.reportsTo);
  return true;
}

function isActivePerson(team: Team, id: string): boolean {
  const m = team.byId.get(id);
  return m !== undefined && m.kind === 'person' && m.status === 'active';
}

export function mergeStaffing(...layers: ReadonlyArray<StaffingPatch | undefined>): Staffing {
  let out: Staffing = BASE_STAFFING;
  for (const layer of layers) {
    if (layer === undefined) continue;
    const defined = Object.fromEntries(Object.entries(layer).filter(([, v]) => v !== undefined)) as StaffingPatch;
    out = { ...out, ...defined };
  }
  return out;
}

export interface StaffingLayers {
  readonly workspace?: StaffingPatch;
  readonly mission?: StaffingPatch;
  readonly task?: StaffingPatch;
}

export interface ResolvedStaffing {
  readonly staffing: Staffing;
  readonly executor: 'agent' | 'human';
  readonly agentCandidates: readonly Member[];
  readonly assigneeId: string | null;
  readonly claimable: readonly string[];
  readonly responsibleId: string;
}

export function resolveStaffing(input: {
  readonly team: Team; readonly roleId: string; readonly humanStep: boolean; readonly layers: StaffingLayers;
}): ResolvedStaffing {
  const { team, roleId, humanStep, layers } = input;
  const builtIn: StaffingPatch = {
    assignees: team.members.filter((m) => m.kind === 'agent' && m.roleIds.includes(roleId)).map((m) => m.id),
  };
  const hint: StaffingPatch | undefined = humanStep ? { assignees: [], mode: 'pool' } : undefined;
  const staffing = mergeStaffing(builtIn, hint, layers.workspace, layers.mission, layers.task);

  const active = staffing.assignees.map((id) => team.byId.get(id)).filter((m): m is Member => m !== undefined && isActiveMember(team, m.id));
  const agents = active.filter((m) => m.kind === 'agent');
  const people = active.filter((m) => m.kind === 'person');
  const ownerIds = team.owners.map((m) => m.id as string);
  const done = (r: Omit<ResolvedStaffing, 'staffing' | 'responsibleId'>, assignee: string | null): ResolvedStaffing =>
    ({ staffing, ...r, responsibleId: responsibleFor(team, staffing, assignee) });

  if (staffing.mode === 'first_available') {
    const first = active[0];
    if (first === undefined) {
      return humanStep
        ? done({ executor: 'human', agentCandidates: [], assigneeId: null, claimable: ownerIds }, null)
        : done({ executor: 'agent', agentCandidates: [], assigneeId: null, claimable: [] }, null);
    }
    if (first.kind === 'agent') {
      return done({ executor: 'agent', agentCandidates: agents, assigneeId: null, claimable: [] }, agents[0]!.id);
    }
    return done({ executor: 'human', agentCandidates: [], assigneeId: first.id, claimable: [first.id] }, first.id);
  }
  if (agents.length > 0) {
    return done({ executor: 'agent', agentCandidates: agents, assigneeId: null, claimable: [] }, agents[0]!.id);
  }
  const claimable = people.length > 0 ? people.map((m) => m.id as string) : ownerIds;
  return done({ executor: 'human', agentCandidates: [], assigneeId: null, claimable }, null);
}

/**
 * The real person who answers for the work. Never an agent: an agent's work is
 * answered for by its owner (principle 0 of the collaboration roadmap).
 */
export function responsibleFor(team: Team, staffing: Staffing, assigneeId: string | null): string {
  if (staffing.responsible !== null && isActivePerson(team, staffing.responsible)) return staffing.responsible;
  const assignee = assigneeId === null ? undefined : team.byId.get(assigneeId);
  if (assignee !== undefined && isActiveMember(team, assignee.id)) {
    if (assignee.kind === 'person') return assignee.id;
    if (assignee.reportsTo !== null) return assignee.reportsTo;
  }
  return firstOwner(team);
}

function firstOwner(team: Team): string {
  const owner = team.owners[0];
  // validateTeam guarantees an owner; a team without one is a corrupt workspace.
  if (owner === undefined) throw new Error('Workspace has no active owner.');
  return owner.id;
}

export function escalationChain(team: Team, responsibleId: string): readonly string[] {
  const chain: string[] = [];
  const seen = new Set<string>();
  let cursor: string | null = responsibleId;
  while (cursor !== null && !seen.has(cursor)) {
    seen.add(cursor);
    const m = team.byId.get(cursor);
    if (m === undefined) break;
    if (m.kind === 'person' && m.status === 'active') chain.push(m.id);
    cursor = m.reportsTo;
  }
  for (const o of team.owners) if (!chain.includes(o.id)) chain.push(o.id);
  return chain;
}

export function signOffLead(team: Team, responsibleId: string): string | null {
  const lead = team.byId.get(team.byId.get(responsibleId)?.reportsTo ?? '');
  return lead !== undefined && isActivePerson(team, lead.id) && lead.oversight === 'both_sign_off' ? lead.id : null;
}

export function reviewersFor(team: Team, review: StaffingReview, responsibleId: string): readonly string[] {
  if (review.by === 'responsible') return [responsibleId];
  const people = review.by.filter((id) => isActivePerson(team, id));
  return people.length > 0 ? people : [responsibleId];
}

export function validateStaffing(team: Team, patch: StaffingPatch): readonly string[] {
  const issues: string[] = [];
  patch.assignees?.forEach((id, i) => {
    if (!team.byId.has(id)) issues.push(`assignees.${i}: unknown member '${id}'.`);
  });
  if (patch.responsible !== undefined && patch.responsible !== null && team.byId.get(patch.responsible)?.kind !== 'person') {
    issues.push(`responsible: '${patch.responsible}' must be a person member.`);
  }
  patch.reviews?.forEach((r, i) => {
    if (r.by !== 'responsible') {
      r.by.forEach((id, j) => {
        if (team.byId.get(id)?.kind !== 'person') issues.push(`reviews.${i}.by.${j}: '${id}' must be a person member.`);
      });
    }
    if (r.when !== 'always') {
      const g = validateGate(r.when);
      if (!g.ok) issues.push(`reviews.${i}.when: ${g.error}`);
    }
  });
  patch.notify?.forEach((id, i) => {
    if (team.byId.get(id)?.kind !== 'person') issues.push(`notify.${i}: '${id}' must be a person member.`);
  });
  return issues;
}

export function validateTeam(members: readonly Member[]): readonly string[] {
  const issues: string[] = [];
  const team = indexTeam(members);
  if (team.owners.length === 0) issues.push('The workspace needs at least one active owner.');
  for (const m of members) {
    if (m.status !== 'active') continue;
    if (m.kind === 'agent') {
      const owner = m.reportsTo === null ? undefined : team.byId.get(m.reportsTo);
      if (owner?.kind !== 'person') issues.push(`${m.name}: an agent must be owned by a person.`);
    }
    if (m.reportsTo !== null && team.byId.get(m.reportsTo)?.kind === 'agent') {
      issues.push(`${m.name}: agents cannot have reports.`);
    }
    const seen = new Set<string>([m.id]);
    let cursor = m.reportsTo;
    while (cursor !== null) {
      if (seen.has(cursor)) { issues.push(`${m.name}: reporting lines form a cycle.`); break; }
      seen.add(cursor);
      cursor = team.byId.get(cursor)?.reportsTo ?? null;
    }
  }
  return issues;
}
```

Export both files from `packages/domain/src/index.ts` (`export * from './staffing.js'; export * from './entities/member.js';`). If `validateGate` returns `{ ok, error }` differently, adapt the call to its actual `Result` shape (it is `Result<true, string>` from `@tandemise/shared`).

- [ ] **Step 4: Run the check and confirm it passes**

Run: `npm run build && node scratch/staffing-check.mjs`
Expected: every domain line `ok`, then `N passed, 0 failed`. The "agent with reports" check must produce exactly one issue containing `reports`; adjust the message wording if needed, but never the assertion's intent.

- [ ] **Step 5: Add the check to the offline suite, run boundaries, and commit**

Run: `npm run check:boundaries && node scripts/run-checks.mjs staffing-check`

```bash
git add packages/shared packages/domain scratch/staffing-check.mjs scripts/run-checks.mjs
git commit -m "feat(domain): members, team tree and pure staffing rules"
```

---

### Task 2: Persistence, migration 008 and backfill

**Files:**
- Create: `packages/persistence/src/migrations/008_members_responsibility.ts`
- Modify: `packages/persistence/src/migrations/index.ts` (append)
- Create: `packages/persistence/src/repositories/person-repository.ts`, `member-repository.ts`
- Modify: repositories for workspace (`staffing`), mission (`created_by`, `staffing`), task (`staffing`, `staffing_override`, `assignee_id`, `responsible_id`, `needs_attention`), artifact (`author_id`, `responsible_id`, `recorded_by`), approval (`addressees`, `escalation_level`, `escalate_at`, `recorded_by`; kind `check`), run (`agent_member_id`), event (`actor_id`)
- Modify: `packages/domain/src/ports/repositories.ts`, the entity files (new fields), `packages/domain/src/entities/approval.ts` (add `'check'` to `APPROVAL_KINDS`)
- Modify: `packages/persistence/src/tokens.ts`, `module.ts`, `index.ts` (`PERSON_REPOSITORY`, `MEMBER_REPOSITORY`)
- Test: `scratch/staffing-check.mjs` section "persistence"; `scratch/persistence-check.mjs` and `scratch/schema-constraint-check.mjs` must still pass

**Interfaces:**
- Consumes: Task 1 types.
- Produces:

```ts
export interface PersonRepositoryPort {
  create(p: Omit<Person, 'createdAt' | 'removedAt'>): Person;
  get(id: PersonId): Person | undefined;
  list(options?: { includeRemoved?: boolean }): readonly Person[];
  update(id: PersonId, patch: Partial<Pick<Person, 'displayName' | 'handles' | 'accountId' | 'removedAt'>>): Person;
}
export interface MemberRepositoryPort {
  create(m: Omit<Member, 'createdAt' | 'updatedAt'>): Member;
  get(id: MemberId): Member | undefined;
  listByWorkspace(workspaceId: WorkspaceId, options?: { includeRemoved?: boolean }): readonly Member[];
  findPersonMember(workspaceId: WorkspaceId, personId: PersonId): Member | undefined;
  update(id: MemberId, patch: Partial<Omit<Member, 'id' | 'workspaceId' | 'kind' | 'createdAt'>>): Member;
}
// Entity fields (all readonly):
Workspace.staffing: RoleStaffing
Mission.createdBy: string | null; Mission.staffing: RoleStaffing
MissionTask.staffing: ResolvedStaffingSnapshot | null; staffingOverride: StaffingPatch | null;
  assigneeId: string | null; responsibleId: string | null; needsAttention: boolean
ArtifactManifest.authorId: string | null; responsibleId: string | null; recordedBy: string | null
Approval.addressees: readonly string[]; escalationLevel: number; escalateAt: Timestamp | null; recordedBy: string | null
Run.agentMemberId: string | null
RunEventRecord.actorId: string | null
// in domain/staffing.ts:
export interface ResolvedStaffingSnapshot { readonly staffing: Staffing; readonly executor: 'agent' | 'human'; readonly claimable: readonly string[]; readonly agentCandidateIds: readonly string[] }
```

Every new entity field must be optional-with-default wherever existing builders construct entities (`materializePlan`, test fixtures). Prefer `readonly x?: T | null` for task and artifact fields, as `retryFeedback` does, so existing object literals still typecheck.

- [ ] **Step 1: Write the failing persistence section**

Append to `scratch/staffing-check.mjs`, above the summary line. It builds a database at schema version 7 using `MIGRATIONS.slice(0, 7)`, inserts legacy rows, migrates to the latest version, and asserts the backfill.

```js
section('persistence: migration 008 backfill');
{
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const P = await import('../packages/persistence/dist/index.js');
  const dir = mkdtempSync(join(tmpdir(), 'tandemise-staffing-'));
  const db = P.openDatabase(join(dir, 't.db'));
  P.migrate(db, undefined, P.MIGRATIONS.slice(0, 7));
  const h = db.handle;
  const now = '2026-09-13T00:00:00.000Z';
  h.prepare(`INSERT INTO workspaces (id,name,default_repository_id,autonomy,concurrency,routing,default_autonomy_level,knowledge,created_at,updated_at)
             VALUES ('ws_a','A',NULL,'{}','{}',?, 'supervised','{}',?,?)`).run(JSON.stringify({ design: ['rt_1', 'rt_2'], development: ['rt_3'] }), now, now);
  // Minimal legacy mission + approval decided by 'user'. Column lists must match 001_initial.ts;
  // read that file and fill required NOT NULL columns with valid values.
  // (Implementer: add the mission row, one decided approval row and one artifact row with created_by_run_id.)
  P.migrate(db);
  check('schema is at the new version', P.schemaVersion(db) === P.SCHEMA_VERSION && P.SCHEMA_VERSION === 8);
  const people = h.prepare('SELECT * FROM people').all();
  check('one local person created', people.length === 1, people);
  const members = h.prepare("SELECT * FROM members WHERE workspace_id='ws_a' ORDER BY kind DESC, name").all();
  const owner = members.find((m) => m.kind === 'person');
  check('workspace owner member created', owner?.access === 'owner' && owner.person_id === people[0].id, members);
  const agents = members.filter((m) => m.kind === 'agent');
  check('routing became agent members owned by the owner', agents.length === 2 && agents.every((a) => a.reports_to === owner.id), agents);
  const design = agents.find((a) => JSON.parse(a.role_ids)[0] === 'design');
  check('agent keeps ranked runtimes', JSON.parse(design.runtime_profile_ids).join() === 'rt_1,rt_2');
  const staffing = JSON.parse(h.prepare("SELECT staffing FROM workspaces WHERE id='ws_a'").get().staffing);
  check('workspace staffing points roles at those agents', staffing.design.assignees[0] === design.id && staffing.development.assignees.length === 1, staffing);
  const approval = h.prepare("SELECT decided_by FROM approvals WHERE decided_by IS NOT NULL").get();
  check("decided_by 'user' became the owner member", approval?.decided_by === owner.id, approval);
  P.migrate(db);
  check('re-running migrate is a no-op', h.prepare('SELECT count(*) c FROM people').get().c === 1);
}
```

Fill in the three legacy inserts (mission, approval, artifact) by reading the exact `CREATE TABLE` columns in `001_initial.ts` and later migrations. Also add a repository round-trip. Resolve the repositories through `persistenceModule` exactly as `persistence-check.mjs` does, then assert that `create`/`get`/`update`/`listByWorkspace` round-trip every field, including JSON arrays and `null`s.

- [ ] **Step 2: Run it and confirm it fails** (`SCHEMA_VERSION === 7`, or the `people` table does not exist)

- [ ] **Step 3: Implement migration 008**

`up` SQL:

```sql
CREATE TABLE people (
  id TEXT PRIMARY KEY, display_name TEXT NOT NULL, handles TEXT NOT NULL DEFAULT '{}',
  account_id TEXT, created_at TEXT NOT NULL, removed_at TEXT
);
CREATE TABLE members (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('person','agent')),
  person_id TEXT REFERENCES people(id),
  name TEXT NOT NULL, title TEXT,
  reports_to TEXT REFERENCES members(id) ON DELETE SET NULL,
  access TEXT CHECK (access IS NULL OR access IN ('owner','admin','member','guest')),
  oversight TEXT NOT NULL DEFAULT 'delegate_owns' CHECK (oversight IN ('delegate_owns','both_sign_off')),
  role_ids TEXT NOT NULL DEFAULT '[]', runtime_profile_ids TEXT NOT NULL DEFAULT '[]', integration_ids TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','removed')),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  CHECK ((kind = 'person' AND person_id IS NOT NULL) OR (kind = 'agent' AND person_id IS NULL AND reports_to IS NOT NULL))
);
CREATE UNIQUE INDEX ux_members_person ON members (workspace_id, person_id) WHERE person_id IS NOT NULL;
CREATE INDEX ix_members_workspace ON members (workspace_id, status);
ALTER TABLE workspaces ADD COLUMN staffing TEXT NOT NULL DEFAULT '{}';
ALTER TABLE missions ADD COLUMN created_by TEXT;
ALTER TABLE missions ADD COLUMN staffing TEXT NOT NULL DEFAULT '{}';
ALTER TABLE mission_tasks ADD COLUMN staffing TEXT;
ALTER TABLE mission_tasks ADD COLUMN staffing_override TEXT;
ALTER TABLE mission_tasks ADD COLUMN assignee_id TEXT;
ALTER TABLE mission_tasks ADD COLUMN responsible_id TEXT;
ALTER TABLE mission_tasks ADD COLUMN needs_attention INTEGER NOT NULL DEFAULT 0;
ALTER TABLE artifacts ADD COLUMN author_id TEXT;
ALTER TABLE artifacts ADD COLUMN responsible_id TEXT;
ALTER TABLE artifacts ADD COLUMN recorded_by TEXT;
ALTER TABLE approvals ADD COLUMN addressees TEXT NOT NULL DEFAULT '[]';
ALTER TABLE approvals ADD COLUMN escalation_level INTEGER NOT NULL DEFAULT 0;
ALTER TABLE approvals ADD COLUMN escalate_at TEXT;
ALTER TABLE approvals ADD COLUMN recorded_by TEXT;
ALTER TABLE runs ADD COLUMN agent_member_id TEXT;
ALTER TABLE run_events ADD COLUMN actor_id TEXT;
CREATE INDEX ix_tasks_assignee ON mission_tasks (assignee_id, status);
CREATE INDEX ix_approvals_escalate ON approvals (status, escalate_at);
```

- **Approval kinds.** If `approvals.kind` has a `CHECK (kind IN (...))`, adding `'check'` requires rebuilding the table. Follow exactly how `006_task_park_statuses.ts` rebuilds `mission_tasks` (create the new table, copy, drop, rename, recreate indexes and triggers).
- **`transform(handle)`**, all in the same transaction:
  1. Only if `people` is empty, insert one person. `display_name` comes from `process.env.TANDEMISE_OWNER_NAME ?? os.userInfo().username`. Read `git config user.name` in the daemon at startup (Task 3), not here, because migrations must stay free of side effects.
  2. For each workspace without a person member, insert an owner member.
  3. For each workspace, parse `routing`. For each role with at least one profile, insert an agent member named `"<roleId> agent"` (capitalised) with `role_ids = [role]`, `runtime_profile_ids = profiles` and `reports_to` = the owner. Write `staffing[role] = { assignees: [agentId] }`.
  4. `UPDATE approvals SET decided_by = <owner of approval.workspace_id> WHERE decided_by = 'user'`.
  5. `UPDATE missions SET created_by = owner`.
  6. `UPDATE artifacts SET responsible_id = owner, author_id = COALESCE((SELECT m.id FROM runs r JOIN members m ON m.workspace_id = artifacts.workspace_id AND m.kind='agent' AND m.role_ids LIKE '%"' || r.role_id || '"%' WHERE r.id = artifacts.created_by_run_id LIMIT 1), CASE WHEN created_by_run_id IS NULL THEN NULL ELSE 'system:runtime' END)`.
- **Ids** in the transform: `newId('per')` / `newId('mem')` from `@tandemise/shared` (persistence already depends on shared).

- [ ] **Step 4: Implement the repositories and map the new columns**

- **New repositories:** follow `workspace-repository.ts` (prepared statements, `toRow`/`fromRow`, `parseJson`/`toJson`, the clock for timestamps). Update every existing repository's `COLUMNS`, `INSERT`, `UPDATE`, `toRow` and `fromRow` for the new columns.
- **Workspace update.** `SqliteWorkspaceRepository.update` must still use `applyPatch`. Per-role merging is a *service* concern (Task 3), not a repository concern.
- **Module.** Register both repositories in `module.ts` the same way `WORKSPACE_REPOSITORY` is registered, and export the tokens from `index.ts`.

- [ ] **Step 5: Run the checks**

Run: `npm run build && node scratch/staffing-check.mjs && node scripts/run-checks.mjs persistence-check schema-constraint-check`
Expected: all pass. If `persistence-check` builds entities without the new fields, the optional fields keep it compiling. Fix any runtime mismatch in the repositories, never in the check.

- [ ] **Step 6: Commit** — `feat(persistence): people, members and actor columns (migration 008)`

---

### Task 3: Identity, team service and staffing service

**Files:**
- Create: `packages/application/src/support/identity.ts`, `services/team-service.ts`, `services/staffing-service.ts`, `engine/staffing-resolver.ts`
- Modify: `packages/application/src/services.ts` (add `team`, `staffing`, `identity` to `TandemiseServices`), `module.ts` / `tokens.ts` (bindings), `services/workspace-service.ts`
  - Creating a workspace also creates an owner member for the caller's person.
  - `update` with `routing` is translated into staffing and agent members, merged per role.
  - `view` derives `routing` from staffing so API compatibility is kept.
- Modify: `packages/api-contract/src/requests.ts`, `views.ts` (schemas and views listed below)
- Test: `scratch/staffing-check.mjs` section "services"

**Interfaces produced:**

```ts
// support/identity.ts
export interface Caller { readonly personId: PersonId }
export interface IdentityPort { localPerson(): Person }   // P4 replaces this with account-backed resolution
/** The member acting in a workspace for this caller, honouring onBehalfOf. Throws FORBIDDEN / VALIDATION. */
export function actorFor(deps: { members: MemberRepositoryPort }, workspaceId: WorkspaceId, caller: Caller, onBehalfOf?: string):
  { readonly actorId: MemberId; readonly recordedBy: MemberId };

// services.ts
export interface TeamService {
  me(caller: Caller): MeView;
  listPeople(): readonly PersonView[];
  createPerson(caller: Caller, request: CreatePersonRequest): PersonView;
  updatePerson(caller: Caller, id: PersonId, request: UpdatePersonRequest): PersonView;
  removePerson(caller: Caller, id: PersonId): void;           // soft: removedAt + all their members removed
  team(workspaceId: WorkspaceId): TeamView;
  addMember(caller: Caller, workspaceId: WorkspaceId, request: AddMemberRequest): MemberView;
  updateMember(caller: Caller, id: MemberId, request: UpdateMemberRequest): MemberView;
  removeMember(caller: Caller, id: MemberId): void;           // status=removed; CONFLICT if last owner
}
export interface StaffingService {
  workspace(workspaceId: WorkspaceId): RoleStaffing;
  patchWorkspace(caller: Caller, workspaceId: WorkspaceId, patch: RoleStaffing): RoleStaffing;   // merged per role; role: null deletes it
  patchMission(caller: Caller, missionId: MissionId, patch: RoleStaffing): RoleStaffing;
  patchTask(caller: Caller, taskId: TaskId, patch: StaffingPatch | null): TaskView;            // CONFLICT once RUNNING or finished
  preview(taskId: TaskId): StaffingPreviewView;
}

// engine/staffing-resolver.ts
export class StaffingResolver {
  constructor(deps: { members: MemberRepositoryPort; workspaces: WorkspaceRepositoryPort; missions: MissionRepositoryPort });
  resolve(task: MissionTask): ResolvedStaffing;   // loads team + layers, humanStep = task.executor === 'human' && task.staffing == null
  chain(task: MissionTask): readonly string[];    // escalationChain for the task's (current or would-be) responsible
}

// api-contract/requests.ts (zod)
createPersonRequest   = { displayName: string(1..120), handles?: record<string,string> }
updatePersonRequest   = createPersonRequest.partial()
addMemberRequest      = { kind: 'person', personId: string, reportsTo?: string|null, access?: AccessLevel, oversight?: OversightMode, title?: string|null, roleIds?: string[] }
                      | { kind: 'agent', name: string(1..120), reportsTo: string, roleIds: string[] (min 1), runtimeProfileIds?: string[], integrationIds?: string[], title?: string|null }
updateMemberRequest   = partial of the union's fields except kind/personId, plus status?: 'active'
roleStaffingPatchRequest = z.record(string, staffingPatchSchema.nullable())
taskStaffingPatchRequest = staffingPatchSchema.nullable()
onBehalfOf            = z.string().min(1).optional()   // added to decideApprovalRequest, completeTaskRequest, createMissionRequest
claimTaskRequest      = { onBehalfOf?: string }

// api-contract/views.ts
export interface ActorRef { readonly id: string; readonly name: string; readonly kind: 'person' | 'agent' | 'system' }
export interface PersonView extends Person {}
export interface MemberView extends Member { readonly ownerName: string | null; readonly active: boolean }
export interface TeamView { readonly workspaceId: string; readonly members: readonly MemberView[]; readonly roots: readonly string[]; readonly issues: readonly string[] }
export interface MeView { readonly person: PersonView; readonly memberships: readonly { workspaceId: string; memberId: string; access: AccessLevel }[] }
export interface StaffingPreviewView { readonly taskId: string; readonly resolved: { executor: 'agent'|'human'; assignee: ActorRef | null; responsible: ActorRef; claimable: readonly ActorRef[]; agentCandidates: readonly ActorRef[] }; readonly staffing: Staffing; readonly escalation: readonly ActorRef[] }
// TaskView gains: assignee: ActorRef | null; responsible: ActorRef | null; claimable: readonly ActorRef[]
// ApprovalView gains: addressees: readonly ActorRef[]; decidedByRef: ActorRef | null; recordedByRef: ActorRef | null; escalationLevel: number
// ArtifactManifest view (wherever ArtifactManifest is returned, add): author: ActorRef | null; responsible: ActorRef | null; recordedByRef: ActorRef | null
export function actorRef(...)  // lives in application/support/actors.ts: resolves an id via members; 'system' -> {kind:'system', name:'Tandemise'}; 'system:runtime' -> {kind:'system', name:'Runtime'}
```

- [ ] **Step 1: Write the failing services section**

Compose the application exactly as `scratch/feedback-loop-check.mjs` does (Container, `compose`, and binding the shared tokens), then obtain `createServices(container)`. Assertions:
- `services.team.me({ personId })` returns the local person with one membership (`owner`) for a workspace created through `services.workspaces.create`.
- `addMember` for a person `Maria` (`reportsTo` = owner), `Ana` (`reportsTo` = Maria) and agent `Ana Figma` (`reportsTo` = Ana, `roleIds` = [design], `runtimeProfileIds` = [the fake profile id]). `team(ws).issues` is empty.
- `addMember` for an agent with `reportsTo` = another agent throws `VALIDATION`. `removeMember` on the last owner throws `CONFLICT`.
- `patchWorkspace(ws, { design: { assignees: [anaAgent] } })` followed by `patchWorkspace(ws, { development: { mode: 'pool' } })` leaves `workspace(ws).design.assignees` intact. This is the **A14 regression**.
- `workspaces.update(ws, { routing: { qa: [fakeProfile] } })` leaves `design` staffing intact and creates a `Qa agent` member (legacy compatibility). `workspaces.view(ws).routing.design` equals `[fakeProfile]`.
- `patchWorkspace` with an unknown member returns `VALIDATION`, with the issue path in `details`.
- `actorFor` with `onBehalfOf` = Ana returns `{ actorId: ana, recordedBy: owner }`; with `onBehalfOf` = the agent it throws `VALIDATION`; for a person who is not a member it throws `FORBIDDEN`.
- `removeMember(ana)` → `team(ws).members` shows the agent with `active: false`.

- [ ] **Step 2: Run it and confirm it fails**

- [ ] **Step 3: Implement**

- **Local person.** The daemon composition root (Task 6) supplies the display name from `git config user.name`. The application's `IdentityPort.localPerson()` returns the single person, creating one if the migration ran on an empty database.
- **Owner membership on create.** `WorkspaceService.create` gains a `caller` parameter: `create(caller: Caller, request)`. Update the route in Task 6, and update the existing call sites in scratch checks by passing `{ personId: localPerson.id }`. Search with `rg "workspaces.create\(" scratch apps packages`.
- **Invariants.** Every team mutation runs inside `unitOfWork` and validates with `validateTeam` on the post-mutation member list. On failure it throws `TandemiseError.validation(issues.join(' '), { issues })`. Removing the last owner is `CONFLICT`, raised before `validateTeam`.
- **Per-role merge.** `patchWorkspace` produces `next = { ...current }`. For each role in the patch, `null` deletes the role and a value becomes `{ ...current[role], ...value }`. Validate with `validateStaffing(team, merged)` for every role that was touched.
- **Routing compatibility.**
  - On write, for each role in `routing`, reuse the existing agent member that has exactly that `roleIds` and was created by migration. Otherwise create one. Set its `runtimeProfileIds`, and set `staffing[role].assignees = [agent]` only when that role has no staffing yet.
  - On read, `routing[role]` = the `runtimeProfileIds` of the first agent in `staffing[role].assignees`.

- [ ] **Step 4: Run** `npm run build && node scratch/staffing-check.mjs && node scripts/run-checks.mjs`. Expected: all pass.

- [ ] **Step 5: Commit** — `feat(application): identity seam, team and staffing services`

---

### Task 4: Engine — resolution at READY, agent selection, attribution

**Files:**
- Modify: `packages/application/src/engine/scheduler.ts`
  - `#promoteReady`: when a task becomes READY, resolve and snapshot.
  - `#dispatchFor`: route on `task.executor`, which is now derived from the snapshot.
- Modify: `packages/application/src/engine/task-executor.ts`
  - `#candidateProfiles`: agent candidates' ranked profiles, then the legacy `routing`, then all.
  - Record `runs.agentMemberId`, and re-derive `responsibleId` from the selected agent's owner.
- Modify: `packages/application/src/engine/harvester.ts` — set `authorId` to the run's agent member or `system:runtime`, and `responsibleId` to `task.responsibleId`.
- Modify: `packages/application/src/support/event-recorder.ts` — add `actorId` to `EventScope`, persisted to `run_events.actor_id`.
- Modify: `packages/domain/src/workflow.ts:246` and `packages/application/src/planning/parse.ts:109` — a human step keeps `step.role` when given, and falls back to `HUMAN_ROLE_ID` only when there is none.
- Modify: `packages/application/src/services/mission-service.ts`
  - `completeTask(caller, id, request)`: allowed for the assignee or a claimable member, or an owner acting `onBehalfOf`. Sets the artifact `authorId` / `recordedBy` / `responsibleId`.
  - New `claimTask(caller, id, { onBehalfOf })`.
  - `create(caller, request)`: sets `createdBy`.
- Modify: `packages/evaluation/src/facts.ts` — `task.attempt`, `task.role`, `task.risk`, `task.risk_level`, `diff.files_changed`, following the existing fact descriptor pattern (name, description, example). `task.risk` = the `maxRisk` over the task's capabilities' risk classes; use the existing capability→risk mapping in `packages/domain/src/capability.ts`.
- Test: section "engine: resolution" in `scratch/staffing-check.mjs`, using the generic runtime's fake profile, as `feedback-loop-check.mjs` does.

**Interfaces:**
- Consumes: `StaffingResolver`, `actorFor`, and the repositories from Tasks 2–3.
- Produces:
  - `MissionService.claimTask(caller: Caller, taskId: TaskId, request: ClaimTaskRequest): Promise<TaskView>`
  - `completeTask(caller, taskId, request)` and `create(caller, request)` with the new `caller` parameter.
  - Snapshot semantics: `task.staffing` is non-null once READY.

**Required behaviours, each an assertion in the check:**
1. A mission whose design task is staffed to Ana's agent (the fake runtime writes a valid artifact) completes. `run.agentMemberId === anaAgent`, `artifact.authorId === anaAgent`, `artifact.responsibleId === ana`, `task.responsibleId === ana`, and the `run_events` for the run carry `actor_id = anaAgent`.
2. Zero configuration (a fresh workspace, no members except the owner, no staffing) behaves as before: the task runs on the fake profile, `authorId === 'system:runtime'` and `responsibleId === owner`. **A1.**
3. A task staffed `{assignees: [bo]}` goes to `AWAITING_HUMAN` with `assigneeId = bo` and `executor = human`, and its `roleId` is unchanged. `completeTask(caller, id, { result, onBehalfOf: bo })` leaves the artifact with `authorId = bo` and `recordedBy = owner`. **A3/A6.**
4. A pool `{assignees: [ana, bo], mode: 'pool'}` sits in `AWAITING_HUMAN` with `assigneeId = null`. `claimTask(caller, id, { onBehalfOf: bo })` sets `assigneeId = bo` and `responsibleId = bo`. `completeTask` for someone who has not claimed the task (Ana) → `CONFLICT`. **A7.**
5. Mid-mission change: while task 1 is RUNNING (the fake script `delay` step), `patchWorkspace` changes development staffing. Task 2 (still PENDING) resolves using the new staffing when it becomes READY. A task already READY keeps its snapshot. **A12.**
6. `removeMember(ana)` → the next READY design task skips Ana's agent and uses the next candidate. If there is none, it falls back and is escalated in Task 5. **A11.**
7. The fact `task.risk_level` is 5 for a task whose capabilities include a release-class capability, and 0 for read-only.

- [ ] Step 1: Write the failing engine section (the 7 assertions above, following the composition and fake-runtime setup of `feedback-loop-check.mjs`, including its `until()` polling helper).
- [ ] Step 2: Run it and confirm it fails.
- [ ] Step 3: Implement the modifications listed under Files.
  - The human branch in `#dispatchFor` uses `task.statusReason = 'Waiting for <assignee name>.'` or `'Waiting for someone to claim this.'`.
  - The persistence patch that writes the snapshot also sets `executor` from `resolved.executor`, but only for tasks whose executor is `agent` or `human`. `wait` is never changed.
- [ ] Step 4: Run `npm run build && node scratch/staffing-check.mjs && node scripts/run-checks.mjs`. All must pass, including `workflow-check`, `planner-steps-check` and `feedback-loop-check`.
- [ ] Step 5: Commit: `feat(engine): staffing resolution, agent members and attribution`

---

### Task 5: Reviews, addressing, escalation, record-on-behalf

**Files:**
- Create: `packages/application/src/engine/reviews.ts`
- Modify: `task-executor.ts`
  - `#judge`, when `verdict.passed`: call `ReviewPipeline.onRoundPassed(...)` instead of the inline `approvalPolicy.onCompletion` check.
  - `#approvalBeforeStart` and `#createInterventionApproval`: set `addressees` = [responsible].
- Modify: `services/approval-service.ts`
  - `decide(caller, id, request)`: `decidedBy` = actor, `recordedBy`.
  - After a blocking review is approved, call `ReviewPipeline.onReviewApproved` (next review or sign-off, else SUCCEEDED).
  - A `check` kind: "looks_good" or "needs_changes" (the latter sets `needsAttention` and records `task.attention`).
- Modify: `tools/ask-human.ts` — addressees are the assignee (if a person) followed by the responsible person.
- Modify: `scheduler.ts` — call `ReviewPipeline.sweepEscalations(now)` on every tick.
- Modify: `packages/domain/src/event.ts` — add orchestration events `approval.escalated {approvalId, to: string[], level}`, `review.skipped {taskId, when, facts}` and `task.attention {taskId, note}`.
- Modify: `packages/policy/src/approvals.ts` — the factory accepts `addressees` and `escalateAfterMs` and computes `escalateAt`.
- Modify: `support/approval-view.ts` — fill `addressees`, `decidedByRef`, `recordedByRef` and `escalationLevel`.
- Test: section "engine: reviews and escalation".

**Interfaces produced:**

```ts
export const LOOKS_GOOD_OPTION = 'looks_good';
export const NEEDS_CHANGES_OPTION = 'needs_changes';   // in domain/entities/approval.ts; isAffirmative('check', 'looks_good') === true
export class ReviewPipeline {
  constructor(deps: {...});
  /** Called when a round passes its gate. Returns the settled outcome for the task. */
  onRoundPassed(input: { task: MissionTask; mission: Mission; workspace: Workspace; role: RoleTemplate; gate: GateOutcome | null; checks: readonly CheckResult[]; scope: EventScope }): TaskAttemptOutcome;
  /** Called by ApprovalService after a blocking review approval is APPROVED. */
  onReviewApproved(approval: Approval): void;
  sweepEscalations(nowMs: number): number;   // returns how many escalated
}
```

**Semantics:**
- **Effective reviews.** `task.staffing.staffing.reviews`. If that is empty and `approvalPolicy.onCompletion`, use `[{ by: 'responsible', mode: 'blocking', when: 'always' }]`.
- **Where the pipeline is.** Stored on the approval as evidence `{ kind: 'text', label: 'Review', value: '<index>/<total>' }`, plus `{ label: 'Sign-off', value: 'lead' }` for a sign-off step. This way resuming after a daemon restart is derived from the approvals alone, with no new column.
- **Evaluating `when`.** `evaluateGate(when, facts)`, with the facts from `deps.gates` for this task. A false result → emit `review.skipped` and continue.
- **Blocking review.** Create a completion approval using the existing text from `#createCompletionApproval` (move that into `reviews.ts`), with `addressees = reviewersFor(...)` and `escalateAt = now + escalateAfterMs`. Settle `AWAITING_APPROVAL`.
- **Approval flow.** On approve: run the next review. If this was the last one and `signOffLead(team, responsible)` exists and no sign-off approval has been created yet, create one addressed to the lead. Otherwise the task is SUCCEEDED. On reject: the existing behaviour, unchanged.
- **After review.** Create a `check` approval with options `looks_good` (recommended) and `needs_changes`. Title: `Check <task title> when you can`. It does not block. Continue to the next review.
- **Escalation sweep.** Every `PENDING` approval with `escalateAt <= now`:
  - `chain = escalationChain(team, task.responsibleId ?? owner)`
  - `next` = the first chain member not already in `addressees`
  - If `next` exists: `addressees = [...addressees, next]`, `escalationLevel + 1`, `escalateAt = now + escalateAfterMs`, emit `approval.escalated`. Otherwise `escalateAt = null`.
  - Pool tasks in `AWAITING_HUMAN` without an assignee, whose `updatedAt + escalateAfterMs <= now`: add the owners to `staffing.claimable`, emit `task.status` with reason `'Escalated: nobody claimed it.'`, and touch `updatedAt`.
- **`decide`.** Uses `actorFor(workspaceId, caller, request.onBehalfOf)`. `decidedBy = actorId`, `recordedBy`.

**Assertions:**
1. A2: product task with `reviews: [{by: responsible, blocking}]` gets one approval addressed to the owner. Deciding it makes the task SUCCEEDED and moves downstream to READY.
2. A4: design by Ana's agent → approval `addressees = [ana]`. Maria is not addressed.
3. A5: Maria with `both_sign_off` → after Ana approves, the task stays in AWAITING_APPROVAL and a new approval is addressed to `[maria]`. After Maria approves, SUCCEEDED.
4. A6: `decide(caller, id, { optionId: 'approve', onBehalfOf: ana })` gives `decidedBy = ana` and `recordedBy = owner`. The view has `decidedByRef.name === 'Ana'`.
5. A8: architecture `mode: after` → the task is SUCCEEDED immediately, a `check` approval exists and is PENDING, and downstream is READY. Deciding `needs_changes` with a note → `task.needsAttention === true` and a `task.attention` event.
6. A9: `when: 'task.risk_level >= 2'` → a read-only task gets no approval (a `review.skipped` event), and a task with an external side-effect capability gets an approval.
7. A10: `escalateAfterMs: 50`, and after about 120 ms of ticks the addressees grow `[ana] → [ana, maria] → [ana, maria, owner]` with `escalationLevel` 2. Then `escalateAt` is null.
8. `ask_human` from Ana's agent → addressees `[ana]`.
9. Existing `feedback-loop-check` still passes: reject-with-note revision is unchanged.

- [ ] Step 1: Write the failing section with the 9 assertions.
- [ ] Step 2: Run it and confirm it fails.
- [ ] Step 3: Implement.
- [ ] Step 4: Run `npm run build && node scratch/staffing-check.mjs && node scripts/run-checks.mjs`. All pass.
- [ ] Step 5: Commit: `feat(engine): staffed reviews, addressing, escalation and sign-off`

---

### Task 6: Daemon — principal, routes, local person name

**Files:**
- Modify: `apps/daemon/src/http/router.ts`
  - `RequestContext` gains `readonly caller: Caller`.
  - The server sets it after `verifyBearer`, from an `identityResolver(token) => Caller` passed in by `server.ts`.
- Modify: `apps/daemon/src/http/server.ts` and the composition root in `apps/daemon/src/main.ts` (or wherever services are created)
  - Build `IdentityPort` with a display name from `git config --global user.name` (via `execFileSync`, which is allowed in the daemon), falling back to `os.userInfo().username`.
  - If the local person's `displayName` still equals the migration default and git provides a name, rename the person once at startup.
- Modify: `apps/daemon/src/routes.ts` — the new routes from the spec's API section. Pass `ctx.caller` to every mutating service method that now takes a `Caller`.
- Modify: `apps/desktop/src/renderer/src/lib/daemon.ts` — typed client functions `me`, `listPeople`, `createPerson`, `updatePerson`, `removePerson`, `team`, `addMember`, `updateMember`, `removeMember`, `getStaffing`, `patchStaffing`, `patchMissionStaffing`, `patchTaskStaffing`, `previewStaffing`, `claimTask`, plus `onBehalfOf` on `decideApproval`, `completeTask` and `createMission`.
- Test: section "http" in `scratch/staffing-check.mjs`. Start the daemon the way `scratch/e2e-daemon.mjs` does (read it first) against a temp `TANDEMISE_HOME`, then exercise every new route with `fetch` and the bearer token.
  - Assert status codes: 200; 400 VALIDATION for bad staffing; 409 CONFLICT for removing the last owner; 403 FORBIDDEN for `onBehalfOf` a non-member.
  - Assert `GET /v1/me`.
  - Assert that `PATCH /v1/workspaces/:id` with `routing` for one role keeps the other roles (A14 over HTTP).

- [ ] Step 1: Write the failing HTTP section.
- [ ] Step 2: Run it and confirm it fails.
- [ ] Step 3: Implement.
- [ ] Step 4: Run `npm run build && node scratch/staffing-check.mjs && node scripts/run-checks.mjs && npm run check:boundaries`.
- [ ] Step 5: Commit: `feat(daemon): request principal and team/staffing routes`

---

### Task 7: Desktop — Team, staffing editor, Inbox, attribution

**Files:**
- Create: `apps/desktop/src/renderer/src/screens/team/Team.tsx` (tree plus member drawer), `team/MemberForm.tsx`, `team/StaffingEditor.tsx` (presets plus custom), `components/ActorChip.tsx`, `screens/Inbox.tsx`
- Modify: `App.tsx` routes and nav
  - "Workforce" → "Team" at `#/team`, and `#/workforce` redirects there.
  - "Approvals" → "Inbox" at `#/inbox`, and `#/approvals` redirects there.
  - The badge counts approvals plus human tasks.
- Modify: `screens/mission/PlanPane.tsx` and `TaskDetail.tsx` — chips; override drawer (the `StaffingEditor` in task mode, disabled once running); Claim button; "on behalf of" selector.
- Modify: `screens/approvals/ApprovalCard.tsx` — "For: Ana" addressees, "Escalated to Maria" line, "Recording for" select (defaulting to me) sent as `onBehalfOf`, and a `check` kind rendering "Looks good / Needs changes".
- Modify: artifact reader header and timeline rows — `ActorChip` ("by X · responsible Y · recorded by Z" when that differs).
- Modify: `NewMission.tsx` — an optional collapsible "Staffing for this mission" section per role, using `StaffingEditor` in mission mode.
- Delete: `screens/Workforce.tsx` once Team fully replaces it. Its ranked runtime list per agent lives in `MemberForm` for agents.
- Create: `packages/domain/src/staffing-presets.ts` (pure preset ⇄ staffing mapping, shared by the UI and the check; export it from the domain index)
- Test: `npm run -w @tandemise/desktop typecheck && npm run check:design`, plus preset round-trip assertions in `scratch/staffing-check.mjs`

**Presets** (`packages/domain/src/staffing-presets.ts`):

```ts
export const STAFFING_PRESETS = ['ai_only', 'ai_then_approve', 'ai_then_check', 'person', 'pool', 'ai_safety_net', 'custom'] as const;
export type StaffingPreset = (typeof STAFFING_PRESETS)[number];
export function presetToStaffing(preset: Exclude<StaffingPreset, 'custom'>, picks: { agents: string[]; people: string[] }): StaffingPatch {
  switch (preset) {
    case 'ai_only': return { assignees: picks.agents, mode: 'first_available', reviews: [] };
    case 'ai_then_approve': return { assignees: picks.agents, mode: 'first_available', reviews: [{ by: 'responsible', mode: 'blocking', when: 'always' }] };
    case 'ai_then_check': return { assignees: picks.agents, mode: 'first_available', reviews: [{ by: 'responsible', mode: 'after', when: 'always' }] };
    case 'person': return { assignees: picks.people.slice(0, 1), mode: 'first_available', reviews: [] };
    case 'pool': return { assignees: picks.people, mode: 'pool', reviews: [] };
    case 'ai_safety_net': return { assignees: picks.agents, mode: 'first_available', reviews: [{ by: 'responsible', mode: 'blocking', when: 'task.risk_level >= 2' }] };
  }
}
/** Recognises a stored staffing as a preset, or 'custom'. Round-trips presetToStaffing. */
export function staffingToPreset(s: StaffingPatch, team: Team): { preset: StaffingPreset; agents: string[]; people: string[] };
```

Check assertions: every preset round-trips (`staffingToPreset(presetToStaffing(p, picks)).preset === p`), and a hand-edited staffing (for example, two reviews) maps to `custom`.

**UX rules** (from the roadmap: short and scannable):
- **Team tree.** Each node shows name, title, a kind badge, the owner for agents, role chips and an inactive state. Actions go in a drawer, not inline.
- **Staffing tab.** One row per role: role name, then "Preset ▾", then a one-line summary ("Ana's Figma agent · Ana approves"). Custom opens the full editor.
- **Inbox.** Filter tabs *For me* (default) / *Everyone*. Items are sorted with escalated items first, then oldest first. Each item is one line of title plus a "For · Escalation · Mission" meta line.
- **Tokens.** Use only the tokens and components that already exist (`docs/DESIGN_SYSTEM.md`). No new colours.

- [ ] Step 1: Add the failing preset round-trip assertions to the check.
- [ ] Step 2: Run it and confirm it fails.
- [ ] Step 3: Implement the presets, then the screens.
- [ ] Step 4: Run `npm run build && node scratch/staffing-check.mjs && npm run -w @tandemise/desktop typecheck && npm run check:design`.
- [ ] Step 5: Commit: `feat(desktop): team tree, staffing editor, inbox and attribution`

---

### Task 8: Controlled real-app acceptance (A1–A15)

Run this task in the main session. Do not delegate it: it is the proof.

**Files:**
- Create: `scratch/acceptance/p0/scripted-agent.mjs`
  - A generic-CLI runtime command.
  - Reads the prompt (stdin or argument, whichever the generic CLI adapter passes; read `packages/runtime-generic/src/generic-cli.ts`).
  - Finds the output contract paths `.tandemise/out/<taskId>/<Type>.md`.
  - Renders a valid artifact for each type with minimal front matter (by importing `renderArtifactTemplate` from `packages/artifacts/dist` and filling the required fields).
  - Honours `SCRIPTED_DELAY_MS`.
- Create: `scratch/acceptance/p0/setup.mjs`
  - Creates `$SCRATCH/home`, a scratch git repository (`README.md`, `package.json` with `test`/`build` scripts that exit 0) and the daemon, started with `TANDEMISE_HOME`.
  - Registers the repository, creates the generic runtime profile pointing at the scripted agent, and prints `{url, token, workspaceId}`.
- Create: `scratch/acceptance/p0/cdp.mjs` — helpers: connect to `http://127.0.0.1:9333`; `evaluate`, `navigate(hash)`, `text(selector)`, `click(text)`, `fill(label, value)`, `screenshot(path)`.
- Create: `scratch/acceptance/p0/run-scenarios.mjs` — each scenario sets state through the UI where the scenario is about the UI, and through the API only for setup, then asserts the API state and the DOM text and saves a screenshot to `scratch/acceptance/p0/evidence/<id>.png`.
- Create: `docs/superpowers/evidence/2026-09-13-p0-acceptance.md` — a table of scenario, result, API proof, DOM proof and screenshot filename.

**Procedure:**

1. Build: `npm run build`.
2. Run `node scratch/acceptance/p0/setup.mjs`.
3. Launch Electron in the background:

   ```
   cd apps/desktop && TANDEMISE_HOME=$SCRATCH/home npx electron-vite dev -- --remote-debugging-port=9333 --user-data-dir=$SCRATCH/electron
   ```

   The desktop discovers the daemon through `daemon.json` in `TANDEMISE_HOME`; confirm by reading how the desktop locates the daemon.
4. Run each scenario A1–A15 from the spec table. A15 uses a real Claude runtime profile (discovered with `POST /v1/runtimes/discover`) for Ana's agent on a trivial ProductSpec task.
5. For every failure, stop, use superpowers:systematic-debugging, fix the code on this branch, add a regression assertion to `staffing-check.mjs`, rebuild, restart the daemon and Electron, and re-run the **whole** scenario list from A1.
6. Done only when every scenario passes in a single uninterrupted run, `npm run ci` passes, and the evidence doc is written with screenshots viewed (read each PNG and confirm it shows what the row claims).

- [ ] Step 1: Harness files.
- [ ] Step 2: A full scenario run.
- [ ] Step 3: Fix loop until clean.
- [ ] Step 4: Evidence doc and commit: `test(acceptance): P0 real-app scenarios A1–A15`

---

## Self-review notes

- **Spec coverage.**
  - Concepts, invariants: T1/T3.
  - Precedence and per-role merge: T1/T3.
  - Legacy routing: T2/T3.
  - Resolution and snapshot: T4.
  - Reviews, `check` kind, `when` facts: T4/T5.
  - Addressing, escalation, `onBehalfOf`: T5/T6.
  - Migration: T2.
  - API: T3/T6.
  - Desktop: T7.
  - Errors: T3/T5.
  - Testing and acceptance: T1–T8.
  - `notify` is stored and validated, but P0 has no notification transport. The Inbox shows FYI items as `check` approvals only if a review requests them, so `notify` is surfaced read-only in the staffing summary. That is an explicit limitation, tracked for P4 notifications.
- **Type names** are consistent across tasks: `Caller`, `actorFor`, `StaffingResolver`, `ReviewPipeline`, `ResolvedStaffingSnapshot`, `LOOKS_GOOD_OPTION`, `NEEDS_CHANGES_OPTION`, `ActorRef`.
