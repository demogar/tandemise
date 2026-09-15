# P2: Feedback and rounds — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A person gives feedback on any task's output at any time: while it waits, after it finished, or while it runs. The same task comes back as its next **round**. It continues its session when it can, otherwise it starts from its last output plus every piece of feedback so far. Its handoff says what changed and which feedback each change answers. The person decides what happens to work that already used the old version. AI reviewers' blocking findings join the same loop.

**Architecture:**
- The domain gains a `FeedbackItem` entity, run purposes, round numbers and four timeline events. Pure citation rules live in `@tandemise/domain` and `packages/application/src/support/feedback-rules.ts`.
- Migration 010 adds `feedback`, `run_inputs`, `mission_tasks.round`, `artifacts.round`, `runs.round` and `runs.purpose`.
- One engine component, `FeedbackRounds` (`packages/application/src/engine/feedback-rounds.ts`), owns rounds: it records items, computes downstream impact, starts rounds (redo/keep), builds the round brief and contract, marks items addressed, flags stale consumers, and turns AI review findings into rounds. The executor, scheduler, approval service, mission service and the new `FeedbackService` all call it. It has no service dependencies, so no cycles.
- The executor compiles a round prompt (request framing), continues the last settled session when the runtime declares `session_resume`, records `run_inputs`, validates `handoff.changed` citations at harvest, and delivers queued notes at the end of a pass.
- The desktop gains a "Request changes" composer, an impact dialog, round badges, "What changed" with authors, a reader version switcher with "Changes in vN", a feedback thread in the task drawer and "Retry with a note".

**Tech stack:** as P0/P1. TypeScript ESM, zod, better-sqlite3, React 19. Checks are `scratch/*.mjs` node scripts run against `dist/`.

**Spec (binding):** `docs/superpowers/specs/2026-09-14-p2-feedback-rounds-design.md`, including §10 rulings. Read it first. Roadmap: `docs/superpowers/specs/2026-09-13-collaboration-roadmap.md`. Actor rules: `docs/superpowers/specs/2026-09-13-p0-members-responsibility-design.md` ("Actor", "Deciding for someone").

## Global Constraints

Binding values from the spec:
- Feedback `text`: 1–4000 characters after trim. Enforced by zod (`z.string().trim().min(1).max(4000)`) and by a SQL `CHECK (length(text) BETWEEN 1 AND 4000)`.
- Feedback statuses, exactly: `open` · `queued` (waiting for a running pass to end) · `in_round` (being addressed by round N) · `addressed` (round N delivered and cited it) · `dismissed`.
- Feedback ids are `fb_…` (`ids.feedback()`); `attachments` is always `[]` in P2 (reserved for P3).
- `runs.purpose` ∈ `round | tighten | feedback | retry`; legacy rows are NULL.
- `mission_tasks.round INTEGER NOT NULL DEFAULT 1`; `artifacts.round INTEGER`; `runs.round INTEGER`.
- Round 1 is the task's first passed attempt. Attempts (retries after gate failures) happen inside a round and do not start a new one.
- A queued-note delivery pass runs in the **same round** and does **not** count against `maxAttempts`; `task.attempts` is unchanged by it. Same for the tighten pass (P1).
- The round prompt is framed as an owner's **request, not a gate failure**. The text "did not satisfy this task's completion gate" never appears in the first attempt of a round.
- **No `_revision_` clones for owner feedback.** `RemediationPlanner.planRevision` is removed. Existing `_revision_N` tasks in old missions still display. AI fix tasks for QA defects stay (`fix_<key>_N`, `<key>_recheck_N`).
- `MAX_REMEDIATION_CYCLES` = 3: at most 3 AI-started rounds per reviewed task; then the review escalates with an intervention card, as today.
- P1 handoff limits stay: `handoff.changed` ≤ 3 entries, each `{what ≤ 140, feedback?}`; headline ≤ 90; points ≤ 3 × 140; needs ≤ 140; links ≤ 5; title ≤ 60.
- Round validation (P1 contract tightened): `changed` has ≥ 1 entry; every cited `fb_` id exists on the task; every item being addressed is cited (addressed, or declined with `what: "Declined: <reason>"`). A violation is a malformed artifact → a counted retry whose feedback names the missing ids.
- Continue a session only when the runtime declares `session_resume` and the last run has an `externalSessionId`, whatever that run's status. Codex does not declare it and gets fresh rounds. The previous output is inlined in both cases.
- Only `end_of_pass` delivery. `interrupt` wake is not built.
- P0 actor rules: every feedback item stores `author_id` (the `onBehalfOf` member or the principal's member; an agent member or `system:runtime` for AI findings) and `recorded_by` (the principal's member; `system` for AI findings). `onBehalfOf` must be an active person member of the workspace. Without it the principal is both.
- Dependents are known from `run_inputs`, not guessed; the only fallback is for runs from before migration 010 (spec §3).
- Task transitions stay per call site; guards are added where P2 reopens tasks. No task state machine.

Repo rules:
- Node 22. `npm run build`; CI = `npm run ci`, which must pass at the end of every task.
- Layering is enforced by `npm run check:boundaries`. `@tandemise/application` may not import `@tandemise/artifacts` or `@tandemise/persistence`; the renderer imports only types from `@tandemise/*` (plus the allowlisted pure subpaths).
- Desktop uses design-system tokens only (`npm run check:design`): no colour literals, no undefined `var(--…)`, no `var()` fallbacks.
- Released migrations are immutable. Append `010` only.
- Comments explain *why*, in full sentences.
- Commit messages follow Conventional Commits and end with the trailer `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.
- Real-app proof for every scenario (C1–C12) plus full P0 and P1 regression runs, before the branch is offered for review. Offline checks are required but are not that proof.

---

## File map

| File | Responsibility |
|---|---|
| `packages/shared/src/ids.ts` (modify) | `FeedbackId`, `ids.feedback()` |
| `packages/domain/src/entities/feedback.ts` (create) | `FeedbackItem`, `FEEDBACK_STATUSES`, `RUN_PURPOSES`, `citedFeedbackIds`, `isDeclinedChange` |
| `packages/domain/src/entities/{task,run,artifact,approval}.ts` (modify) | `round`, `purpose`, `REQUEST_CHANGES_OPTION` |
| `packages/domain/src/event.ts` (modify) | `feedback.given`, `feedback.addressed`, `feedback.dismissed`, `task.round_started` |
| `packages/domain/src/ports/repositories.ts` (modify) | `FeedbackRepositoryPort`, `RunInputRepositoryPort` |
| `packages/persistence/src/migrations/010_feedback_rounds.ts` (create) | schema |
| `packages/persistence/src/repositories/{feedback,run-input}-repository.ts` (create) | SQLite ports |
| `packages/persistence/src/repositories/{task,run,artifact}-repository.ts` (modify) | map new columns |
| `packages/persistence/src/{tokens,module,index}.ts`, `packages/application/src/tokens.ts` (modify) | tokens and bindings |
| `packages/application/src/support/downstream.ts` (create) | pure `downstreamConsumers`, `reviewedTaskOf` |
| `packages/application/src/support/feedback-rules.ts` (create) | pure `feedbackEffectFor`, `RoundBrief`, `RoundContract`, `checkRoundHandoff`, `renderRoundBrief`, `roundRequest`, `capDraft` |
| `packages/application/src/engine/feedback-rounds.ts` (create) | `FeedbackRounds` |
| `packages/application/src/services/feedback-service.ts` (create) | `FeedbackServiceImpl` |
| `packages/application/src/engine/task-executor.ts`, `harvester.ts`, `scheduler.ts`, `reviews.ts`, `remediation.ts` (modify) | rounds in the engine |
| `packages/application/src/services/{approval,mission,projection,artifact}-service.ts`, `services.ts`, `module.ts`, `index.ts` (modify) | wiring and views |
| `packages/api-contract/src/{requests,views}.ts` (modify) | requests and views |
| `packages/runtime-generic/src/{fake-script,fake}.ts` (modify) | script `captures` for tests |
| `apps/daemon/src/routes.ts` (modify) | four routes |
| `apps/desktop/src/renderer/src/components/{RequestChanges,ImpactDialog}.tsx` (create) | composer, dialog |
| `apps/desktop/src/renderer/src/lib/line-diff.ts` (create) | line diff for "Compare with vN-1" |
| `apps/desktop/src/renderer/src/components/{HandoffCard,Decision}.tsx`, `screens/artifacts/ArtifactReader.tsx`, `screens/mission/{TaskDetail,FeedPane}.tsx`, `lib/{daemon,queries,events,domain}.ts`, `styles/features.css` (modify) | UI |
| `scratch/rounds-check.mjs` (create), `scripts/run-checks.mjs` (modify) | offline check |
| `scratch/{handoff,staffing,feedback-loop}-check.mjs` (modify) | fixtures and assertions P2 changes on purpose |
| `scratch/acceptance/p0/{scripted-agent,setup,run-all}.mjs`, `p0/lib/ctx.mjs`, `p0/workflows/p2-{solo,chain}.yaml`, `p0/suite/s03-team-mission.mjs`, `p2/suite/*.mjs` | acceptance |

---

### Task 1: Domain, migration 010 and repositories

**Files:**
- Modify: `packages/shared/src/ids.ts`
- Create: `packages/domain/src/entities/feedback.ts`; modify `packages/domain/src/index.ts`, `entities/task.ts`, `entities/run.ts`, `entities/artifact.ts`, `entities/approval.ts`, `event.ts`, `ports/repositories.ts`
- Create: `packages/persistence/src/migrations/010_feedback_rounds.ts`, `repositories/feedback-repository.ts`, `repositories/run-input-repository.ts`
- Modify: `packages/persistence/src/migrations/index.ts`, `repositories/task-repository.ts`, `repositories/run-repository.ts`, `repositories/artifact-repository.ts`, `tokens.ts`, `module.ts`, `index.ts`
- Modify: `packages/application/src/tokens.ts` (mirror tokens, add to `PERSISTENCE_PORT_TOKENS`)
- Modify: `apps/desktop/src/renderer/src/lib/domain.ts` (the `SEMANTIC` table is keyed by the event union, so it must list the four new types; add `REQUEST_CHANGES_OPTION` mirror)
- Create: `scratch/rounds-check.mjs`; modify `scripts/run-checks.mjs` (add `'rounds-check'` to `OFFLINE_CHECKS`, alphabetically after `'routing-overcommit-check'`)
- Modify: `scratch/handoff-check.mjs:246-260` and `scratch/staffing-check.mjs:167` (they pin `SCHEMA_VERSION === 9`)

**Interfaces consumed:** `ArtifactHandoff` (P1), `newId`, `Migration`.

**Interfaces produced:**

```ts
// shared/ids.ts
export type FeedbackId = Brand<string, 'FeedbackId'>;
// in `ids`: feedback: () => newId<'FeedbackId'>('fb'),

// domain/entities/feedback.ts
import type { ArtifactId, FeedbackId, TaskId, Timestamp } from '@tandemise/shared';
import type { ArtifactHandoff } from './artifact.js';

export const FEEDBACK_STATUSES = ['open', 'queued', 'in_round', 'addressed', 'dismissed'] as const;
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];
/** Given and not yet taken into a round: what a card counts as "notes pending". */
export const PENDING_FEEDBACK_STATUSES: readonly FeedbackStatus[] = ['open', 'queued'];
export const FEEDBACK_TEXT_MAX = 4000;

export const RUN_PURPOSES = ['round', 'tighten', 'feedback', 'retry'] as const;
export type RunPurpose = (typeof RUN_PURPOSES)[number];

/** Reserved for P3 (uploads, hand-backs); always empty in P2. */
export type FeedbackAttachment = Readonly<Record<string, unknown>>;

export interface FeedbackItem {
  readonly id: FeedbackId;
  readonly taskId: TaskId;
  /** Feedback about one output; null for the whole task. */
  readonly artifactId: ArtifactId | null;
  /** A person member, an agent member (AI review findings) or `system:runtime`. */
  readonly authorId: string;
  /** The P0 on-behalf-of rule: the principal's member, or `system` for engine-authored findings. */
  readonly recordedBy: string;
  readonly text: string;
  readonly attachments: readonly FeedbackAttachment[];
  readonly status: FeedbackStatus;
  /** The round that addresses it, once known. */
  readonly round: number | null;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
}

/** Declines are entries like any other change, so the card can show them next to the note they answer. */
export const DECLINED_PREFIX = 'Declined:';
export function isDeclinedChange(what: string): boolean {
  return what.trimStart().toLowerCase().startsWith(DECLINED_PREFIX.toLowerCase());
}

/**
 * Every feedback id a handoff cites, in order of first appearance. One entry
 * may answer several notes ("fb_a, fb_b"): `changed` holds at most three
 * entries and a round can carry more notes than that.
 */
export function citedFeedbackIds(handoff: Pick<ArtifactHandoff, 'changed'> | null | undefined): readonly string[] {
  const ids = new Set<string>();
  for (const change of handoff?.changed ?? []) {
    for (const match of (change.feedback ?? '').matchAll(/fb_[0-9a-z]{20}/g)) ids.add(match[0]);
  }
  return [...ids];
}

// domain/entities/task.ts — MissionTask gains (optional so existing builders compile; read back as 1):
//   readonly round?: number;
// domain/entities/run.ts — Run gains:
//   readonly round?: number | null;   readonly purpose?: RunPurpose | null;
// domain/entities/artifact.ts — ArtifactManifest gains:
//   readonly round?: number | null;
// domain/entities/approval.ts:
export const REQUEST_CHANGES_OPTION = 'request_changes';   // isAffirmative stays false for it

// domain/event.ts — OrchestrationEvent gains:
//   | { type: 'feedback.given'; feedbackId: string; status: FeedbackStatus; excerpt: string }
//   | { type: 'feedback.addressed'; feedbackId: string; round: number; declined: boolean }
//   | { type: 'feedback.dismissed'; feedbackId: string }
//   | { type: 'task.round_started'; round: number; feedbackIds: readonly string[]; downstream: 'redo' | 'keep' | 'none'; redone: readonly string[] }
// and all four join SEMANTIC_EVENT_TYPES.

// domain/ports/repositories.ts
export interface FeedbackRepositoryPort {
  create(item: FeedbackItem): FeedbackItem;
  get(id: FeedbackId): FeedbackItem | undefined;
  /** Oldest first. */
  listByTask(taskId: TaskId): readonly FeedbackItem[];
  /** Oldest first, through mission_tasks: one read for a whole feed. */
  listByMission(missionId: MissionId): readonly FeedbackItem[];
  listByStatus(statuses: readonly FeedbackStatus[]): readonly FeedbackItem[];
  /** Stamps `updatedAt`. */
  update(id: FeedbackId, patch: Partial<Pick<FeedbackItem, 'status' | 'round'>>): FeedbackItem;
}
export interface RunInputRepositoryPort {
  /** Idempotent: a run records what it was given once, and a restart may record it again. */
  record(runId: RunId, artifactIds: readonly ArtifactId[]): void;
  listByRun(runId: RunId): readonly ArtifactId[];
  listByMission(missionId: MissionId): readonly { readonly runId: RunId; readonly artifactId: ArtifactId }[];
}

// persistence/tokens.ts and application/tokens.ts (same names, `persistence.` / `port.` descriptions)
export const FEEDBACK_REPOSITORY = token<FeedbackRepositoryPort>('persistence.FeedbackRepository');
export const RUN_INPUT_REPOSITORY = token<RunInputRepositoryPort>('persistence.RunInputRepository');
```

- [ ] **Step 1: write the failing check.** Create `scratch/rounds-check.mjs` with this header and the two sections below.

```js
// P2 feedback and rounds. Pure rules and persistence first; later tasks append
// impact, service, http, engine and review sections.
//
//   npm run build && node scratch/rounds-check.mjs
let passed = 0;
const failures = [];
const check = (label, cond, detail) => {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failures.push(label); console.log(`  FAIL ${label}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`); }
};
const section = (t) => console.log(`\n== ${t}`);
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const code = async (fn) => { try { await fn(); return 'ok'; } catch (e) { return e.code ?? String(e); } };

section('pure: feedback entity');
{
  const D = await import('@tandemise/domain');
  const { ids } = await import('@tandemise/shared');
  const a = ids.feedback(); const b = ids.feedback();
  check('feedback ids are fb_ plus 20 characters', /^fb_[0-9a-z]{20}$/.test(a), a);
  check('statuses are exactly the spec list', eq(D.FEEDBACK_STATUSES, ['open', 'queued', 'in_round', 'addressed', 'dismissed']));
  check('run purposes are exactly the spec list', eq(D.RUN_PURPOSES, ['round', 'tighten', 'feedback', 'retry']));
  const handoff = { changed: [{ what: 'Shorter intro', feedback: `${a}, ${b}` }, { what: 'Declined: out of scope', feedback: a }, { what: 'Tidied', feedback: null }] };
  check('citedFeedbackIds reads several ids per entry, once each', eq(D.citedFeedbackIds(handoff), [a, b]));
  check('citedFeedbackIds of null is empty', eq(D.citedFeedbackIds(null), []));
  check('isDeclinedChange is case-insensitive on the prefix', D.isDeclinedChange('  declined: nope') && !D.isDeclinedChange('Not declined'));
  check('request_changes is not affirmative', !D.isAffirmative('action', D.REQUEST_CHANGES_OPTION));
  for (const type of ['feedback.given', 'feedback.addressed', 'feedback.dismissed', 'task.round_started']) {
    check(`${type} is on the semantic timeline`, D.SEMANTIC_EVENT_TYPES.has(type));
  }
}

section('persistence: migration 010');
{
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const P = await import('@tandemise/persistence');
  const { systemClock } = await import('@tandemise/shared');
  const dir = mkdtempSync(join(tmpdir(), 'tandemise-rounds-'));
  const db = P.openDatabase({ path: join(dir, 't.db') });
  P.migrate(db, undefined, P.MIGRATIONS.filter((m) => m.version <= 9));
  const h = db.handle;
  const now = '2026-09-14T00:00:00.000Z';
  h.pragma('foreign_keys = OFF');
  h.prepare(`INSERT INTO workspaces (id,name,default_repository_id,autonomy,concurrency,routing,default_autonomy_level,knowledge,created_at,updated_at)
             VALUES ('ws_r','R',NULL,'{}','{}','{}','supervised','{}',?,?)`).run(now, now);
  h.prepare(`INSERT INTO missions (id,workspace_id,title,goal,constraints,success_criteria,status,autonomy,workflow_preset,created_at,updated_at)
             VALUES ('m_r','ws_r','T','G','[]','[]','EXECUTING','balanced','standard',?,?)`).run(now, now);
  h.prepare(`INSERT INTO mission_tasks (id,mission_id,key,title,objective,role_id,required_capabilities,input_artifacts,expected_outputs,execution_policy,approval_policy,retry_policy,status,created_at,updated_at)
             VALUES ('t_r','m_r','design','T','O','design','[]','[]','["DesignBrief"]','{}','{}','{}','SUCCEEDED',?,?)`).run(now, now);
  h.prepare(`INSERT INTO runs (id,mission_id,task_id,assignment_id,attempt,status,role_id,runtime_profile_id,execution_target_id,started_at)
             VALUES ('r_old','m_r','t_r','wa',1,'SUCCEEDED','design','rt','tg',?)`).run(now);
  h.prepare(`INSERT INTO artifacts (id,workspace_id,mission_id,task_id,created_by_run_id,type,title,content_ref,media_type,sha256,byte_size,schema_version,created_at)
             VALUES ('ar_r','ws_r','m_r','t_r','r_old','DesignBrief','Brief','c','text/markdown','x',1,1,?)`).run(now);
  h.pragma('foreign_keys = ON');

  const result = P.migrate(db);
  check('a version 9 database migrates to 10', eq(result.applied, [10]) && P.schemaVersion(db) === 10, result);
  const tasks = new P.SqliteTaskRepository(db, systemClock);
  const runs = new P.SqliteRunRepository(db, systemClock);
  const artifacts = new P.SqliteArtifactRepository(db);
  check('an existing task is round 1', tasks.get('t_r')?.round === 1, tasks.get('t_r')?.round);
  check('an existing run has no round and no purpose', runs.get('r_old')?.round === null && runs.get('r_old')?.purpose === null, runs.get('r_old'));
  check('an existing artifact has no round', artifacts.get('ar_r')?.round === null);
  tasks.update('t_r', { round: 3 });
  check('a task round round-trips', tasks.get('t_r')?.round === 3);
  runs.update('r_old', { round: 2, purpose: 'feedback' });
  check('a run round and purpose round-trip', runs.get('r_old')?.round === 2 && runs.get('r_old')?.purpose === 'feedback');

  const feedback = new P.SqliteFeedbackRepository(db, systemClock);
  const item = { id: 'fb_aaaaaaaaaaaaaaaaaaaa', taskId: 't_r', artifactId: 'ar_r', authorId: 'mem_ana', recordedBy: 'mem_owner', text: 'Shorter intro', attachments: [], status: 'open', round: null, createdAt: now, updatedAt: now };
  feedback.create(item);
  check('a feedback item round-trips', eq(feedback.get(item.id), item), feedback.get(item.id));
  const moved = feedback.update(item.id, { status: 'in_round', round: 2 });
  check('update sets status and round and stamps updatedAt', moved.status === 'in_round' && moved.round === 2 && moved.updatedAt !== now, moved);
  check('listByTask, listByMission and listByStatus find it',
    feedback.listByTask('t_r').length === 1 && feedback.listByMission('m_r').length === 1 && feedback.listByStatus(['in_round']).length === 1 && feedback.listByStatus(['open']).length === 0);
  check('text over 4000 characters is refused by the schema', await code(() => feedback.create({ ...item, id: 'fb_bbbbbbbbbbbbbbbbbbbb', text: 'x'.repeat(4001) })) !== 'ok');
  check('empty text is refused by the schema', await code(() => feedback.create({ ...item, id: 'fb_cccccccccccccccccccc', text: '' })) !== 'ok');
  check('an unknown status is refused by the schema', await code(() => feedback.create({ ...item, id: 'fb_dddddddddddddddddddd', status: 'done' })) !== 'ok');
  check('an unknown run purpose is refused by the schema', await code(() => runs.update('r_old', { purpose: 'rewrite' })) !== 'ok');

  const inputs = new P.SqliteRunInputRepository(db);
  inputs.record('r_old', ['ar_r']);
  inputs.record('r_old', ['ar_r']);
  check('run_inputs record is idempotent', eq(inputs.listByRun('r_old'), ['ar_r']));
  check('run_inputs listByMission joins through runs', eq(inputs.listByMission('m_r'), [{ runId: 'r_old', artifactId: 'ar_r' }]));

  h.prepare("DELETE FROM missions WHERE id = 'm_r'").run();
  check('removing the mission removes its feedback and run inputs',
    h.prepare('SELECT count(*) AS n FROM feedback').get().n === 0 && h.prepare('SELECT count(*) AS n FROM run_inputs').get().n === 0);
  check('integrity_check returns ok', h.pragma('integrity_check', { simple: true }) === 'ok');
  db.close();
}
```

Append the footer once, at the end of the file; later tasks insert their sections above it:

```js
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { console.log(failures.map((f) => `  - ${f}`).join('\n')); process.exit(1); }
```

- [ ] **Step 2:** run `npm run build && node scratch/rounds-check.mjs`; it fails (no `ids.feedback`, no migration 10).

- [ ] **Step 3: implement.** Migration:

```ts
// packages/persistence/src/migrations/010_feedback_rounds.ts
import type { Migration } from './types.js';

/**
 * Feedback and rounds (P2 spec §7).
 *
 * `feedback` holds what people (and AI reviewers) asked a task to change. The
 * text limit is enforced here as well as at the API edge because an item is
 * quoted into prompts verbatim, and a row that bypassed the API must not blow
 * the context budget. Items cascade with their task: feedback about a task
 * that no longer exists has nothing to address.
 *
 * `run_inputs` records which artifacts a run was actually given, from the
 * context compiler's `includedArtifactIds`. Downstream impact is read from
 * it rather than guessed from the plan; runs from before this migration have
 * none, and the engine falls back to an inference only for them (their
 * `runs.round` is NULL, which is how it tells them apart).
 *
 * Nothing is copied or rebuilt: every change is an added table or column, so
 * the generated `artifacts.handoff_text` column and its FTS triggers from 009
 * are untouched.
 */
export const migration010: Migration = {
  version: 10,
  name: 'feedback_rounds',
  up: `
CREATE TABLE feedback (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES mission_tasks(id) ON DELETE CASCADE,
  artifact_id TEXT REFERENCES artifacts(id) ON DELETE SET NULL,
  author_id   TEXT NOT NULL,
  recorded_by TEXT NOT NULL,
  text        TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 4000),
  attachments TEXT NOT NULL DEFAULT '[]',
  status      TEXT NOT NULL CHECK (status IN ('open','queued','in_round','addressed','dismissed')),
  round       INTEGER CHECK (round IS NULL OR round >= 1),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX ix_feedback_task   ON feedback (task_id, created_at);
CREATE INDEX ix_feedback_status ON feedback (status);

ALTER TABLE mission_tasks ADD COLUMN round INTEGER NOT NULL DEFAULT 1 CHECK (round >= 1);
ALTER TABLE artifacts ADD COLUMN round INTEGER;
ALTER TABLE runs ADD COLUMN round INTEGER;
ALTER TABLE runs ADD COLUMN purpose TEXT CHECK (purpose IS NULL OR purpose IN ('round','tighten','feedback','retry'));

CREATE TABLE run_inputs (
  run_id      TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  PRIMARY KEY (run_id, artifact_id)
) WITHOUT ROWID;
CREATE INDEX ix_run_inputs_artifact ON run_inputs (artifact_id);
`,
};
```

Register it: `MIGRATIONS = [..., migration009, migration010]`.

Feedback repository (follow `run-repository.ts` for prepared statements):

```ts
// packages/persistence/src/repositories/feedback-repository.ts
interface FeedbackRow {
  id: string; task_id: string; artifact_id: string | null; author_id: string; recorded_by: string;
  text: string; attachments: string; status: string; round: number | null; created_at: string; updated_at: string;
}
const COLUMNS = 'id, task_id, artifact_id, author_id, recorded_by, text, attachments, status, round, created_at, updated_at';
const F_COLUMNS = COLUMNS.split(', ').map((c) => `f.${c}`).join(', ');

export class SqliteFeedbackRepository implements FeedbackRepositoryPort {
  // #insert: INSERT INTO feedback (${COLUMNS}) VALUES (:id, :task_id, ...)
  // #selectOne: WHERE id = :id
  // #byTask: WHERE task_id = :taskId ORDER BY created_at, id
  // #byMission: SELECT ${F_COLUMNS} FROM feedback f JOIN mission_tasks t ON t.id = f.task_id WHERE t.mission_id = :missionId ORDER BY f.created_at, f.id
  // #byStatus: WHERE status IN (SELECT value FROM json_each(:statuses)) ORDER BY created_at, id
  // #update: UPDATE feedback SET status = :status, round = :round, updated_at = :updated_at WHERE id = :id
  update(id: FeedbackId, patch: Partial<Pick<FeedbackItem, 'status' | 'round'>>): FeedbackItem {
    return this.#db.transaction(() => {
      const current = this.get(id);
      if (current === undefined) throw TandemiseError.notFound('Feedback', id);
      const next = { ...current, ...patch, updatedAt: this.#clock.now() };
      this.#update.run({ id, status: next.status, round: next.round, updated_at: next.updatedAt });
      return next;
    });
  }
}
// fromRow: attachments via parseJson(r.attachments, []), ids via asId.
```

Run-input repository: `INSERT OR IGNORE INTO run_inputs (run_id, artifact_id) VALUES (?, ?)` inside `db.transaction` for the list; `listByMission` is `SELECT i.run_id, i.artifact_id FROM run_inputs i JOIN runs r ON r.id = i.run_id WHERE r.mission_id = ? ORDER BY r.started_at, i.artifact_id`.

Column mapping:
- `task-repository.ts`: `round: number` in `TaskRow`; `toRow` writes `t.round ?? 1`; `fromRow` reads `r.round`; add `round` to `COLUMNS`, the INSERT value list and the UPDATE SET list.
- `run-repository.ts`: `round: number | null; purpose: string | null`; `toRow` writes `r.round ?? null`, `r.purpose ?? null`; add to `COLUMNS`, INSERT and UPDATE.
- `artifact-repository.ts`: add `'round'` to `COLUMN_LIST`; map `round: a.round ?? null` / `round: r.round`.
- Bind both new repositories in `persistence/module.ts`, export them from `index.ts`, and add `FEEDBACK_REPOSITORY` and `RUN_INPUT_REPOSITORY` to `application/tokens.ts` and to `PERSISTENCE_PORT_TOKENS`, so the daemon's alias loop picks them up.

Fixtures that pin the schema version on purpose:
- `scratch/handoff-check.mjs:260`: replace `P.migrate(db)` in that section with `P.migrate(db, undefined, P.MIGRATIONS.filter((m) => m.version <= 9))` and the check with `eq(result.applied, [9]) && P.schemaVersion(db) === 9`.
- `scratch/staffing-check.mjs:167`: `P.schemaVersion(db) === P.SCHEMA_VERSION && P.SCHEMA_VERSION >= 9`.

- [ ] **Step 4:** run `npm run build && node scratch/rounds-check.mjs && npm run check:boundaries && npm run -w @tandemise/desktop typecheck && node scripts/run-checks.mjs`. All green.
- [ ] **Step 5:** commit `feat(persistence): feedback items, run inputs and round columns (migration 010)`.

### Task 2: Downstream impact and round start (engine core)

**Files:**
- Create: `packages/application/src/support/downstream.ts`, `packages/application/src/engine/feedback-rounds.ts`
- Modify: `packages/application/src/tokens.ts` (`FEEDBACK_ROUNDS`), `module.ts` (bind; pass to scheduler), `index.ts` (export `FeedbackRounds`, `downstreamConsumers`, `reviewedTaskOf`, `ROUND_START_STATUSES`)
- Modify: `packages/application/src/engine/scheduler.ts` (stranded-note sweep)
- Modify: `packages/application/src/engine/remediation.ts` (fix and re-check tasks spread `...source`/`...template`; set `round: 1` on both so a fix never inherits a round number)
- Modify: `scratch/rounds-check.mjs` (section "impact")

**Interfaces consumed:** `FeedbackRepositoryPort`, `RunInputRepositoryPort`, `FeedbackItem`, `withdrawApproval` (`support/withdraw.ts`), `withoutEscalation` (`engine/staffing-resolver.ts`), `upstreamTaskIds` (`support/lineage.ts`), `versionLines` (`support/artifact-versions.ts`), `canTransition`.

**Interfaces produced:**

```ts
// support/downstream.ts (pure)
export interface ConsumerFacts {
  readonly tasks: readonly MissionTask[];
  /** Every run of the mission. */
  readonly runs: readonly Run[];
  readonly inputs: readonly { readonly runId: string; readonly artifactId: string }[];
  /** Every artifact of the mission, superseded versions included. */
  readonly artifacts: readonly ArtifactManifest[];
}
export interface Consumer {
  readonly task: MissionTask;
  /** The artifact of an upstream task its latest run used. */
  readonly used: ArtifactManifest;
  /** `record` from run_inputs; `inferred` only for a run from before migration 010. */
  readonly via: 'record' | 'inferred';
}
export function downstreamConsumers(source: MissionTask, facts: ConsumerFacts): readonly Consumer[];
export function reviewedTaskOf(review: MissionTask, tasks: readonly MissionTask[], artifacts: readonly ArtifactManifest[]): MissionTask | null;

// engine/feedback-rounds.ts
export const ROUND_START_STATUSES: readonly TaskStatus[] = ['SUCCEEDED', 'AWAITING_APPROVAL', 'FAILED', 'BLOCKED', 'CANCELLED', 'SKIPPED'];
/** A round's own attempt budget; see the plan's rulings. */
export const ROUND_ATTEMPTS = DEFAULT_RETRY_POLICY.maxAttempts;

export interface FeedbackRoundsDeps {
  readonly missions: MissionRepositoryPort;
  readonly tasks: TaskRepositoryPort;
  readonly runs: RunRepositoryPort;
  readonly artifacts: ArtifactRepositoryPort;
  readonly artifactStore: ArtifactStorePort;        // used from Task 4
  readonly approvals: ApprovalRepositoryPort;
  readonly evaluations: EvaluationRepositoryPort;   // used from Task 5
  readonly feedback: FeedbackRepositoryPort;
  readonly runInputs: RunInputRepositoryPort;
  readonly members: MemberRepositoryPort;
  readonly unitOfWork: UnitOfWork;
  readonly recorder: EventRecorder;
  readonly clock: Clock;
  /** Lazy: the scheduler depends on the executor, which depends on this. */
  readonly cancelTask: (taskId: TaskId) => void;
}

export interface RecordFeedbackInput {
  readonly task: MissionTask;
  readonly text: string;
  readonly artifactId: ArtifactId | null;
  readonly authorId: string;
  readonly recordedBy: string;
  readonly status: 'open' | 'queued';
  readonly round: number | null;
}
export interface DownstreamImpact {
  readonly task: MissionTask;
  readonly consumers: readonly Consumer[];
  /** Version number of each consumer's `used` artifact along its chain. */
  readonly usedVersion: ReadonlyMap<string, number>;
  readonly defaultChoice: 'redo' | 'keep';
}
export interface StartRoundInput {
  readonly task: MissionTask;
  readonly feedbackIds: readonly string[];
  /** `none` when nothing consumed the output (or the task never finished). */
  readonly downstream: 'redo' | 'keep' | 'none';
  /** Subset of the impact's consumers; all of them when omitted. */
  readonly redoTaskIds?: readonly string[];
  readonly actorId: string;
  /** A card being decided right now, which must not be withdrawn under its decision. */
  readonly keepCardId?: string;
}

export class FeedbackRounds {
  constructor(deps: FeedbackRoundsDeps);
  record(input: RecordFeedbackInput): FeedbackItem;
  impactOf(task: MissionTask): DownstreamImpact;
  /** Returns the reopened task. */
  startRound(input: StartRoundInput): MissionTask;
  /** A running pass that ended before it read a queued note leaves it stranded: it becomes open. Returns how many moved. */
  releaseStranded(): number;
}
```

- [ ] **Step 1: failing section.** In `scratch/rounds-check.mjs`, above the footer, add the harness and the section.

The harness: copy `engineHarness` verbatim from `scratch/handoff-check.mjs` lines 331–411, then change its `repo` object to also hold `feedback: container.resolve(app.FEEDBACK_REPOSITORY)`, `runInputs: container.resolve(app.RUN_INPUT_REPOSITORY)`, `evaluations: container.resolve(app.EVALUATION_REPOSITORY)`, and return `rounds: container.resolve(app.FEEDBACK_ROUNDS)` and `db: container.resolve(persistenceTokens.DATABASE)` too. Add shared fixture builders after it:

```js
/** Seed rows the engine would have written; ids and times are explicit so assertions can name them. */
function fixtures(h, ws, missionId) {
  const at = (m) => `2026-09-14T10:${String(m).padStart(2, '0')}:00.000Z`;
  const addTask = (key, status, extra = {}) => h.repo.tasks.add({
    id: extra.id ?? `tsk_${key}`, missionId, key, title: extra.title ?? key, objective: 'o', roleId: extra.roleId ?? 'design',
    dependsOn: extra.dependsOn ?? [], requiredCapabilities: [], inputArtifacts: extra.inputArtifacts ?? [], expectedOutputs: extra.expectedOutputs ?? ['DesignBrief'],
    executionPolicy: { isolation: 'none', maxWallTimeMs: 60000, capabilities: [] },
    approvalPolicy: { beforeStart: false, onCompletion: false }, retryPolicy: { maxAttempts: 2, backoffMs: 0, onExhausted: 'block' },
    completionGate: null, status, statusReason: null, attempts: extra.attempts ?? 1, remediatesTaskId: null, repositoryId: null,
    executor: extra.executor ?? 'agent', waitPolicy: null, orderHint: 0, staffingOverride: null, round: extra.round ?? 1,
    createdAt: at(0), updatedAt: at(1), startedAt: extra.startedAt === undefined ? at(1) : extra.startedAt, finishedAt: null,
  });
  const addArtifact = (task, type, extra = {}) => h.repo.artifacts.create({
    id: extra.id ?? `art_${task.key}_${extra.round ?? 1}`, workspaceId: ws, missionId, taskId: task.id, createdByRunId: null, type,
    title: extra.title ?? `${task.key} ${type}`, contentRef: 'c', mediaType: 'text/markdown', sha256: 'x', byteSize: 1, schemaVersion: 1,
    sourceRefs: [], supersedes: extra.supersedes ?? null, summary: null, createdAt: extra.createdAt ?? at(5),
    handoff: { headline: `${task.key} v${extra.round ?? 1}`, points: [], needs: null, changed: extra.changed ?? [], links: [] },
    wordCount: 10, overBudget: false, round: extra.round ?? 1,
  });
  const addRun = (task, extra = {}) => h.repo.runs.create({
    id: extra.id ?? `run_${task.key}_${extra.attempt ?? 1}`, missionId, taskId: task.id, assignmentId: 'wa_x', attempt: extra.attempt ?? 1,
    status: extra.status ?? 'SUCCEEDED', roleId: task.roleId, runtimeProfileId: 'rt_x', executionTargetId: 'tg_x', externalSessionId: null,
    pid: null, exitCode: 0, errorCode: null, errorMessage: null, usage: null, startedAt: extra.startedAt ?? at(20), finishedAt: null,
    heartbeatAt: null, agentMemberId: null, round: 'round' in extra ? extra.round : 1, purpose: 'round' in extra && extra.round === null ? null : 'round',
  });
  const addCard = (task, extra = {}) => h.repo.approvals.create({
    id: extra.id ?? `apr_${task.key}`, workspaceId: ws, missionId, taskId: task.id, runId: null, kind: extra.kind ?? 'action', status: 'PENDING', risk: 'read',
    title: `Approve the output of ${task.key}?`, rationale: 'r', effect: 'e', evidence: [{ kind: 'text', label: 'Review', value: '1/1' }],
    options: [{ id: 'approve', label: 'Approve' }, { id: 'request_changes', label: 'Request changes' }, { id: 'reject', label: 'Reject without changes' }],
    recommendedOptionId: 'approve', selectedOptionId: null, decidedBy: null, decisionNote: null, createdAt: at(30), decidedAt: null, expiresAt: null,
    addressees: [], escalationLevel: 0, escalateAt: null, recordedBy: 'system',
  });
  return { at, addTask, addArtifact, addRun, addCard };
}
```

The section:

```js
section('impact: consumers and round start');
{
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const keepAlive = setInterval(() => {}, 1000);
  const HOME = mkdtempSync(join(tmpdir(), 'tri-'));
  const h = await engineHarness(HOME, 'rounds-impact-check');
  const caller = { personId: h.services.identity.localPerson().id };
  const ws = (await h.services.workspaces.create(caller, { name: 'Impact' })).workspace.id;
  const owner = h.services.team.me(caller).memberships.find((m) => m.workspaceId === ws).memberId;
  const mission = await h.services.missions.create(caller, { workspaceId: ws, goal: 'Greet visitors', title: 'Impact' });
  h.repo.missions.update(mission.id, { status: 'EXECUTING' });
  const f = fixtures(h, ws, mission.id);
  const task = (id) => h.repo.tasks.get(id);
  h.db.handle.pragma('foreign_keys = OFF');   // runs point at assignments and targets this fixture does not create

  const design = f.addTask('design', 'SUCCEEDED');
  const dV1 = f.addArtifact(design, 'DesignBrief', { createdAt: f.at(5) });
  const build = f.addTask('build', 'SUCCEEDED', { dependsOn: ['design'], roleId: 'development', expectedOutputs: ['ChangeSet'], inputArtifacts: [{ type: 'DesignBrief', required: true }] });
  const rBuild = f.addRun(build);
  h.repo.runInputs.record(rBuild.id, [dV1.id]);
  const change = f.addArtifact(build, 'ChangeSet', { createdAt: f.at(25) });
  const review = f.addTask('review', 'RUNNING', { dependsOn: ['build'], roleId: 'review', expectedOutputs: ['ReviewReport'] });
  const rReview = f.addRun(review, { status: 'RUNNING', startedAt: f.at(26) });
  h.repo.runInputs.record(rReview.id, [change.id]);
  const docs = f.addTask('docs', 'SUCCEEDED', { dependsOn: ['design'], roleId: 'product', expectedOutputs: ['ProductSpec'], inputArtifacts: [{ type: 'DesignBrief', required: true }] });
  f.addRun(docs, { round: null, startedAt: f.at(21) });           // a run from before migration 010
  const later = f.addTask('later', 'READY', { dependsOn: ['design'], startedAt: null });
  const sibling = f.addTask('sibling', 'SUCCEEDED');
  f.addRun(sibling);
  f.addCard(build);

  const impact = h.rounds.impactOf(task(design.id));
  const byKey = Object.fromEntries(impact.consumers.map((c) => [c.task.key, c]));
  check('build consumed design, from its recorded inputs', byKey.build?.via === 'record' && byKey.build.used.id === dV1.id, impact.consumers.map((c) => [c.task.key, c.via]));
  check('review consumed build, so it is a transitive consumer of design', byKey.review?.via === 'record');
  check('a pre-010 run is inferred from its input types and start time', byKey.docs?.via === 'inferred');
  check('a task that has not run and an unrelated task are not consumers', byKey.later === undefined && byKey.sibling === undefined);
  check('the default is redo because review is still running', impact.defaultChoice === 'redo');
  check('the used version is numbered along the chain', impact.usedVersion.get(build.id) === 1);

  const cancelled = [];
  const cancelOriginal = h.scheduler.cancelTask.bind(h.scheduler);
  h.scheduler.cancelTask = (id) => { cancelled.push(id); cancelOriginal(id); };

  // Keep: dependents stay; a READY task that never ran is held back.
  const k = h.rounds.record({ task: task(design.id), text: 'Shorter intro', artifactId: null, authorId: owner, recordedBy: owner, status: 'open', round: null });
  check('record writes an open item and a feedback.given event', h.repo.feedback.get(k.id)?.status === 'open'
    && h.repo.events.listByMission(mission.id).some((e) => e.body.type === 'feedback.given' && e.body.feedbackId === k.id));
  h.rounds.startRound({ task: task(design.id), feedbackIds: [k.id], downstream: 'keep', actorId: owner });
  check('keep: design is READY as round 2', task(design.id).status === 'READY' && task(design.id).round === 2 && task(design.id).retryFeedback === null, task(design.id));
  check('keep: the item is in round 2', h.repo.feedback.get(k.id).status === 'in_round' && h.repo.feedback.get(k.id).round === 2);
  check('keep: build and review are untouched', task(build.id).status === 'SUCCEEDED' && task(review.id).status === 'RUNNING' && cancelled.length === 0);
  check('keep: a dependent that never ran waits again', task(later.id).status === 'PENDING', task(later.id).status);
  check('keep: the round budget is extended past the attempts spent', task(design.id).retryPolicy.maxAttempts === task(design.id).attempts + 2);
  const started = h.repo.events.listByMission(mission.id).filter((e) => e.body.type === 'task.round_started');
  check('task.round_started names the round, the items and the choice', started.length === 1 && started[0].body.round === 2 && eq(started[0].body.feedbackIds, [k.id]) && started[0].body.downstream === 'keep', started.map((e) => e.body));

  // Redo: running dependents are cancelled, finished ones reset, their cards withdrawn.
  h.repo.tasks.update(design.id, { status: 'SUCCEEDED' });
  const r = h.rounds.record({ task: task(design.id), text: 'Bigger buttons', artifactId: null, authorId: owner, recordedBy: owner, status: 'open', round: null });
  check('redo with a task that did not consume is refused', await code(() => h.rounds.startRound({ task: task(design.id), feedbackIds: [r.id], downstream: 'redo', redoTaskIds: [sibling.id], actorId: owner })) === 'VALIDATION');
  h.rounds.startRound({ task: task(design.id), feedbackIds: [r.id], downstream: 'redo', redoTaskIds: [build.id, review.id], actorId: owner });
  check('redo: build and review are PENDING with the spec reason',
    task(build.id).status === 'PENDING' && task(build.id).statusReason === 'Redone after design round 3' && task(review.id).status === 'PENDING', [task(build.id).statusReason, task(review.id).status]);
  check('redo: the running review was cancelled', eq(cancelled, [review.id]), cancelled);
  check("redo: build's review card is withdrawn", h.repo.approvals.get('apr_build').status === 'CANCELLED');
  check('redo: docs, not selected, is untouched', task(docs.id).status === 'SUCCEEDED');

  // Guards.
  const s = h.rounds.record({ task: task(sibling.id), text: 'x', artifactId: null, authorId: owner, recordedBy: owner, status: 'open', round: null });
  h.repo.tasks.update(sibling.id, { status: 'RUNNING' });
  check('a RUNNING task cannot start a round', await code(() => h.rounds.startRound({ task: task(sibling.id), feedbackIds: [s.id], downstream: 'none', actorId: owner })) === 'PRECONDITION_FAILED');
  h.repo.tasks.update(sibling.id, { status: 'SUCCEEDED' });
  check('an item that is not open on the task is refused', await code(() => h.rounds.startRound({ task: task(sibling.id), feedbackIds: [k.id], downstream: 'none', actorId: owner })) === 'VALIDATION');

  // Stranded notes.
  const q1 = h.rounds.record({ task: task(sibling.id), text: 'late note', artifactId: null, authorId: owner, recordedBy: owner, status: 'queued', round: 1 });
  h.repo.tasks.update(review.id, { status: 'RUNNING' });
  const q2 = h.rounds.record({ task: task(review.id), text: 'while running', artifactId: null, authorId: owner, recordedBy: owner, status: 'queued', round: 1 });
  check('releaseStranded moves a queued note on a settled task to open, and leaves a running one', h.rounds.releaseStranded() === 1
    && h.repo.feedback.get(q1.id).status === 'open' && h.repo.feedback.get(q1.id).round === null && h.repo.feedback.get(q2.id).status === 'queued');

  h.scheduler.cancelTask = cancelOriginal;
  await h.container.dispose();
  clearInterval(keepAlive);
}
```

- [ ] **Step 2:** `npm run build && node scratch/rounds-check.mjs` fails (no `FEEDBACK_ROUNDS`).

- [ ] **Step 3: implement.** Pure consumers:

```ts
// support/downstream.ts
const NOT_STARTED: readonly TaskStatus[] = ['PENDING', 'READY', 'SKIPPED', 'CANCELLED'];

/**
 * The tasks whose latest run used an artifact of `source`, and, transitively,
 * the tasks that used theirs (spec §3).
 *
 * Read from `run_inputs`, which the executor writes when a run starts. A run
 * from before migration 010 has no record; its `round` is NULL, and only then
 * is consumption inferred: a dependent that declared the artifact's type as an
 * input and started after that artifact existed. A task that has not started
 * has consumed nothing and is left out, whatever the graph says.
 */
export function downstreamConsumers(source: MissionTask, facts: ConsumerFacts): readonly Consumer[] {
  const latestRun = new Map<string, Run>();
  for (const run of facts.runs) {
    const known = latestRun.get(run.taskId);
    if (known === undefined || run.startedAt > known.startedAt) latestRun.set(run.taskId, run);
  }
  const inputsByRun = new Map<string, Set<string>>();
  for (const { runId, artifactId } of facts.inputs) {
    const set = inputsByRun.get(runId) ?? new Set<string>();
    set.add(artifactId);
    inputsByRun.set(runId, set);
  }
  const outputsOf = new Map<string, ArtifactManifest[]>();
  for (const a of facts.artifacts) {
    if (a.taskId === null) continue;
    outputsOf.set(a.taskId, [...(outputsOf.get(a.taskId) ?? []), a]);
  }

  const found = new Map<string, Consumer>();
  const seen = new Set<string>([source.id]);
  const frontier: MissionTask[] = [source];
  while (frontier.length > 0) {
    const upstream = frontier.shift()!;
    const outputs = outputsOf.get(upstream.id) ?? [];
    if (outputs.length === 0) continue;
    for (const candidate of facts.tasks) {
      if (seen.has(candidate.id) || NOT_STARTED.includes(candidate.status)) continue;
      const run = latestRun.get(candidate.id);
      if (run === undefined) continue;
      const recorded = inputsByRun.get(run.id);
      let used: ArtifactManifest | undefined;
      let via: Consumer['via'] = 'record';
      if (recorded !== undefined) {
        used = outputs.find((a) => recorded.has(a.id));
      } else if ((run.round ?? null) === null && upstreamTaskIds(candidate, facts.tasks).has(upstream.id)) {
        via = 'inferred';
        used = outputs
          .filter((a) => candidate.inputArtifacts.some((r) => r.type === a.type) && a.createdAt <= run.startedAt)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      }
      if (used === undefined) continue;
      seen.add(candidate.id);
      found.set(candidate.id, { task: candidate, used, via });
      frontier.push(candidate);
    }
  }
  return [...found.values()];
}

/**
 * The task a review task reviewed: its one direct dependency with a live
 * ChangeSet, else its one direct dependency with any live output. Null when
 * that is ambiguous, and the findings then keep today's fix-task flow.
 */
export function reviewedTaskOf(review: MissionTask, tasks: readonly MissionTask[], artifacts: readonly ArtifactManifest[]): MissionTask | null {
  const superseded = new Set(artifacts.map((a) => a.supersedes).filter((id): id is ArtifactId => id !== null));
  const liveTypes = (t: MissionTask) => artifacts.filter((a) => a.taskId === t.id && !superseded.has(a.id)).map((a) => a.type);
  const direct = review.dependsOn.map((key) => tasks.find((t) => t.key === key)).filter((t): t is MissionTask => t !== undefined);
  const changes = direct.filter((t) => liveTypes(t).includes('ChangeSet'));
  if (changes.length > 0) return changes.length === 1 ? changes[0]! : null;
  const producing = direct.filter((t) => liveTypes(t).length > 0);
  return producing.length === 1 ? producing[0]! : null;
}
```

The engine core:

```ts
// engine/feedback-rounds.ts (Task 2 part)
export class FeedbackRounds {
  constructor(private readonly deps: FeedbackRoundsDeps) {}

  record(input: RecordFeedbackInput): FeedbackItem {
    const { deps } = this;
    const now = deps.clock.now();
    const item = deps.feedback.create({
      id: ids.feedback(), taskId: input.task.id, artifactId: input.artifactId, authorId: input.authorId,
      recordedBy: input.recordedBy, text: input.text.trim(), attachments: [], status: input.status, round: input.round,
      createdAt: now, updatedAt: now,
    });
    deps.recorder.record(this.#scope(input.task, input.authorId), {
      type: 'feedback.given', feedbackId: item.id, status: item.status, excerpt: summarize(item.text, 140),
    });
    deps.recorder.invalidate('tasks', input.task.missionId);
    return item;
  }

  impactOf(task: MissionTask): DownstreamImpact {
    const { deps } = this;
    const artifacts = deps.artifacts.listByMission(task.missionId);
    const consumers = downstreamConsumers(task, {
      tasks: deps.tasks.listByMission(task.missionId),
      runs: deps.runs.listByMission(task.missionId),
      inputs: deps.runInputs.listByMission(task.missionId),
      artifacts,
    });
    const lines = versionLines(artifacts);
    return {
      task,
      consumers,
      usedVersion: new Map(consumers.map((c) => [c.task.id as string, lines.get(c.used.id)?.version ?? 1])),
      // Work still running on the old version is wasted if kept; finished work is the person's call.
      defaultChoice: consumers.some((c) => c.task.status === 'RUNNING' || c.task.status === 'AWAITING_INPUT') ? 'redo' : 'keep',
    };
  }

  startRound(input: StartRoundInput): MissionTask {
    const { deps } = this;
    const task = deps.tasks.get(input.task.id) ?? input.task;
    if (!ROUND_START_STATUSES.includes(task.status)) {
      throw new TandemiseError('PRECONDITION_FAILED', `A task in ${task.status} cannot start a round.`, { details: { taskId: task.id, status: task.status } });
    }
    const mission = deps.missions.get(task.missionId);
    if (mission === undefined) throw TandemiseError.notFound('Mission', task.missionId);
    const items = deps.feedback.listByTask(task.id);
    for (const id of input.feedbackIds) {
      if (!items.some((i) => i.id === id && i.status === 'open')) {
        throw TandemiseError.validation(`Feedback '${id}' is not open on '${task.key}'.`, { feedbackId: id, taskId: task.id });
      }
    }
    const redone = input.downstream === 'redo' ? this.#redoSet(task, input.redoTaskIds) : [];
    // Several items given before a round starts all go into that round (spec §2).
    const joining = items.filter((i) => i.status === 'open');
    const round = (task.round ?? 1) + 1;
    const authors = [...new Set(joining.map((i) => this.#name(i.authorId)))];
    const reason = `Round ${round}: ${authors.join(', ')} asked for changes.`;
    const scope = this.#scope(task, input.actorId);

    deps.unitOfWork.transaction(() => {
      for (const item of joining) deps.feedback.update(item.id, { status: 'in_round', round });
      deps.tasks.update(task.id, {
        round, status: 'READY', statusReason: reason, needsAttention: false, finishedAt: null,
        // The request is the brief now; a stale gate measurement would frame it as a failure.
        retryFeedback: null,
        retryPolicy: { ...task.retryPolicy, maxAttempts: task.attempts + ROUND_ATTEMPTS },
        ...(task.staffing?.escalatedTo === undefined ? {} : { staffing: withoutEscalation(task.staffing) }),
      });
    });
    for (const card of deps.approvals.pendingForTask(task.id)) {
      if (card.id !== input.keepCardId) withdrawApproval(deps, card, `Superseded by round ${round} of '${task.key}'.`);
    }
    deps.recorder.record(scope, { type: 'task.status', from: task.status, to: 'READY', reason });
    deps.recorder.record(scope, {
      type: 'task.round_started', round, feedbackIds: joining.map((i) => i.id), downstream: input.downstream, redone: redone.map((t) => t.key),
    });
    for (const dependent of redone) this.#redo(dependent, task, round);
    this.#holdUnstarted(task);
    this.#revive(mission, `'${task.key}' started round ${round}.`);
    deps.recorder.invalidate('tasks', mission.id);
    deps.recorder.invalidate('approvals', mission.id);
    return deps.tasks.get(task.id)!;
  }

  releaseStranded(): number {
    let moved = 0;
    for (const item of this.deps.feedback.listByStatus(['queued'])) {
      const task = this.deps.tasks.get(item.taskId);
      if (task !== undefined && (task.status === 'RUNNING' || task.status === 'AWAITING_INPUT')) continue;
      this.deps.feedback.update(item.id, { status: 'open', round: null });
      if (task !== undefined) this.deps.recorder.invalidate('tasks', task.missionId);
      moved++;
    }
    return moved;
  }

  #redoSet(task: MissionTask, ids: readonly string[] | undefined): readonly MissionTask[] {
    const consumers = this.impactOf(task).consumers.map((c) => c.task);
    if (ids === undefined) return consumers;
    for (const id of ids) {
      if (!consumers.some((c) => c.id === id)) throw TandemiseError.validation(`Task '${id}' did not use the output of '${task.key}'.`, { taskId: id });
    }
    return consumers.filter((c) => ids.includes(c.id));
  }

  /** Spec §3 Redo: stop it if it runs, send it back to PENDING, withdraw its cards; staffing resolves again at READY. */
  #redo(dependent: MissionTask, source: MissionTask, round: number): void {
    const { deps } = this;
    const current = deps.tasks.get(dependent.id) ?? dependent;
    if (current.status === 'RUNNING' || current.status === 'AWAITING_INPUT') deps.cancelTask(current.id);
    const reason = `Redone after ${source.key} round ${round}`;
    deps.tasks.update(current.id, {
      status: 'PENDING', statusReason: reason, finishedAt: null, needsAttention: false, retryFeedback: null,
      retryPolicy: { ...current.retryPolicy, maxAttempts: current.attempts + ROUND_ATTEMPTS },
    });
    for (const card of deps.approvals.pendingForTask(current.id)) withdrawApproval(deps, card, reason);
    deps.recorder.record(this.#scope(current, SYSTEM_ACTOR), { type: 'task.status', from: current.status, to: 'PENDING', reason });
  }

  /**
   * A dependent that became READY but never ran has consumed nothing, so it
   * is not in the dialog; left READY it would start on the old version.
   */
  #holdUnstarted(task: MissionTask): void {
    const all = this.deps.tasks.listByMission(task.missionId);
    for (const t of all) {
      if (t.status !== 'READY' || t.startedAt !== null || !upstreamTaskIds(t, all).has(task.id)) continue;
      const reason = `Waiting for round ${(task.round ?? 1) + 1} of '${task.key}'.`;
      this.deps.tasks.update(t.id, { status: 'PENDING', statusReason: reason });
      this.deps.recorder.record(this.#scope(t, SYSTEM_ACTOR), { type: 'task.status', from: 'READY', to: 'PENDING', reason });
    }
  }

  #revive(mission: Mission, reason: string): void {
    if (mission.status !== 'BLOCKED' && mission.status !== 'COMPLETE' && mission.status !== 'FAILED') return;
    if (!canTransition(mission.status, 'EXECUTING')) return;
    this.deps.missions.update(mission.id, { status: 'EXECUTING', statusReason: reason });
    this.deps.recorder.record({ workspaceId: mission.workspaceId, missionId: mission.id }, { type: 'mission.status', from: mission.status, to: 'EXECUTING', reason });
    this.deps.recorder.invalidate('missions', mission.id);
  }

  #name(memberId: string): string {
    if (memberId === RUNTIME_ACTOR) return 'Runtime';
    return this.deps.members.get(asId<'MemberId'>(memberId))?.name ?? 'Someone';
  }

  #scope(task: MissionTask, actorId: string): EventScope {
    const mission = this.deps.missions.get(task.missionId)!;
    return { workspaceId: mission.workspaceId, missionId: mission.id, taskId: task.id, roleId: task.roleId, actorId };
  }
}
```

Wiring (`module.ts`):

```ts
bind(t.FEEDBACK_ROUNDS, (r) => new FeedbackRounds({
  missions: r.resolve(t.MISSION_REPOSITORY), tasks: r.resolve(t.TASK_REPOSITORY), runs: r.resolve(t.RUN_REPOSITORY),
  artifacts: r.resolve(t.ARTIFACT_REPOSITORY), artifactStore: r.resolve(t.ARTIFACT_STORE), approvals: r.resolve(t.APPROVAL_REPOSITORY),
  evaluations: r.resolve(t.EVALUATION_REPOSITORY), feedback: r.resolve(t.FEEDBACK_REPOSITORY), runInputs: r.resolve(t.RUN_INPUT_REPOSITORY),
  members: r.resolve(t.MEMBER_REPOSITORY), unitOfWork: r.resolve(t.UNIT_OF_WORK), recorder: r.resolve(t.EVENT_RECORDER), clock: clock(r),
  cancelTask: (taskId) => r.resolve(t.SCHEDULER).cancelTask(taskId),
}), { source: SOURCE });
```

Scheduler: add `readonly rounds: FeedbackRounds` to `SchedulerDeps`, bind it, and call a sweep first in `#pass`:

```ts
/** A note that arrived as a pass was settling is not lost: it waits as an open note on the card. */
#sweepStrandedFeedback(): void {
  try {
    this.deps.rounds.releaseStranded();
  } catch (e) {
    this.deps.log.warn('scheduler.feedback_sweep_failed', { error: errorMessage(e) });
  }
}
```

- [ ] **Step 4:** `npm run build && node scratch/rounds-check.mjs && npm run check:boundaries && node scripts/run-checks.mjs`.
- [ ] **Step 5:** commit `feat(engine): downstream impact from run inputs, and rounds that redo or keep dependents`.

### Task 3: Feedback service, API and views

**Files:**
- Create: `packages/application/src/support/feedback-rules.ts` (the `feedbackEffectFor` part; Task 4 adds the prompt parts), `packages/application/src/services/feedback-service.ts`
- Modify: `packages/api-contract/src/requests.ts`, `views.ts`
- Modify: `packages/application/src/services.ts` (`FeedbackService`, `TandemiseServices.feedback`), `tokens.ts` (`FEEDBACK_SERVICE`), `module.ts`, `index.ts`
- Modify: `packages/application/src/services/mission-service.ts` (retry with a note is a round)
- Modify: `packages/application/src/services/projection-service.ts` (`TaskView`, `FeedCard`), `artifact-service.ts` (`ArtifactReadView`); `support/feedback-view.ts` (create) for the shared resolution
- Modify: `apps/daemon/src/routes.ts`
- Modify: `scratch/handoff-check.mjs:883` (the one-pass feed check builds `ProjectionServiceImpl` by hand: add `feedback: r(t.FEEDBACK_REPOSITORY)` to `deps`, so it is counted too)
- Modify: `scratch/rounds-check.mjs` (sections "service" and "api")

**Interfaces consumed:** `FeedbackRounds.record`, `.impactOf`, `.startRound`, `ROUND_START_STATUSES` (Task 2); `actorFor`, `requireSeat` (`support/identity.ts`); `isOutputApproval` (`support/approval-view.ts`); `REQUEST_CHANGES_OPTION`, `citedFeedbackIds`, `isDeclinedChange` (Task 1).

**Interfaces produced:**

```ts
// api-contract/requests.ts
export const giveFeedbackRequest = z.object({
  text: z.string().trim().min(1).max(4000),
  /** Feedback about one output of the task; omitted for the whole task. */
  artifactId: z.string().min(1).optional(),
  onBehalfOf,
});
export type GiveFeedbackRequest = z.infer<typeof giveFeedbackRequest>;
export const startRoundRequest = z.object({
  feedbackIds: z.array(z.string().min(1)).min(1).max(50),
  downstream: z.enum(['redo', 'keep']),
  redoTaskIds: z.array(z.string().min(1)).max(200).optional(),
  onBehalfOf,
});
export type StartRoundRequest = z.infer<typeof startRoundRequest>;
export const dismissFeedbackRequest = z.object({ onBehalfOf });
// retryTaskRequest.note: max(2000) → z.string().max(4000), since the note becomes a feedback item.

// api-contract/views.ts
export interface FeedbackView {
  readonly id: string;
  readonly taskId: string;
  readonly artifactId: string | null;
  readonly author: ActorRef | null;
  /** Only when it differs from `author`. */
  readonly recordedBy: ActorRef | null;
  readonly text: string;
  readonly status: FeedbackStatus;
  readonly round: number | null;
  readonly createdAt: string;
}
/** One `handoff.changed` entry with the notes it answers resolved. */
export interface FeedChange {
  readonly what: string;
  readonly declined: boolean;
  /** Unknown ids are dropped: a card never shows a raw id. */
  readonly feedback: readonly Pick<FeedbackView, 'id' | 'text' | 'author' | 'status'>[];
}
export interface DownstreamImpactView {
  readonly taskId: string;
  readonly taskKey: string;
  readonly taskTitle: string;
  readonly nextRound: number;
  /** The open items the confirmed round will carry. */
  readonly feedbackIds: readonly string[];
  readonly dependents: readonly {
    readonly taskId: string; readonly key: string; readonly title: string; readonly status: TaskStatus;
    readonly usedVersion: number; readonly running: boolean;
  }[];
  readonly defaultChoice: 'redo' | 'keep';
}
export interface FeedbackGivenView {
  readonly feedback: FeedbackView;
  /** Set when the task finished and its output was used: the round waits for `POST /v1/tasks/:id/rounds`. */
  readonly impact: DownstreamImpactView | null;
  /** The round that started because of this item, when one did. */
  readonly roundStarted: number | null;
}
export interface TaskFeedbackView {
  readonly taskId: string;
  readonly round: number;
  readonly items: readonly FeedbackView[];
  /** Non-null while open items wait for a round the task can start; `dependents` may be empty. */
  readonly pendingImpact: DownstreamImpactView | null;
}
// FeedCard gains:
//   readonly round: number;
//   readonly openFeedback: readonly FeedbackView[];   // open and queued; the card shows the count and the latest
//   readonly changed: readonly FeedChange[];           // the primary artifact's handoff.changed, resolved
//   readonly canRequestChanges: boolean;               // a task (not the plan, not a wait step) that has run or has output
// TaskView gains: readonly round: number; readonly feedback: readonly FeedbackView[];
// ArtifactReadView gains:
//   readonly round: number | null;
//   readonly versions: readonly { readonly artifactId: string; readonly version: number; readonly round: number | null; readonly createdAt: string }[];
//   readonly changes: readonly FeedChange[];

// application/services.ts
export interface FeedbackService {
  /** Spec §2's table decides what happens; see `feedbackEffectFor`. */
  give(caller: Caller, taskId: TaskId, request: GiveFeedbackRequest, options?: { readonly forceDownstream?: 'keep' }): FeedbackGivenView;
  startRound(caller: Caller, taskId: TaskId, request: StartRoundRequest): TaskView;
  list(taskId: TaskId): TaskFeedbackView;
  dismiss(caller: Caller, id: FeedbackId, request: { onBehalfOf?: string }): FeedbackView;
}

// support/feedback-rules.ts
export type FeedbackEffect =
  | { readonly kind: 'queue' }            // RUNNING, AWAITING_INPUT
  | { readonly kind: 'attach' }           // PENDING, READY, AWAITING_HUMAN, AWAITING_APPROVAL on a start card
  | { readonly kind: 'review'; readonly card: Approval }   // AWAITING_APPROVAL with an output card
  | { readonly kind: 'reopen' }           // SUCCEEDED: impact first
  | { readonly kind: 'round_now' };       // FAILED, BLOCKED, CANCELLED, SKIPPED
export function feedbackEffectFor(task: MissionTask, pending: readonly Approval[], runs: Pick<RunRepositoryPort, 'listByTask'>): FeedbackEffect;
```

Routes:

```ts
r.post('/v1/tasks/:id/feedback', async (ctx) => services.feedback.give(ctx.caller, asId(ctx.params.id!), await ctx.body(giveFeedbackRequest)));
r.get('/v1/tasks/:id/feedback', (ctx) => services.feedback.list(asId(ctx.params.id!)));
r.post('/v1/tasks/:id/rounds', async (ctx) => services.feedback.startRound(ctx.caller, asId(ctx.params.id!), await ctx.body(startRoundRequest)));
r.post('/v1/feedback/:id/dismiss', async (ctx) => services.feedback.dismiss(ctx.caller, asId(ctx.params.id!), await ctx.body(dismissFeedbackRequest)));
```

- [ ] **Step 1: failing sections.** Add above the footer:

```js
section('service: feedback by task state');
{
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const keepAlive = setInterval(() => {}, 1000);
  const HOME = mkdtempSync(join(tmpdir(), 'trs-'));
  const h = await engineHarness(HOME, 'rounds-service-check');
  const caller = { personId: h.services.identity.localPerson().id };
  const ws = (await h.services.workspaces.create(caller, { name: 'Service' })).workspace.id;
  const owner = h.services.team.me(caller).memberships.find((m) => m.workspaceId === ws).memberId;
  const ana = h.services.team.addMember(caller, ws, { kind: 'person', personId: h.services.team.createPerson(caller, { displayName: 'Ana Ruiz' }).id, reportsTo: owner }).id;
  const mission = await h.services.missions.create(caller, { workspaceId: ws, goal: 'Greet visitors', title: 'Service' });
  h.repo.missions.update(mission.id, { status: 'EXECUTING' });
  const f = fixtures(h, ws, mission.id);
  const task = (id) => h.repo.tasks.get(id);
  const give = (t, text, extra = {}) => h.services.feedback.give(caller, t.id, { text, ...extra });
  h.db.handle.pragma('foreign_keys = OFF');

  const running = f.addTask('running', 'RUNNING');
  const g1 = give(running, 'Use the brand palette');
  check('RUNNING: the item is queued and nothing reopens', g1.feedback.status === 'queued' && g1.roundStarted === null && task(running.id).status === 'RUNNING', g1);

  const person = f.addTask('person', 'AWAITING_HUMAN', { executor: 'human' });
  const g2 = give(person, 'Mention the pricing page');
  check('AWAITING_HUMAN: the item is attached to round 1', g2.feedback.status === 'open' && g2.feedback.round === 1 && task(person.id).status === 'AWAITING_HUMAN');
  const pending = f.addTask('pending', 'PENDING', { startedAt: null, attempts: 0 });
  check('PENDING: the item is attached to round 1', give(pending, 'Keep it short').feedback.round === 1 && task(pending.id).status === 'PENDING');

  const reviewed = f.addTask('reviewed', 'AWAITING_APPROVAL');
  f.addRun(reviewed, { startedAt: f.at(20) });
  f.addCard(reviewed);
  const g3 = give(reviewed, 'Bigger touch targets', { onBehalfOf: ana });
  const card = h.repo.approvals.get('apr_reviewed');
  check('AWAITING_APPROVAL: the review card is decided Request changes with the note',
    card.status === 'REJECTED' && card.selectedOptionId === 'request_changes' && card.decisionNote === 'Bigger touch targets' && card.decidedBy === ana && card.recordedBy === owner, card);
  check('AWAITING_APPROVAL: the same task starts round 2 and no _revision_ task exists',
    g3.roundStarted === 2 && task(reviewed.id).status === 'READY' && !h.repo.tasks.listByMission(mission.id).some((t) => t.key.includes('_revision_')));
  check('onBehalfOf: authored by Ana, recorded by me', g3.feedback.author?.id === ana && g3.feedback.recordedBy?.id === owner, g3.feedback);

  const lone = f.addTask('lone', 'SUCCEEDED');
  f.addArtifact(lone, 'DesignBrief');
  const g4 = give(lone, 'Shorter intro');
  check('SUCCEEDED with no consumers: round 2 starts at once', g4.impact === null && g4.roundStarted === 2 && task(lone.id).round === 2);

  const design = f.addTask('design', 'SUCCEEDED');
  const dV1 = f.addArtifact(design, 'DesignBrief');
  const build = f.addTask('build', 'SUCCEEDED', { dependsOn: ['design'], expectedOutputs: ['ChangeSet'] });
  h.repo.runInputs.record(f.addRun(build).id, [dV1.id]);
  const g5 = give(design, 'Darker header');
  check('SUCCEEDED with a consumer: the item waits and the impact lists build at v1',
    g5.roundStarted === null && g5.feedback.status === 'open' && g5.impact?.dependents.length === 1 && g5.impact.dependents[0].key === 'build' && g5.impact.dependents[0].usedVersion === 1 && g5.impact.defaultChoice === 'keep', g5.impact);
  check('list reports the pending impact', h.services.feedback.list(design.id).pendingImpact?.feedbackIds.includes(g5.feedback.id));
  h.services.feedback.startRound(caller, design.id, { feedbackIds: [g5.feedback.id], downstream: 'keep' });
  check('startRound keep: design is round 2, build untouched', task(design.id).round === 2 && task(build.id).status === 'SUCCEEDED');

  const blocked = f.addTask('blocked', 'BLOCKED');
  h.repo.tasks.update(blocked.id, { retryFeedback: 'Missing expected artifacts: DesignBrief.' });
  const g6 = give(blocked, 'Write the brief even if it is short');
  check('BLOCKED: the next attempt is a round with the gate feedback cleared', g6.roundStarted === 2 && task(blocked.id).status === 'READY' && task(blocked.id).retryFeedback === null);

  const retried = f.addTask('retried', 'FAILED');
  await h.services.missions.retryTask(caller, retried.id, { note: 'Use the brand palette' });
  const items = h.repo.feedback.listByTask(retried.id);
  check('retry with a note stores the note as feedback and starts a round', items.length === 1 && items[0].text === 'Use the brand palette' && items[0].status === 'in_round' && task(retried.id).round === 2);
  const plain = f.addTask('plain', 'FAILED');
  h.repo.tasks.update(plain.id, { retryFeedback: 'gate' });
  await h.services.missions.retryTask(caller, plain.id, {});
  check('retry without a note keeps today\'s behaviour', task(plain.id).round === 1 && task(plain.id).retryFeedback === 'gate' && h.repo.feedback.listByTask(plain.id).length === 0);

  const wait = f.addTask('wait', 'AWAITING_EXTERNAL', { executor: 'wait' });
  check('a wait step refuses feedback', await code(() => give(wait, 'x')) === 'PRECONDITION_FAILED');
  const other = f.addTask('other', 'SUCCEEDED');
  check('an artifact of another task is refused', await code(() => give(other, 'x', { artifactId: dV1.id })) === 'VALIDATION');
  check('dismissing an open item works', h.services.feedback.dismiss(caller, g2.feedback.id, {}).status === 'dismissed');
  check('dismissing an item already in a round is a conflict', await code(() => h.services.feedback.dismiss(caller, g6.feedback.id, {})) === 'CONFLICT');
  check('a dismissal is on the timeline', h.repo.events.listByMission(mission.id).some((e) => e.body.type === 'feedback.dismissed' && e.body.feedbackId === g2.feedback.id));

  const view = await h.services.projections.taskView(design.id);
  check('TaskView carries round and the feedback thread', view.round === 2 && view.feedback.some((i) => i.id === g5.feedback.id && i.status === 'in_round'));
  await h.container.dispose();
  clearInterval(keepAlive);
}

section('api: routes and views (http)');
{
  const { mkdtempSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const HOME = mkdtempSync(join(tmpdir(), 'tra-'));
  const h = await engineHarness(HOME, 'rounds-api-seed');
  const caller = { personId: h.services.identity.localPerson().id };
  const ws = (await h.services.workspaces.create(caller, { name: 'Api' })).workspace.id;
  const owner = h.services.team.me(caller).memberships.find((m) => m.workspaceId === ws).memberId;
  const mission = await h.services.missions.create(caller, { workspaceId: ws, goal: 'Greet visitors', title: 'Api' });
  // Paused, so the daemon's scheduler leaves READY tasks alone while the check reads them.
  h.repo.missions.update(mission.id, { status: 'PAUSED' });
  const f = fixtures(h, ws, mission.id);
  h.db.handle.pragma('foreign_keys = OFF');
  const doc = f.addTask('doc', 'SUCCEEDED', { round: 2 });
  const v1 = f.addArtifact(doc, 'DesignBrief', { round: 1, createdAt: f.at(5) });
  const note = h.rounds.record({ task: doc, text: 'Shorter intro', artifactId: null, authorId: owner, recordedBy: owner, status: 'open', round: null });
  h.repo.feedback.update(note.id, { status: 'addressed', round: 2 });
  const v2 = f.addArtifact(doc, 'DesignBrief', { round: 2, supersedes: v1.id, createdAt: f.at(9), changed: [{ what: 'Cut the intro to two lines', feedback: `${note.id}, fb_zzzzzzzzzzzzzzzzzzzz` }, { what: 'Declined: keep the logo', feedback: note.id }] });
  await h.container.dispose();

  const { startDaemon } = await import('../apps/daemon/dist/main.js');
  const daemon = await startDaemon({ home: HOME, logLevel: 'error', tickIntervalMs: 200 });
  const token = JSON.parse(readFileSync(join(HOME, 'daemon.json'), 'utf8')).token;
  const api = async (method, path, body) => {
    const res = await fetch(`${daemon.url}${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const tooLong = await api('POST', `/v1/tasks/${doc.id}/feedback`, { text: 'x'.repeat(4001) });
  check('POST feedback over 4000 characters is a 400', tooLong.status === 400, tooLong);
  const blank = await api('POST', `/v1/tasks/${doc.id}/feedback`, { text: '   ' });
  check('POST feedback that is only whitespace is a 400', blank.status === 400);
  const given = await api('POST', `/v1/tasks/${doc.id}/feedback`, { text: 'Add a subtitle' });
  check('POST feedback returns the item and the started round', given.status === 200 && given.body.feedback.text === 'Add a subtitle' && given.body.roundStarted === 3, given.body);
  const list = await api('GET', `/v1/tasks/${doc.id}/feedback`);
  check('GET feedback lists the thread with the task round', list.body.round === 3 && list.body.items.length === 2, list.body);
  const feed = await api('GET', `/v1/missions/${mission.id}/feed`);
  const card = [...feed.body.inProgress, ...feed.body.done, ...feed.body.needsYou].find((c) => c.key === 'doc');
  check('FeedCard carries round, canRequestChanges and resolved changes',
    card?.round === 3 && card.canRequestChanges === true && card.changed.length === 2 && card.changed[0].feedback.length === 1 && card.changed[0].feedback[0].text === 'Shorter intro' && card.changed[1].declined === true, card);
  const read = await api('GET', `/v1/artifacts/${v2.id}`);
  check('the read view lists both versions and the changes linked to their notes',
    eq(read.body.versions.map((v) => v.version), [1, 2]) && read.body.round === 2 && read.body.changes[0].feedback[0].author?.id === owner, read.body);
  const rounds = await api('POST', `/v1/tasks/${doc.id}/rounds`, { feedbackIds: ['fb_nope'], downstream: 'keep' });
  check('POST rounds on a task that cannot start one is a 412', rounds.status === 412, rounds);
  await daemon.stop();
}
```


- [ ] **Step 2:** `npm run build && node scratch/rounds-check.mjs` fails.

- [ ] **Step 3: implement.**

```ts
// support/feedback-rules.ts (Task 3 part)
export function feedbackEffectFor(task: MissionTask, pending: readonly Approval[], runs: Pick<RunRepositoryPort, 'listByTask'>): FeedbackEffect {
  switch (task.status) {
    case 'RUNNING':
    case 'AWAITING_INPUT':
      return { kind: 'queue' };
    case 'AWAITING_APPROVAL': {
      // A start card means nothing has run yet: the note waits for round 1 like any other.
      const card = pending.find((a) => isOutputApproval(a, task, runs));
      return card === undefined ? { kind: 'attach' } : { kind: 'review', card };
    }
    case 'SUCCEEDED':
      return { kind: 'reopen' };
    case 'FAILED':
    case 'BLOCKED':
    case 'CANCELLED':
    case 'SKIPPED':
      return { kind: 'round_now' };
    default:
      return { kind: 'attach' };
  }
}
```

```ts
// services/feedback-service.ts
export class FeedbackServiceImpl implements FeedbackService {
  constructor(private readonly deps: FeedbackServiceDeps) {}   // tasks, missions, runs, approvals, artifacts, feedback, members, rounds, projections, recorder, clock, scheduler

  give(caller: Caller, taskId: TaskId, request: GiveFeedbackRequest, options: { forceDownstream?: 'keep' } = {}): FeedbackGivenView {
    const { deps } = this;
    const task = this.#task(taskId);
    const mission = this.#mission(task);
    const { actorId, recordedBy } = actorFor(deps, mission.workspaceId, caller, request.onBehalfOf);
    if (task.executor === 'wait') {
      throw new TandemiseError('PRECONDITION_FAILED', `'${task.key}' is a wait step; nothing reads feedback there.`, { details: { taskId } });
    }
    const artifactId = request.artifactId === undefined ? null : asId<'ArtifactId'>(request.artifactId);
    if (artifactId !== null && deps.artifacts.get(artifactId)?.taskId !== task.id) {
      throw TandemiseError.validation(`Artifact '${artifactId}' is not an output of '${task.key}'.`, { artifactId, taskId });
    }
    const base = { task, text: request.text, artifactId, authorId: actorId, recordedBy };
    const effect = feedbackEffectFor(task, deps.approvals.pendingForTask(task.id), deps.runs);
    let roundStarted: number | null = null;
    let impact: DownstreamImpactView | null = null;
    let item: FeedbackItem;
    switch (effect.kind) {
      case 'queue':
        item = deps.rounds.record({ ...base, status: 'queued', round: task.round ?? 1 });
        break;
      case 'attach':
        item = deps.rounds.record({ ...base, status: 'open', round: task.round ?? 1 });
        break;
      case 'review':
        item = deps.rounds.record({ ...base, status: 'open', round: null });
        deps.rounds.decideReviewCard(effect.card, { actorId, recordedBy, note: item.text });
        roundStarted = deps.rounds.startRound({ task, feedbackIds: [item.id], downstream: 'none', actorId, keepCardId: effect.card.id }).round ?? null;
        break;
      case 'reopen': {
        item = deps.rounds.record({ ...base, status: 'open', round: null });
        const found = deps.rounds.impactOf(task);
        if (found.consumers.length === 0 || options.forceDownstream !== undefined) {
          const downstream = found.consumers.length === 0 ? 'none' : options.forceDownstream!;
          roundStarted = deps.rounds.startRound({ task, feedbackIds: [item.id], downstream, actorId }).round ?? null;
        } else {
          impact = toImpactView(found, deps.feedback.listByTask(task.id).filter((i) => i.status === 'open').map((i) => i.id));
        }
        break;
      }
      case 'round_now':
        item = deps.rounds.record({ ...base, status: 'open', round: null });
        roundStarted = deps.rounds.startRound({ task, feedbackIds: [item.id], downstream: 'none', actorId }).round ?? null;
        break;
    }
    if (roundStarted !== null) deps.scheduler.wake();
    return { feedback: toFeedbackView(deps, deps.feedback.get(item.id)!), impact, roundStarted };
  }

  startRound(caller: Caller, taskId: TaskId, request: StartRoundRequest): TaskView {
    const task = this.#task(taskId);
    const mission = this.#mission(task);
    const { actorId, recordedBy } = actorFor(this.deps, mission.workspaceId, caller, request.onBehalfOf);
    const card = this.deps.approvals.pendingForTask(task.id).find((a) => isOutputApproval(a, task, this.deps.runs));
    if (card !== undefined) {
      const notes = this.deps.feedback.listByTask(task.id).filter((i) => request.feedbackIds.includes(i.id)).map((i) => i.text);
      this.deps.rounds.decideReviewCard(card, { actorId, recordedBy, note: notes.join('\n\n') });
    }
    const consumers = this.deps.rounds.impactOf(task).consumers.length;
    this.deps.rounds.startRound({
      task, feedbackIds: request.feedbackIds, actorId, keepCardId: card?.id,
      downstream: consumers === 0 ? 'none' : request.downstream,
      ...(request.redoTaskIds === undefined ? {} : { redoTaskIds: request.redoTaskIds }),
    });
    this.deps.scheduler.wake();
    return this.deps.projections.taskView(task.id);
  }

  list(taskId: TaskId): TaskFeedbackView {
    const task = this.#task(taskId);
    const items = this.deps.feedback.listByTask(task.id);
    const open = items.filter((i) => i.status === 'open').map((i) => i.id);
    const pendingImpact = open.length > 0 && ROUND_START_STATUSES.includes(task.status)
      ? toImpactView(this.deps.rounds.impactOf(task), open)
      : null;
    return { taskId: task.id, round: task.round ?? 1, items: items.map((i) => toFeedbackView(this.deps, i)), pendingImpact };
  }

  dismiss(caller: Caller, id: FeedbackId, request: { onBehalfOf?: string }): FeedbackView {
    const item = this.deps.feedback.get(id);
    if (item === undefined) throw TandemiseError.notFound('Feedback', id);
    const task = this.#task(item.taskId);
    const mission = this.#mission(task);
    const { actorId } = actorFor(this.deps, mission.workspaceId, caller, request.onBehalfOf);
    if (item.status !== 'open' && item.status !== 'queued') {
      throw new TandemiseError('CONFLICT', `A note that is ${item.status.replace('_', ' ')} cannot be dismissed.`, { details: { feedbackId: id, status: item.status } });
    }
    const dismissed = this.deps.feedback.update(id, { status: 'dismissed' });
    this.deps.recorder.record({ workspaceId: mission.workspaceId, missionId: mission.id, taskId: task.id, roleId: task.roleId, actorId }, { type: 'feedback.dismissed', feedbackId: id });
    this.deps.recorder.invalidate('tasks', mission.id);
    return toFeedbackView(this.deps, dismissed);
  }
}
```

Add to `FeedbackRounds` (used here and by Task 5):

```ts
/** Closes an output card as "Request changes": the note is on the card, and the round carries it. */
decideReviewCard(card: Approval, input: { readonly actorId: string; readonly recordedBy: string; readonly note: string }): Approval {
  const { deps } = this;
  const decided = deps.approvals.update(card.id, {
    status: 'REJECTED', selectedOptionId: REQUEST_CHANGES_OPTION, decisionNote: input.note,
    decidedBy: input.actorId, recordedBy: input.recordedBy, decidedAt: deps.clock.now(), escalateAt: null,
  });
  if (card.missionId !== null) {
    deps.recorder.record({ workspaceId: card.workspaceId, missionId: card.missionId, taskId: card.taskId, actorId: input.actorId },
      { type: 'approval.resolved', approvalId: card.id, status: 'REJECTED', option: REQUEST_CHANGES_OPTION });
  }
  deps.recorder.invalidate('approvals', card.missionId ?? undefined);
  return decided;
}
```

`support/feedback-view.ts`:

```ts
export function toFeedbackView(deps: ActorDeps, item: FeedbackItem): FeedbackView {
  const author = actorRef(deps, item.authorId);
  const recorded = actorRef(deps, item.recordedBy);
  return {
    id: item.id, taskId: item.taskId, artifactId: item.artifactId, author,
    recordedBy: recorded === null || recorded.id === author?.id ? null : recorded,
    text: item.text, status: item.status, round: item.round, createdAt: item.createdAt,
  };
}

/** The changes a handoff lists, each with the notes it answers; ids that resolve to nothing are left out. */
export function resolveChanges(deps: ActorDeps, handoff: ArtifactHandoff | null | undefined, items: ReadonlyMap<string, FeedbackItem>): readonly FeedChange[] {
  return (handoff?.changed ?? []).map((change) => ({
    what: change.what,
    declined: isDeclinedChange(change.what),
    feedback: citedFeedbackIds({ changed: [change] })
      .map((id) => items.get(id))
      .filter((i): i is FeedbackItem => i !== undefined)
      .map((i) => ({ id: i.id, text: i.text, author: actorRef(deps, i.authorId), status: i.status })),
  }));
}

export function toImpactView(impact: DownstreamImpact, feedbackIds: readonly string[]): DownstreamImpactView {
  return {
    taskId: impact.task.id, taskKey: impact.task.key, taskTitle: impact.task.title, nextRound: (impact.task.round ?? 1) + 1, feedbackIds,
    dependents: impact.consumers.map((c) => ({
      taskId: c.task.id, key: c.task.key, title: c.task.title, status: c.task.status,
      usedVersion: impact.usedVersion.get(c.task.id) ?? 1, running: c.task.status === 'RUNNING' || c.task.status === 'AWAITING_INPUT',
    })),
    defaultChoice: impact.defaultChoice,
  };
}
```

Retry with a note (`mission-service.ts#retryTask`), before today's update, after the capability widening is written:

```ts
const note = options.note?.trim() ?? '';
// A note is the person's request, so the retry is the next round framed as one
// (spec §7, C12). From AWAITING_INPUT the run is restarted with more access mid-question,
// not revised, so that path keeps today's framing.
if (note.length > 0 && ROUND_START_STATUSES.includes(task.status)) {
  if (added.length > 0) {
    this.deps.tasks.update(taskId, { executionPolicy: { ...task.executionPolicy, capabilities: [...task.executionPolicy.capabilities, ...added] } });
  }
  // A retry cannot show the impact dialog; work that used the old version is kept and flagged when the round lands.
  this.deps.feedback.give(caller, taskId, { text: note }, { forceDownstream: 'keep' });
  return this.#taskView(mission.id, taskId);
}
```

(`MissionDeps` gains `feedback: FeedbackService`; bind it in `module.ts`. `FeedbackServiceImpl` does not depend on `MissionService`, so there is no cycle.)

Projections: in `missionFeed`, read `this.deps.feedback.listByMission(id)` once, group by task, and build `round`, `openFeedback` (status in `PENDING_FEEDBACK_STATUSES`), `changed: resolveChanges(named, primary?.handoff, itemsById)`, `canRequestChanges: task.executor !== 'wait' && (task.startedAt !== null || primary !== undefined)`. The plan card gets `round: 1, openFeedback: [], changed: [], canRequestChanges: false`. In `#taskViews`, read `listByMission(mission.id)` once and add `round: task.round ?? 1, feedback`. `ProjectionDeps` and `ArtifactServiceImpl`'s `requests` gain `feedback`. In `ArtifactService.read`: `round: row.round ?? null`; `versions` = same `taskId` and `type`, ordered by version (the artifact alone when `taskId` is null); `changes` = `resolveChanges` over the task's items.

- [ ] **Step 4:** `npm run build && node scratch/rounds-check.mjs && node scratch/handoff-check.mjs && npm run check:boundaries && npm run -w @tandemise/desktop typecheck && node scripts/run-checks.mjs`.
- [ ] **Step 5:** commit `feat(api): give feedback, confirm rounds and read feedback threads, with rounds on cards and in the reader`.

### Task 4: Engine rounds — prompt, session, citations, run inputs, queued notes

**Files:**
- Modify: `packages/application/src/support/feedback-rules.ts` (brief, contract, prompt rendering; `capDraft` and `MAX_DRAFT_CHARS` move here from `task-executor.ts`)
- Modify: `packages/application/src/engine/feedback-rounds.ts` (`openRound`, `roundContract`, `promoteQueued`, `requeue`, `hasQueued`, `onRoundLanded`, `onPersonCompleted`)
- Modify: `packages/application/src/engine/task-executor.ts`, `engine/harvester.ts`
- Modify: `packages/application/src/services/mission-service.ts` (`completeTask`)
- Modify: `packages/application/src/module.ts` (executor deps `rounds`, `runInputs`)
- Modify: `packages/runtime-generic/src/fake-script.ts`, `fake.ts` (script-level `captures`)
- Modify: `scratch/rounds-check.mjs` (section "engine")

**Interfaces consumed:** Task 1 entities and ports; `FeedbackRounds.startRound`, `.impactOf`, `downstreamConsumers` (Task 2); `FeedbackService.give` (Task 3); P1 `#tighten`, `#drive` with `continueSession`/`freshPrompt`, `SlotRetention`, `ArtifactHarvester` with `revising`.

**Interfaces produced:**

```ts
// support/feedback-rules.ts
export interface BriefItem {
  readonly id: string;
  readonly authorName: string;
  readonly text: string;
  /** The output the note is about; null for the whole task. */
  readonly artifactType: ArtifactType | null;
  readonly round: number | null;
}
export interface RoundBrief {
  readonly round: number;
  /** In round now: must be cited. */
  readonly toAddress: readonly BriefItem[];
  /** Addressed in earlier rounds: context only. */
  readonly earlier: readonly BriefItem[];
  /** The task's live artifacts, read from the store; empty in round 1. */
  readonly previous: readonly LoadedArtifact[];
}
export interface RoundContract {
  readonly round: number;
  readonly required: readonly { readonly id: string; readonly artifactType: ArtifactType | null }[];
  /** Every feedback id on the task: citing anything else is an error. */
  readonly known: ReadonlySet<string>;
  /** Where a note about the whole task must be cited: the task's first expected output. */
  readonly primaryType: ArtifactType;
}
export const MAX_DRAFT_CHARS = 20_000;
export function capDraft(body: string): string;
export function checkRoundHandoff(type: ArtifactType, handoff: Pick<ArtifactHandoff, 'changed'> | null, contract: RoundContract): readonly string[];
export function renderRoundBrief(brief: RoundBrief, destination: (type: ArtifactType) => string): string;
/** What a continued session is told: the same brief, plus where to write. */
export function roundRequest(brief: RoundBrief, destinations: readonly string[]): string;

// engine/feedback-rounds.ts (added)
/** Promotes the task's open notes into its current round and builds the brief; null when the attempt carries no feedback. */
openRound(task: MissionTask): Promise<RoundBrief | null>;
roundContract(task: MissionTask, brief: RoundBrief): RoundContract;
/** Queued → in_round in the current round; returns what was delivered. */
promoteQueued(task: MissionTask): readonly FeedbackItem[];
/** A delivery pass the daemon interrupted hands its notes back. */
requeue(items: readonly FeedbackItem[]): void;
hasQueued(taskId: TaskId): boolean;
/** Cited notes become addressed; with round > 1, consumers of the old version that were kept get needsAttention. */
onRoundLanded(task: MissionTask, manifests: readonly ArtifactManifest[], scope: EventScope): void;
/** A person cannot cite ids: completing addresses every open or in-round note in the current round. */
onPersonCompleted(task: MissionTask, scope: EventScope): void;

// engine/harvester.ts
// HarvestRequest gains: readonly roundContract?: RoundContract;
// every stored artifact gets round: request.task.round ?? 1

// engine/task-executor.ts
// TaskExecutorDeps gains: readonly rounds: FeedbackRounds; readonly runInputs: RunInputRepositoryPort;
// #compilePrompt returns { readonly prompt: string; readonly includedArtifactIds: readonly ArtifactId[] }
// PromptInput gains: readonly round?: RoundBrief | null;
// DriveInput gains: readonly purpose: RunPurpose; readonly round: number; readonly inputs: readonly ArtifactId[];
const MAX_FEEDBACK_PASSES = 5;

// runtime-generic/fake-script.ts
// FakeScript gains: readonly captures?: Readonly<Record<string, string>>;
// name → regex source, applied with flags 'gm' to the prompt; `{{name}}` expands to every first capture group, joined with ', '.
```

- [ ] **Step 1: failing section "engine".** Add above the footer. It uses the fake runtime with `captures`, so feedback ids appear in the files the fake writes without the check editing a profile mid-run.

```js
section('engine: rounds');
{
  const { mkdtempSync, mkdirSync, readFileSync, existsSync } = await import('node:fs');
  const { execFileSync } = await import('node:child_process');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { systemClock, ids } = await import('@tandemise/shared');
  const { FAKE_ADAPTER_ID } = await import('@tandemise/runtime-generic');
  const keepAlive = setInterval(() => {}, 1000);
  const HOME = mkdtempSync(join(tmpdir(), 'tre-'));
  const h = await engineHarness(HOME, 'rounds-engine-check');
  const now = () => systemClock.now();

  const FB_ALL = '^\\d+\\. (fb_[0-9a-z]{20}) \\(';
  const FB_FIRST = '^1\\. (fb_[0-9a-z]{20}) \\(';
  const brief = ({ headline = 'Onboarding designed', changed = null } = {}) => [
    '---', 'type: DesignBrief', 'title: Onboarding design', 'handoff:', `  headline: ${headline}`,
    ...(changed === null ? [] : ['  changed:', ...changed.flatMap((c) => [`    - what: ${JSON.stringify(c.what)}`, `      feedback: ${JSON.stringify(c.feedback)}`])]),
    'flows:', '  - onboarding', '---', '', '# Onboarding', '', `${headline}.`, '',
  ].join('\n');
  const IN_ROUND = { promptIncludes: 'Feedback to address' };
  const write = (content, when) => ({ kind: 'write-file', path: '.tandemise/out/DesignBrief.md', content, ...(when ? { when } : {}) });
  const promptFile = { kind: 'write-file', path: 'prompts/{{runId}}.txt', content: '{{prompt}}' };
  const done = { kind: 'complete', summary: 'done' };
  const profile = (name, steps, extra = {}) => h.repo.profiles.create({
    id: ids.runtimeProfile(), workspaceId: null, adapterId: FAKE_ADAPTER_ID, name, executablePath: null, args: [],
    settings: { script: { steps, ...extra } }, capabilities: [], enabled: true, maxConcurrent: 4, createdAt: now(), updatedAt: now(),
  }).id;
  const cited = (feedback = '{{fb}}', what = 'Shortened the intro') => write(brief({ headline: 'Onboarding, shorter', changed: [{ what, feedback }] }), IN_ROUND);
  const session = (id) => ({ kind: 'checkpoint', sessionId: id, label: 'session.init' });
  const P = {
    c1: profile('c1', [session('sess-c1'), promptFile, write(brief()), cited(), done], { captures: { fb: FB_ALL } }),
    lost: profile('lost', [promptFile, session('sess-lost'), write(brief()), cited(), done], { captures: { fb: FB_ALL }, resume: 'missing' }),
    slow: profile('slow', [session('sess-c4'), promptFile, write(brief()), { kind: 'delay', ms: 1500 }, cited(), done], { captures: { fb: FB_ALL } }),
    partial: profile('partial', [promptFile, write(brief()), cited('{{first}}'), { ...cited('{{fb}}'), when: { promptIncludes: 'must cite' } }, done], { captures: { fb: FB_ALL, first: FB_FIRST } }),
    decline: profile('decline', [promptFile, write(brief()), cited('{{fb}}', 'Declined: the intro is already one line'), done], { captures: { fb: FB_ALL } }),
    lazy: profile('lazy', [promptFile, cited(), done], { captures: { fb: FB_ALL } }),
  };
  const caller = { personId: h.services.identity.localPerson().id };
  const ws = (await h.services.workspaces.create(caller, { name: 'Engine' })).workspace.id;
  const owner = h.services.team.me(caller).memberships.find((m) => m.workspaceId === ws).memberId;
  const agent = (name, profileId, roleIds = ['design']) => h.services.team.addMember(caller, ws, { kind: 'agent', name, reportsTo: owner, roleIds, runtimeProfileIds: [profileId] }).id;
  const A = Object.fromEntries(Object.entries(P).map(([k, id]) => [k, agent(`Agent ${k}`, id)]));

  let seq = 0;
  const addMission = async (defs) => {
    const mission = await h.services.missions.create(caller, { workspaceId: ws, goal: 'Design onboarding', title: `E${++seq}` });
    const dir = h.paths.mission(ws, mission.id);
    mkdirSync(dir, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main', dir]);
    execFileSync('git', ['-C', dir, '-c', 'user.name=check', '-c', 'user.email=check@example.com', 'commit', '-q', '--allow-empty', '-m', 'init']);
    const out = {};
    for (const d of defs) {
      out[d.key] = h.repo.tasks.add({
        id: ids.task(), missionId: mission.id, key: d.key, title: d.key, objective: 'o', roleId: d.roleId ?? 'design',
        dependsOn: d.dependsOn ?? [], requiredCapabilities: [], inputArtifacts: d.inputArtifacts ?? [], expectedOutputs: d.expectedOutputs ?? ['DesignBrief'],
        executionPolicy: { isolation: 'none', maxWallTimeMs: 60000, capabilities: [] }, approvalPolicy: { beforeStart: false, onCompletion: false },
        retryPolicy: { maxAttempts: d.maxAttempts ?? 2, backoffMs: 0, onExhausted: 'block' }, completionGate: null,
        status: d.status ?? (d.dependsOn ? 'PENDING' : 'READY'), statusReason: null, attempts: 0, remediatesTaskId: null, repositoryId: null,
        executor: d.executor ?? 'agent', waitPolicy: null, orderHint: 0, staffingOverride: d.agent ? { assignees: [d.agent] } : null,
        createdAt: now(), updatedAt: now(), startedAt: null, finishedAt: null,
      }).id;
    }
    h.repo.missions.update(mission.id, { status: 'EXECUTING' });
    return { mission, dir, t: out };
  };
  const task = (id) => h.repo.tasks.get(id);
  const settled = (id) => h.until(() => ['SUCCEEDED', 'FAILED', 'BLOCKED', 'AWAITING_APPROVAL', 'AWAITING_HUMAN'].includes(task(id).status), 20000);
  const runsOf = (id) => [...h.repo.runs.listByTask(id)].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const promptOf = (dir, run) => { const p = join(dir, 'prompts', `${run.id}.txt`); return existsSync(p) ? readFileSync(p, 'utf8') : ''; };
  const live = (id) => { const all = h.repo.artifacts.listByTask(id); const sup = new Set(all.map((a) => a.supersedes)); return all.filter((a) => !sup.has(a.id)); };
  const events = (missionId, type) => h.repo.events.listByMission(missionId).filter((e) => e.body.type === type);

  // ---- C1: a round continues the settled session
  {
    const { mission, dir, t } = await addMission([{ key: 'doc', agent: A.c1 }]);
    await settled(t.doc);
    check('C1: round 1 succeeds on its first run as purpose round', task(t.doc).status === 'SUCCEEDED' && runsOf(t.doc)[0]?.purpose === 'round' && runsOf(t.doc)[0]?.round === 1, runsOf(t.doc));
    const given = h.services.feedback.give(caller, t.doc, { text: 'Shorter intro' });
    await settled(t.doc);
    const [, second] = runsOf(t.doc);
    const prompt = promptOf(dir, second);
    check('C1: round 2 succeeded', task(t.doc).status === 'SUCCEEDED' && task(t.doc).round === 2, task(t.doc));
    check('C1: the run is purpose round, round 2, on the same session', second?.purpose === 'round' && second.round === 2 && second.externalSessionId === 'sess-c1', second);
    check('C1: the runtime was asked to resume', h.repo.events.listByRun(second.id).some((e) => e.body.type === 'checkpoint' && e.body.label === 'session.resumed'));
    check('C1: the continued prompt is the request with the previous output and the numbered note',
      prompt.startsWith('This is round 2 of this task.') && prompt.includes('Your previous output') && prompt.includes(`1. ${given.feedback.id} (`) && prompt.includes('Shorter intro'), prompt.slice(0, 400));
    check('C1: nothing frames it as a gate failure', !prompt.includes('did not satisfy this task'));
    check('C1: the note is addressed in round 2', h.repo.feedback.get(given.feedback.id).status === 'addressed' && h.repo.feedback.get(given.feedback.id).round === 2);
    const [art] = live(t.doc);
    check('C1: the new artifact is round 2 and cites the note', art?.round === 2 && art.handoff.changed[0].feedback === given.feedback.id, art);
    check('C1: feedback.addressed is recorded', events(mission.id, 'feedback.addressed').some((e) => e.body.feedbackId === given.feedback.id && e.body.round === 2 && e.body.declined === false));
  }

  // ---- a session the runtime lost: the round restarts fresh with the full prompt
  {
    const { mission, dir, t } = await addMission([{ key: 'doc', agent: A.lost }]);
    await settled(t.doc);
    h.services.feedback.give(caller, t.doc, { text: 'Shorter intro' });
    await settled(t.doc);
    const [, second] = runsOf(t.doc);
    check('lost session: round 2 still succeeds', task(t.doc).status === 'SUCCEEDED' && task(t.doc).round === 2);
    check('lost session: the fresh prompt is the full context with the brief', promptOf(dir, second).includes('Required output') && promptOf(dir, second).includes('Feedback to address'));
    check('lost session: a note says it started fresh', events(mission.id, 'note').some((e) => /could no longer be resumed/.test(e.body.text)));
  }

  // ---- C4: a note while running is delivered at pass end, same round, attempts unchanged
  {
    const { dir, t } = await addMission([{ key: 'doc', agent: A.slow }]);
    await h.until(() => h.repo.runs.listByTask(t.doc).some((r) => r.status === 'RUNNING'));
    const given = h.services.feedback.give(caller, t.doc, { text: 'Mention the pricing page' });
    check('C4: the note is queued', given.feedback.status === 'queued');
    await settled(t.doc);
    const runs = runsOf(t.doc);
    check('C4: the task succeeded in round 1 with one counted attempt', task(t.doc).status === 'SUCCEEDED' && task(t.doc).round === 1 && task(t.doc).attempts === 1, task(t.doc));
    check('C4: exactly one extra pass, purpose feedback, round 1, same session', runs.length === 2 && runs[1].purpose === 'feedback' && runs[1].round === 1 && runs[1].externalSessionId === 'sess-c4', runs.map((r) => [r.purpose, r.round]));
    check('C4: the note is addressed in round 1', h.repo.feedback.get(given.feedback.id).status === 'addressed' && h.repo.feedback.get(given.feedback.id).round === 1);
    check('C4: the delivery prompt carries the note', promptOf(dir, runs[1]).includes(given.feedback.id));
  }

  // ---- C5 and C6: two notes before the round; one citation missing on the first try
  {
    const { dir, t } = await addMission([{ key: 'doc', agent: A.partial }]);
    await settled(t.doc);
    const first = h.services.feedback.give(caller, t.doc, { text: 'Shorter intro' });
    const second = h.services.feedback.give(caller, t.doc, { text: 'Friendlier button copy' });
    check('C5: the second note joins the round that has not started yet', first.roundStarted === 2 && second.feedback.status === 'open' && second.feedback.round === 2);
    await settled(t.doc);
    const runs = runsOf(t.doc).filter((r) => r.round === 2);
    check('C6: the first round-2 attempt was refused, the retry named the missing id and passed',
      runs.length === 2 && promptOf(dir, runs[1]).includes(`must cite ${second.feedback.id}`) && task(t.doc).status === 'SUCCEEDED', runs.map((r) => r.purpose));
    check('C6: the retry is a counted retry in round 2', runs[1].purpose === 'retry' && task(t.doc).attempts === 3);
    check('C5: both notes are cited and addressed in round 2',
      [first, second].every((g) => h.repo.feedback.get(g.feedback.id).status === 'addressed' && h.repo.feedback.get(g.feedback.id).round === 2)
      && live(t.doc)[0].handoff.changed[0].feedback === `${first.feedback.id}, ${second.feedback.id}`);
  }

  // ---- C9: a decline is a citation
  {
    const { mission, t } = await addMission([{ key: 'doc', agent: A.decline }]);
    await settled(t.doc);
    const given = h.services.feedback.give(caller, t.doc, { text: 'Add a video' });
    await settled(t.doc);
    check('C9: a declined note is addressed, and the event says it was declined',
      h.repo.feedback.get(given.feedback.id).status === 'addressed' && events(mission.id, 'feedback.addressed').some((e) => e.body.feedbackId === given.feedback.id && e.body.declined === true));
  }

  // ---- C12: retry from blocked with a note is a request
  {
    const { dir, t } = await addMission([{ key: 'doc', agent: A.lazy, maxAttempts: 1 }]);
    await settled(t.doc);
    check('C12: without a note the lazy agent blocks the task', task(t.doc).status === 'BLOCKED', task(t.doc));
    await h.services.missions.retryTask(caller, t.doc, { note: 'Write the brief, even a short one' });
    await settled(t.doc);
    const last = runsOf(t.doc).at(-1);
    const prompt = promptOf(dir, last);
    check('C12: the retry ran as round 2 and succeeded', task(t.doc).status === 'SUCCEEDED' && last.round === 2 && last.purpose === 'round');
    check('C12: the note reaches the agent as a request, not a gate failure',
      prompt.includes('Feedback to address') && prompt.includes('Write the brief, even a short one') && !prompt.includes("did not satisfy this task's completion gate"), prompt.slice(-1500));
  }

  // ---- run inputs, keep flags and redo against the new version
  {
    const buildAgent = agent('Builder', profile('builder', [
      { kind: 'write-file', path: '.tandemise/out/ChangeSet.md', content: ['---', 'type: ChangeSet', 'title: Build', 'handoff:', '  headline: Built', 'branch: b', 'commits: []', 'filesChanged: 0', 'testsRun: []', 'knownLimitations: []', '---', '', 'Built.'].join('\n') }, done,
    ]), ['development']);
    const { mission, t } = await addMission([
      { key: 'design', agent: A.c1 },
      { key: 'build', agent: buildAgent, roleId: 'development', dependsOn: ['design'], expectedOutputs: ['ChangeSet'], inputArtifacts: [{ type: 'DesignBrief', required: true }] },
    ]);
    await settled(t.design); await settled(t.build);
    const v1 = live(t.design)[0];
    const buildRun = runsOf(t.build)[0];
    check('run_inputs records the design artifact the build was given', h.repo.runInputs.listByRun(buildRun.id).includes(v1.id));

    const keep = h.services.feedback.give(caller, t.design, { text: 'Darker header' });
    check('the build is listed as a consumer of v1', keep.impact?.dependents[0]?.key === 'build' && keep.impact.dependents[0].usedVersion === 1, keep.impact);
    h.services.feedback.startRound(caller, t.design, { feedbackIds: [keep.feedback.id], downstream: 'keep' });
    await settled(t.design);
    const attention = events(mission.id, 'task.attention').find((e) => e.taskId === t.build);
    check('C2 keep: the kept build is flagged "Built against design v1; v2 is out."', task(t.build).needsAttention === true && attention?.body.note === 'Built against design v1; v2 is out.', attention?.body);

    const redo = h.services.feedback.give(caller, t.design, { text: 'Lighter footer' });
    h.services.feedback.startRound(caller, t.design, { feedbackIds: [redo.feedback.id], downstream: 'redo' });
    check('C2 redo: the build waits again', task(t.build).status === 'PENDING');
    await settled(t.design);
    await h.until(() => runsOf(t.build).length === 2 && task(t.build).status === 'SUCCEEDED', 20000);
    check('C2 redo: the build reran against v3', h.repo.runInputs.listByRun(runsOf(t.build)[1].id).includes(live(t.design)[0].id) && live(t.design)[0].round === 3);
  }

  // ---- C8 offline: a person's step
  {
    const { t } = await addMission([{ key: 'docs', executor: 'human', expectedOutputs: ['Evidence'] }]);
    await h.until(() => task(t.docs).status === 'AWAITING_HUMAN');
    const given = h.services.feedback.give(caller, t.docs, { text: 'Mention the pricing page' });
    await h.services.missions.completeTask(caller, t.docs, { result: 'README: pricing is on /pricing.' });
    check('C8: completing the step addresses the note in round 1, and the output is round 1',
      h.repo.feedback.get(given.feedback.id).status === 'addressed' && h.repo.feedback.get(given.feedback.id).round === 1 && live(t.docs)[0]?.round === 1);
  }

  await h.container.dispose();
  clearInterval(keepAlive);
}
```

Note the `write` helper writes to `.tandemise/out/DesignBrief.md`; the harvester also collects loose top-level files, as P1's engine check relies on.

- [ ] **Step 2:** `npm run build && node scratch/rounds-check.mjs` fails.

- [ ] **Step 3: implement.**

Fake `captures` (`fake-script.ts` parse: an optional object of string → string whose values compile as `new RegExp(value, 'gm')`, else a validation error naming the key; `fake.ts#drive`):

```ts
const captured = Object.fromEntries(Object.entries(script.value.captures ?? {}).map(([name, source]) =>
  [name, [...request.prompt.matchAll(new RegExp(source, 'gm'))].map((m) => m[1] ?? m[0]).join(', ')]));
const values = { prompt: request.prompt, cwd: request.workingDirectory, runId: request.runId, ...captured };
```

Pure rules:

```ts
// support/feedback-rules.ts (Task 4 part)
export function checkRoundHandoff(type: ArtifactType, handoff: Pick<ArtifactHandoff, 'changed'> | null, contract: RoundContract): readonly string[] {
  const owed = contract.required.filter((r) => (r.artifactType ?? contract.primaryType) === type);
  const cited = citedFeedbackIds(handoff);
  const problems: string[] = [];
  if (owed.length > 0 && (handoff?.changed.length ?? 0) === 0) problems.push('handoff.changed must have at least one entry');
  const unknown = cited.filter((id) => !contract.known.has(id));
  if (unknown.length > 0) problems.push(`handoff.changed cites feedback that is not on this task: ${unknown.join(', ')}`);
  const missing = owed.filter((r) => !cited.includes(r.id)).map((r) => r.id);
  if (missing.length > 0) {
    problems.push(`handoff.changed must cite ${missing.join(', ')}: address each one, or decline it with what: "Declined: <reason>"`);
  }
  return problems;
}

/** Continuation lines are indented so a multi-line note stays one numbered item. */
const oneItem = (text: string): string => text.trim().replace(/\n+/g, '\n   ');

export function renderRoundBrief(brief: RoundBrief, destination: (type: ArtifactType) => string): string {
  const lines: string[] = [
    brief.round > 1
      ? `This is round ${brief.round} of this task. The people this work is for read your previous output and asked for changes. This is their request, not a failed check.`
      : 'Before you started, the people this work is for left notes on this task. This is their request, not a failed check.',
  ];
  if (brief.previous.length > 0) {
    lines.push('', 'Your previous output:');
    for (const draft of brief.previous) {
      lines.push('', `${draft.manifest.type}, to edit and write back to \`${destination(draft.manifest.type)}\`:`, '', '````markdown', capDraft(draft.body.trimEnd()), '````');
    }
  }
  lines.push('', 'Feedback to address:',
    ...brief.toAddress.map((item, i) => `${i + 1}. ${item.id} (${item.authorName}): ${oneItem(item.text)}${item.artifactType === null ? '' : ` [about the ${item.artifactType}]`}`));
  if (brief.earlier.length > 0) {
    lines.push('', 'Addressed in earlier rounds, for context. Do not undo these:',
      ...brief.earlier.map((item) => `- ${item.id} (${item.authorName}, round ${item.round}): ${oneItem(item.text)}`));
  }
  lines.push('',
    'Edit your previous output; do not rewrite it. Keep everything nobody asked to change.',
    'In the handoff, fill `changed` with one entry per change and set its `feedback` to the id it answers. One entry may answer several ids, separated by commas; `changed` holds at most 3 entries.',
    'Cite every item under "Feedback to address": either address it, or decline it with `what: "Declined: <reason>"`.');
  return lines.join('\n');
}

export function roundRequest(brief: RoundBrief, destinations: readonly string[]): string {
  return [
    renderRoundBrief(brief, (type) => destinations.find((d) => d.endsWith(`/${type}.md`)) ?? `${type}.md`),
    '',
    `Edit the files in place (${destinations.map((d) => `\`${d}\``).join(', ')}) and keep their front matter valid.`,
  ].join('\n');
}
```

`FeedbackRounds` additions:

```ts
async openRound(task: MissionTask): Promise<RoundBrief | null> {
  const { deps } = this;
  const round = task.round ?? 1;
  const items = deps.feedback.listByTask(task.id);
  for (const item of items) {
    if (item.status === 'open') deps.feedback.update(item.id, { status: 'in_round', round });
  }
  const current = deps.feedback.listByTask(task.id);
  const toAddress = current.filter((i) => i.status === 'in_round');
  if (toAddress.length === 0 && round === 1) return null;
  const all = deps.artifacts.listByTask(task.id);
  const superseded = new Set(all.map((a) => a.supersedes).filter((id) => id !== null));
  const previous: LoadedArtifact[] = [];
  if (round > 1) {
    for (const manifest of all.filter((a) => !superseded.has(a.id))) {
      try { previous.push(await deps.artifactStore.read(manifest.id)); } catch { /* an unreadable draft is left out; the brief still names the notes */ }
    }
  }
  const toItem = (i: FeedbackItem): BriefItem => ({
    id: i.id, authorName: this.#name(i.authorId), text: i.text, round: i.round,
    artifactType: i.artifactId === null ? null : deps.artifacts.get(i.artifactId)?.type ?? null,
  });
  return {
    round, previous,
    toAddress: toAddress.map(toItem),
    earlier: current.filter((i) => i.status === 'addressed' && (i.round ?? 0) < round).map(toItem),
  };
}

roundContract(task: MissionTask, brief: RoundBrief): RoundContract {
  return {
    round: brief.round,
    required: brief.toAddress.map((i) => ({ id: i.id, artifactType: i.artifactType })),
    known: new Set(this.deps.feedback.listByTask(task.id).map((i) => i.id)),
    primaryType: task.expectedOutputs[0] ?? 'Evidence',
  };
}

promoteQueued(task: MissionTask): readonly FeedbackItem[] {
  const round = task.round ?? 1;
  return this.deps.feedback.listByTask(task.id)
    .filter((i) => i.status === 'queued')
    .map((i) => this.deps.feedback.update(i.id, { status: 'in_round', round }));
}

requeue(items: readonly FeedbackItem[]): void {
  for (const item of items) this.deps.feedback.update(item.id, { status: 'queued' });
}

hasQueued(taskId: TaskId): boolean {
  return this.deps.feedback.listByTask(taskId).some((i) => i.status === 'queued');
}

onRoundLanded(task: MissionTask, manifests: readonly ArtifactManifest[], scope: EventScope): void {
  const { deps } = this;
  const round = task.round ?? 1;
  const declined = new Map<string, boolean>();
  for (const manifest of manifests) {
    for (const change of manifest.handoff?.changed ?? []) {
      for (const id of citedFeedbackIds({ changed: [change] })) declined.set(id, (declined.get(id) ?? false) || isDeclinedChange(change.what));
    }
  }
  for (const item of deps.feedback.listByTask(task.id)) {
    if (item.status !== 'in_round' || !declined.has(item.id)) continue;
    deps.feedback.update(item.id, { status: 'addressed', round });
    deps.recorder.record(scope, { type: 'feedback.addressed', feedbackId: item.id, round, declined: declined.get(item.id)! });
  }
  if (round > 1) this.#flagKeptConsumers(task, scope);
  deps.recorder.invalidate('tasks', task.missionId);
}

onPersonCompleted(task: MissionTask, scope: EventScope): void {
  const round = task.round ?? 1;
  for (const item of this.deps.feedback.listByTask(task.id)) {
    if (item.status !== 'open' && item.status !== 'in_round') continue;
    this.deps.feedback.update(item.id, { status: 'addressed', round });
    this.deps.recorder.record(scope, { type: 'feedback.addressed', feedbackId: item.id, round, declined: false });
  }
  if (round > 1) this.#flagKeptConsumers(task, scope);
}

/**
 * Spec §3 Keep: whoever still stands on an older version is told a newer one
 * is out. A redone dependent is PENDING or running again and is not flagged.
 */
#flagKeptConsumers(task: MissionTask, scope: EventScope): void {
  const { deps } = this;
  const artifacts = deps.artifacts.listByMission(task.missionId);
  const lines = versionLines(artifacts);
  const latest = Math.max(0, ...artifacts.filter((a) => a.taskId === task.id).map((a) => lines.get(a.id)?.version ?? 1));
  const impact = this.impactOf(task);
  for (const consumer of impact.consumers) {
    if (consumer.used.taskId !== task.id || lines.get(consumer.used.id)?.supersededBy === null) continue;
    if (['PENDING', 'READY', 'RUNNING', 'AWAITING_INPUT'].includes(consumer.task.status)) continue;
    const note = `Built against ${task.title} v${impact.usedVersion.get(consumer.task.id) ?? 1}; v${latest} is out.`;
    deps.tasks.update(consumer.task.id, { needsAttention: true });
    deps.recorder.record({ ...scope, taskId: consumer.task.id, roleId: consumer.task.roleId }, { type: 'task.attention', taskId: consumer.task.id, note });
  }
}
```

Harvester (`#collectOne`, right after a successful parse and before `#unchanged`, so an untouched draft that owes a citation is refused too):

```ts
if (request.roundContract !== undefined) {
  const problems = checkRoundHandoff(type, readHandoff(parsed.value.frontMatter), request.roundContract);
  if (problems.length > 0) {
    return { ok: false, issue: `\`${path}\` does not answer the feedback for round ${request.roundContract.round}: ${problems.join('; ')}` };
  }
}
```

and `round: request.task.round ?? 1` in `this.artifacts.create({...})`.

Executor changes, in order through `#runRouted`:

```ts
const round = task.round ?? 1;
const priorRuns = deps.runs.listByTask(task.id);
const resumable = this.#resumableRun(task.id, adapter.resume !== undefined);
const resuming = resumable !== null && task.attempts > 0;
const attempt = resuming ? task.attempts : task.attempts + 1;
// Only counted attempts make a round "started"; a tighten or delivery pass does not.
const firstOfRound = !priorRuns.some((r) => (r.round ?? 1) === round && (r.purpose === 'round' || r.purpose === 'retry' || r.purpose == null));
const purpose: RunPurpose = resuming ? resumable.purpose ?? 'retry' : firstOfRound ? 'round' : 'retry';
```

After `running` is written and the harvester has prepared:

```ts
const brief = await deps.rounds.openRound(running);
const compiled = await this.#compilePrompt({ ...ctx, task: running, workspace, role, grants, target, tools: toolSurface.toolNames, feedback, round: brief });
const destinations = running.expectedOutputs.map((type) => `${outDirFor(running)}/${type}.md`);
// Spec §5: a round continues the last settled session whenever the runtime can, whatever that run's status.
const session = firstOfRound && round > 1 && !resuming && brief !== null ? this.#settledSession(running.id, profile, adapter) : null;
const outcome = await this.#drive({
  task: running, mission, profile, adapter, target, assignment, grants, scope, signal, agent, runId,
  mcpConfigPath: toolSurface.mcpConfigPath, reservation, retainSlot: retained,
  prompt: session !== null && brief !== null ? roundRequest(brief, destinations) : compiled.prompt,
  ...(session === null ? {} : { continueSession: session, freshPrompt: compiled.prompt }),
  purpose, round, inputs: compiled.includedArtifactIds,
});
```

```ts
#settledSession(taskId: TaskId, profile: RuntimeProfile, adapter: { resume?: unknown }): string | null {
  if (adapter.resume === undefined || !this.deps.runtimeManager.capabilities(profile).includes('session_resume')) return null;
  const last = [...this.deps.runs.listByTask(taskId)]
    .filter((r) => r.externalSessionId !== null)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
  // A session belongs to the runtime profile that holds it; another profile cannot continue it.
  return last !== undefined && last.runtimeProfileId === profile.id ? last.externalSessionId : null;
}
```

In `#drive`: write `round: input.round, purpose: input.purpose` on `runs.create`, then immediately `deps.runInputs.record(runId, input.inputs)`. In `#contractNotes`, add after the gate-feedback note:

```ts
// An owner's request, not a gate failure (P0 lesson): the round passed or the person chose to go again.
if (round !== undefined && round !== null) notes.push(renderRoundBrief(round, (type) => `${outDirFor(task)}/${type}.md`));
```

Harvest with `roundContract: brief === null ? undefined : deps.rounds.roundContract(running, brief)`. Keep the slot through checks when a note waits: `if (harvest.overBudget.length === 0 && !deps.rounds.hasQueued(running.id)) retained.reservation?.release();`.

Replace the block between `#assess` and `#judge` with:

```ts
let assessed = this.#assess(running, harvest, outcome.failure, scope, outcome.runId);
let final = harvest;
let lastRunId = outcome.runId;
if (assessed.verdict.passed) {
  const delivered = await this.#deliverQueued({ ...ctx, task: running, harvest, assessed, profile, adapter, target, assignment, grants, agent, scope,
    firstRunId: outcome.runId, tools: toolSurface.toolNames, mcpConfigPath: toolSurface.mcpConfigPath, retained });
  if (delivered.kind === 'stopped') return delivered.outcome;
  ({ harvest: final, assessed, lastRunId } = delivered);
} else {
  // A failed pass is retried anyway; the notes ride with the retry, which must cite them.
  deps.rounds.promoteQueued(running);
}
if (assessed.verdict.passed && final.overBudget.length > 0) {
  const tightened = await this.#tighten({ ...ctx, task: running, harvest: final, profile, adapter, target, assignment, grants, agent, scope,
    firstRunId: lastRunId, tools: toolSurface.toolNames, mcpConfigPath: toolSurface.mcpConfigPath, retained });
  if (tightened.kind === 'stopped') return tightened.outcome;
  final = tightened.harvest;
}
if (assessed.verdict.passed) deps.rounds.onRoundLanded(running, final.manifests, scope);
return this.#judge({ task: running, mission, workspace, role, scope, harvest: final, checks, runFailure: outcome.failure, runId: lastRunId, assessed });
```

`#tighten` passes `round: await deps.rounds.openRound(task)` into its fresh `#compilePrompt`, writes `purpose: 'tighten', round: task.round ?? 1, inputs: fresh.includedArtifactIds` on its `#drive`, and gives its second harvest the same `roundContract`, so a tightened draft keeps its citations.

```ts
/**
 * Spec §4: notes that arrived while the pass ran are delivered before the task
 * settles, as further passes in the same round. They are not attempts: a person
 * asked for more, nothing failed. The session continues when the runtime can;
 * otherwise the pass runs fresh with the draft and the notes in its prompt.
 */
async #deliverQueued(input: TightenInput & { readonly assessed: Assessment }): Promise<
  | { readonly kind: 'harvest'; readonly harvest: HarvestResult; readonly assessed: Assessment; readonly lastRunId: RunId }
  | { readonly kind: 'stopped'; readonly outcome: TaskAttemptOutcome }
> {
  const { deps } = this;
  const { task, profile, scope } = input;
  let harvest = input.harvest;
  let assessed = input.assessed;
  let lastRunId = input.firstRunId;
  for (let pass = 0; pass < MAX_FEEDBACK_PASSES; pass++) {
    const delivered = deps.rounds.promoteQueued(task);
    if (delivered.length === 0) break;
    deps.recorder.note(scope, `Delivering ${delivered.length === 1 ? 'a note' : `${delivered.length} notes`} to '${task.key}' now that its pass has ended.`);
    const brief = (await deps.rounds.openRound(task))!;
    const fresh = await this.#compilePrompt({ ...input, feedback: null, round: brief });
    const session = deps.runs.get(lastRunId)?.externalSessionId ?? null;
    const resumable = session !== null && input.adapter.resume !== undefined && deps.runtimeManager.capabilities(profile).includes('session_resume');
    const destinations = task.expectedOutputs.map((type) => `${outDirFor(task)}/${type}.md`);
    const outcome = await this.#drive({
      task, mission: input.mission, profile, adapter: input.adapter, target: input.target, assignment: input.assignment,
      prompt: resumable ? roundRequest(brief, destinations) : fresh.prompt, freshPrompt: fresh.prompt,
      continueSession: resumable ? session : null, grants: input.grants, scope, signal: input.signal, agent: input.agent,
      runId: ids.run(), mcpConfigPath: input.mcpConfigPath, reservation: takeReservation(input.retained),
      purpose: 'feedback', round: task.round ?? 1, inputs: fresh.includedArtifactIds,
    });
    if (outcome.interrupted) {
      // The notes go back to waiting; the sweep shows them as pending if nothing picks them up.
      deps.rounds.requeue(delivered);
      return { kind: 'harvest', harvest, assessed, lastRunId };
    }
    const stopped = this.#stopped(outcome, task, scope);
    if (stopped !== null) return { kind: 'stopped', outcome: stopped };
    if (outcome.failure !== null) {
      assessed = { ...assessed, verdict: { passed: false, detail: `The pass that delivered new feedback did not finish (${outcome.failure.code}): ${summarize(outcome.failure.message, 300)}` } };
      return { kind: 'harvest', harvest, assessed, lastRunId: outcome.runId };
    }
    const refs = await this.#commit(input.target, task, input.role, profile, outcome.runId, scope);
    const second = await deps.harvester.harvest({
      mission: input.mission, task, target: input.target, runId: outcome.runId, roleId: input.role.id,
      scope: { ...scope, runId: outcome.runId, runtimeProfileId: profile.id }, sourceRefs: refs,
      authorId: input.agent?.id ?? RUNTIME_ACTOR, revising: harvest.manifests, roundContract: deps.rounds.roundContract(task, brief),
    });
    const rewritten = new Map(second.manifests.map((m) => [m.type, m]));
    harvest = {
      ...harvest,
      manifests: harvest.manifests.map((m) => rewritten.get(m.type) ?? m),
      // A type the pass broke (a citation missing) is missing now, so the gate fails and the retry names it.
      missing: task.expectedOutputs.filter((type) => !rewritten.has(type)),
      issues: second.issues,
      overBudget: second.overBudget,
      ...(second.filesChanged === undefined ? {} : { filesChanged: second.filesChanged }),
    };
    lastRunId = outcome.runId;
    assessed = this.#assess(task, harvest, null, scope, outcome.runId);
    if (!assessed.verdict.passed) break;
  }
  return { kind: 'harvest', harvest, assessed, lastRunId };
}
```

`completeTask` (`mission-service.ts`): artifacts get `round: task.round ?? 1`; after the artifacts are recorded, call `this.deps.rounds.onPersonCompleted(task, scope)` (`MissionDeps` gains `rounds: FeedbackRounds`).

- [ ] **Step 4:** `npm run build && node scratch/rounds-check.mjs && node scratch/handoff-check.mjs && node scratch/resume-check.mjs && node scripts/run-checks.mjs && npm run check:boundaries`. P1's tighten checks (b) and (g) must still pass.
- [ ] **Step 5:** commit `feat(engine): rounds continue their session, cite feedback, record inputs and take notes at the end of a pass`.

### Task 5: Reviews — Request changes, checks and AI review findings

**Files:**
- Modify: `packages/application/src/engine/reviews.ts` (options and effect copy on review and sign-off cards)
- Modify: `packages/application/src/services/approval-service.ts` (`request_changes`, reject-with-note compatibility, `needs_changes` on checks; `ApprovalDeps.remediation` → `rounds: FeedbackRounds`)
- Modify: `packages/application/src/engine/remediation.ts` (delete `planRevision`, `RevisionOutcome`, `#earlierFeedback`, `revisionObjective`, `mergeRequirements`; `#exhausted` becomes public `escalate`)
- Modify: `packages/application/src/engine/feedback-rounds.ts` (`fromReviewFindings`), `engine/scheduler.ts` (`#settled`)
- Modify: `packages/application/src/support/approval-view.ts` (`revisable` stays; it now means "Request changes starts a round")
- Modify: `scratch/feedback-loop-check.mjs:386-463` (the "reject with a note" section asserts `_revision_` clones; rewrite it to assert rounds), `scratch/staffing-check.mjs:1223-1229` (A8: "needs changes" now starts a round) and `:1425-1427` (C2: round instead of revision task)
- Modify: `scratch/rounds-check.mjs` (section "reviews")

**Interfaces consumed:** `FeedbackRounds.record`, `.startRound`, `.impactOf`, `.decideReviewCard` (Tasks 2–3), `reviewedTaskOf` (Task 2), `runActorOf` (`support/run-actor.ts`), `blockingFindings`, `MAX_REMEDIATION_CYCLES`, `REQUEST_CHANGES_OPTION`.

**Interfaces produced:**

```ts
// engine/feedback-rounds.ts
export type ReviewRouting =
  | { readonly kind: 'none' }                                            // no blocking findings, or no single reviewed task: today's fix-task flow
  | { readonly kind: 'round'; readonly reviewedTaskId: TaskId; readonly round: number; readonly items: number }
  | { readonly kind: 'exhausted'; readonly blocking: readonly Finding[] };
fromReviewFindings(review: MissionTask, mission: Mission): ReviewRouting;

// engine/remediation.ts
escalate(source: MissionTask, mission: Mission, blocking: readonly Finding[]): RemediationOutcome;   // was #exhausted

// Review and sign-off card options, in this order:
//   { id: APPROVE_OPTION, label: 'Approve', recommended: true }
//   { id: REQUEST_CHANGES_OPTION, label: 'Request changes' }
//   { id: REJECT_OPTION, label: 'Reject without changes' }
```

- [ ] **Step 1: failing section "reviews".** Add above the footer:

```js
section('reviews: request changes, checks and AI findings');
{
  const { mkdtempSync, mkdirSync } = await import('node:fs');
  const { execFileSync } = await import('node:child_process');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { systemClock, ids } = await import('@tandemise/shared');
  const { FAKE_ADAPTER_ID } = await import('@tandemise/runtime-generic');
  const D = await import('@tandemise/domain');
  const keepAlive = setInterval(() => {}, 1000);
  const HOME = mkdtempSync(join(tmpdir(), 'trv-'));
  const h = await engineHarness(HOME, 'rounds-reviews-check');
  const now = () => systemClock.now();
  const caller = { personId: h.services.identity.localPerson().id };
  const ws = (await h.services.workspaces.create(caller, { name: 'Reviews' })).workspace.id;
  const owner = h.services.team.me(caller).memberships.find((m) => m.workspaceId === ws).memberId;
  const task = (id) => h.repo.tasks.get(id);
  const settled = (id) => h.until(() => ['SUCCEEDED', 'FAILED', 'BLOCKED', 'AWAITING_APPROVAL', 'AWAITING_HUMAN'].includes(task(id).status), 20000);
  const byKey = (missionId) => Object.fromEntries(h.repo.tasks.listByMission(missionId).map((t) => [t.key, t]));
  const profile = (name, steps, extra = {}) => h.repo.profiles.create({
    id: ids.runtimeProfile(), workspaceId: null, adapterId: FAKE_ADAPTER_ID, name, executablePath: null, args: [],
    settings: { script: { steps, ...extra } }, capabilities: [], enabled: true, maxConcurrent: 4, createdAt: now(), updatedAt: now(),
  }).id;
  const doc = (type, front, changed) => ({
    kind: 'write-file', path: `.tandemise/out/${type}.md`,
    content: ['---', `type: ${type}`, `title: ${type}`, 'handoff:', `  headline: ${type} ready`,
      ...(changed ? ['  changed:', '    - what: "Fixed what the reviewer found"', '      feedback: "{{fb}}"'] : []), ...front, '---', '', `${type}.`].join('\n'),
  });
  const CHANGE = ['branch: b', 'commits: []', 'filesChanged: 1', 'testsRun: []', 'knownLimitations: []'];
  const IN_ROUND = { promptIncludes: 'Feedback to address' };
  const builder = profile('builder', [doc('ChangeSet', CHANGE), { ...doc('ChangeSet', CHANGE, true), when: IN_ROUND }, { kind: 'complete' }], { captures: { fb: '^\\d+\\. (fb_[0-9a-z]{20}) \\(' } });
  const blocking = ['verdict: fail', 'reviewedRef: HEAD', 'findings:', '  - severity: blocking', '    title: "The greeting ignores the name"', '    location: hello.txt'];
  const passing = ['verdict: pass', 'reviewedRef: HEAD', 'findings: []'];
  // Blocks until the ChangeSet it reads cites feedback; the later write wins.
  const reviewer = profile('reviewer', [doc('ReviewReport', blocking), { ...doc('ReviewReport', passing), when: { promptIncludes: 'feedback: "fb_' } }, { kind: 'complete' }]);
  const stubborn = profile('stubborn', [doc('ReviewReport', blocking), { kind: 'complete' }]);
  const agent = (name, profileId, roleIds) => h.services.team.addMember(caller, ws, { kind: 'agent', name, reportsTo: owner, roleIds, runtimeProfileIds: [profileId] }).id;
  const buildAgent = agent('Builder', builder, ['development']);
  const reviewAgent = agent('Review agent', reviewer, ['review']);
  const stubbornAgent = agent('Stubborn reviewer', stubborn, ['review']);

  let seq = 0;
  const addMission = async (defs) => {
    const mission = await h.services.missions.create(caller, { workspaceId: ws, goal: 'Ship the hello page', title: `R${++seq}` });
    const dir = h.paths.mission(ws, mission.id);
    mkdirSync(dir, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main', dir]);
    execFileSync('git', ['-C', dir, '-c', 'user.name=check', '-c', 'user.email=check@example.com', 'commit', '-q', '--allow-empty', '-m', 'init']);
    const t = {};
    for (const d of defs) {
      t[d.key] = h.repo.tasks.add({
        id: ids.task(), missionId: mission.id, key: d.key, title: d.key, objective: 'o', roleId: d.roleId, dependsOn: d.dependsOn ?? [],
        requiredCapabilities: [], inputArtifacts: d.inputArtifacts ?? [], expectedOutputs: d.expectedOutputs,
        executionPolicy: { isolation: 'none', maxWallTimeMs: 60000, capabilities: [] }, approvalPolicy: { beforeStart: false, onCompletion: false },
        retryPolicy: { maxAttempts: 2, backoffMs: 0, onExhausted: 'block' }, completionGate: d.completionGate ?? null,
        status: d.dependsOn ? 'PENDING' : 'READY', statusReason: null, attempts: 0, remediatesTaskId: null, repositoryId: null,
        executor: 'agent', waitPolicy: null, orderHint: d.order ?? 0, staffingOverride: d.staffing ?? null,
        createdAt: now(), updatedAt: now(), startedAt: null, finishedAt: null,
      }).id;
    }
    h.repo.missions.update(mission.id, { status: 'EXECUTING' });
    return { mission, t };
  };
  const blockingReview = [{ by: 'responsible', mode: 'blocking', when: 'always' }];

  // ---- C3: a blocking review card offers Request changes, and it starts a round of the same task
  {
    const { mission, t } = await addMission([{ key: 'build', roleId: 'development', expectedOutputs: ['ChangeSet'], staffing: { assignees: [buildAgent], reviews: blockingReview } }]);
    await settled(t.build);
    const [card] = h.repo.approvals.pendingForTask(t.build);
    check('C3: the card offers Approve, Request changes, Reject without changes', eq(card?.options.map((o) => [o.id, o.label]),
      [['approve', 'Approve'], ['request_changes', 'Request changes'], ['reject', 'Reject without changes']]), card?.options);
    check('C3: Request changes without a note is refused', await code(() => h.services.approvals.decide(caller, card.id, { optionId: 'request_changes' })) === 'VALIDATION');
    await h.services.approvals.decide(caller, card.id, { optionId: 'request_changes', note: 'Escape the visitor name' });
    check('C3: the same task is round 2 and no _revision_ task exists',
      task(t.build).round === 2 && task(t.build).status === 'READY' && Object.keys(byKey(mission.id)).every((k) => !k.includes('_revision_')), Object.keys(byKey(mission.id)));
    const item = h.repo.feedback.listByTask(t.build)[0];
    check('C3: the note is a feedback item in round 2', item?.text === 'Escape the visitor name' && item.status === 'in_round' && item.round === 2 && item.authorId === owner);
    await settled(t.build);
    check('C3: the review pipeline runs again for round 2', h.repo.approvals.pendingForTask(t.build).length === 1 && task(t.build).status === 'AWAITING_APPROVAL');
    const [again] = h.repo.approvals.pendingForTask(t.build);
    await h.services.approvals.decide(caller, again.id, { optionId: 'reject' });
    check('Reject without changes blocks the task', task(t.build).status === 'BLOCKED', task(t.build).statusReason);
  }

  // ---- a card from before P2 (approve/reject only): reject with a note is a round too
  {
    const { t } = await addMission([{ key: 'legacy', roleId: 'development', expectedOutputs: ['ChangeSet'], staffing: { assignees: [buildAgent], reviews: blockingReview } }]);
    await settled(t.legacy);
    const [card] = h.repo.approvals.pendingForTask(t.legacy);
    h.repo.approvals.update(card.id, { options: [{ id: 'approve', label: 'Approve' }, { id: 'reject', label: 'Reject' }] });
    await h.services.approvals.decide(caller, card.id, { optionId: 'reject', note: 'Tighten the copy.' });
    check('legacy card: reject with a note starts round 2', task(t.legacy).round === 2 && task(t.legacy).status === 'READY');
  }

  // ---- a check's "Needs changes" becomes feedback (spec §10)
  {
    const after = [{ by: 'responsible', mode: 'after', when: 'always' }];
    const { t } = await addMission([{ key: 'arch', roleId: 'development', expectedOutputs: ['ChangeSet'], staffing: { assignees: [buildAgent], reviews: after } }]);
    await settled(t.arch);
    const [check1] = h.repo.approvals.pendingForTask(t.arch);
    await h.services.approvals.decide(caller, check1.id, { optionId: 'needs_changes', note: 'Split the service boundary.' });
    check('needs changes with no consumers starts round 2', task(t.arch).round === 2 && task(t.arch).status === 'READY' && h.repo.feedback.listByTask(t.arch)[0]?.status === 'in_round');
  }

  // ---- C7: blocking findings from an AI reviewer become feedback and a round; the review is redone and passes
  {
    const { mission, t } = await addMission([
      { key: 'build', roleId: 'development', expectedOutputs: ['ChangeSet'], staffing: { assignees: [buildAgent] } },
      { key: 'review', roleId: 'review', dependsOn: ['build'], order: 1, expectedOutputs: ['ReviewReport'], inputArtifacts: [{ type: 'ChangeSet', required: true }], completionGate: 'artifact.ReviewReport.exists', staffing: { assignees: [reviewAgent] } },
    ]);
    await h.until(() => h.repo.feedback.listByTask(t.build).length > 0, 20000);
    const [finding] = h.repo.feedback.listByTask(t.build);
    check('C7: the finding is a feedback item on build, authored by the review agent and recorded by the engine',
      finding?.authorId === reviewAgent && finding.recordedBy === D.SYSTEM_ACTOR && /The greeting ignores the name/.test(finding.text), finding);
    check('C7: build started round 2 and review waits to be redone', task(t.build).round === 2 && task(t.review).status === 'PENDING', [task(t.build).status, task(t.review).status]);
    await h.until(() => task(t.review).status === 'SUCCEEDED' && h.repo.runs.listByTask(t.review).length === 2, 30000);
    check('C7: the redone review passes and no fix task was planned', !Object.keys(byKey(mission.id)).some((k) => k.startsWith('fix_')) && h.repo.feedback.get(finding.id).status === 'addressed', Object.keys(byKey(mission.id)));
  }

  // ---- the cap: after three AI-started rounds the review escalates instead of a fourth
  {
    const { mission, t } = await addMission([
      { key: 'build', roleId: 'development', expectedOutputs: ['ChangeSet'], staffing: { assignees: [buildAgent] } },
      { key: 'review', roleId: 'review', dependsOn: ['build'], order: 1, expectedOutputs: ['ReviewReport'], inputArtifacts: [{ type: 'ChangeSet', required: true }], completionGate: 'artifact.ReviewReport.exists', staffing: { assignees: [stubbornAgent] } },
    ]);
    await h.until(() => h.repo.approvals.list({ missionId: mission.id, statuses: ['PENDING'] }).some((a) => a.kind === 'intervention'), 60000);
    check('cap: build reached round 4 (three AI rounds) and no further', task(t.build).round === 1 + h.app.MAX_REMEDIATION_CYCLES, task(t.build).round);
    check('cap: the mission is blocked on an intervention card', h.repo.missions.get(mission.id).status === 'BLOCKED');
  }

  // ---- QA defects keep the fix-task flow
  {
    const qaReport = ['results:', '  - criterion: AC1', '    outcome: FAIL', '    evidence: seen', 'blockingDefects: 1'];
    const qa = agent('QA agent', profile('qa', [doc('QAReport', qaReport), { kind: 'complete' }]), ['qa']);
    const { mission } = await addMission([
      { key: 'build', roleId: 'development', expectedOutputs: ['ChangeSet'], staffing: { assignees: [buildAgent] } },
      { key: 'qa', roleId: 'qa', dependsOn: ['build'], order: 1, expectedOutputs: ['QAReport'], completionGate: 'artifact.QAReport.exists', staffing: { assignees: [qa] } },
    ]);
    await h.until(() => Object.keys(byKey(mission.id)).some((k) => k.startsWith('fix_qa_')), 20000);
    check('QA: a blocking defect still becomes fix_ and recheck tasks, and no feedback', Object.keys(byKey(mission.id)).includes('qa_recheck_1') && h.repo.feedback.listByMission(mission.id).length === 0);
  }

  await h.container.dispose();
  clearInterval(keepAlive);
}
```

- [ ] **Step 2:** `npm run build && node scratch/rounds-check.mjs` fails.

- [ ] **Step 3: implement.**

`reviews.ts`, in `#createReview` and `#createSignOff`:

```ts
options: [
  { id: APPROVE_OPTION, label: 'Approve', recommended: true },
  { id: REQUEST_CHANGES_OPTION, label: 'Request changes' },
  { id: REJECT_OPTION, label: 'Reject without changes' },
],
recommendedOptionId: APPROVE_OPTION,
effect: 'Approving releases every task that depends on this one. Request changes sends it back to '
  + `${roleName} as its next round, with your note as the brief. Reject without changes leaves it blocked.`,
```

`approval-service.ts`:

```ts
// in decide(), before anything is written:
if (option.id === REQUEST_CHANGES_OPTION && (request.note ?? '').trim().length === 0) {
  throw TandemiseError.validation('Say what should change: the note is the brief for the next round.', { optionId: option.id });
}
// …and pass recordedBy on: this.#resumeTask(decided, approved, actorId, recordedBy)

// in #resumeTask, replacing the planRevision block:
const note = approval.decisionNote?.trim() ?? '';
// Request changes, or a reject with a note on a card from before it existed: the same task goes again.
if (approval.selectedOptionId === REQUEST_CHANGES_OPTION || note.length > 0) {
  const item = this.deps.rounds.record({ task, text: note, artifactId: null, authorId: actorId, recordedBy, status: 'open', round: null });
  this.deps.rounds.startRound({ task, feedbackIds: [item.id], downstream: 'none', actorId, keepCardId: approval.id });
  return;
}
this.#setTaskStatus(task, scope, 'BLOCKED',
  'Rejected without changes, so nothing was re-run. Request changes with a note, or retry the task, to run it again.');
this.#setMissionStatus(mission, scope, 'BLOCKED', `The output of '${task.key}' was rejected.`);

// #resumeCheck(approval, task, mission, actorId, recordedBy), replacing the flag-only body:
if (approval.selectedOptionId !== NEEDS_CHANGES_OPTION) return;
const scope: EventScope = { workspaceId: mission.workspaceId, missionId: mission.id, taskId: task.id, roleId: task.roleId, actorId };
const note = approval.decisionNote?.trim() ?? '';
if (note.length === 0) {
  // Nothing to brief a round with: keep P0's flag so the task still stands out.
  this.deps.tasks.update(task.id, { needsAttention: true });
  this.deps.recorder.record(scope, { type: 'task.attention', taskId: task.id, note: '' });
  return;
}
const item = this.deps.rounds.record({ task, text: note, artifactId: null, authorId: actorId, recordedBy, status: 'open', round: null });
// Work that used this output may need redoing; that is the person's call, made in the impact dialog (GET /v1/tasks/:id/feedback).
if (this.deps.rounds.impactOf(task).consumers.length === 0 && ROUND_START_STATUSES.includes(task.status)) {
  this.deps.rounds.startRound({ task, feedbackIds: [item.id], downstream: 'none', actorId, keepCardId: approval.id });
}
```

`FeedbackRounds.fromReviewFindings`:

```ts
fromReviewFindings(review: MissionTask, mission: Mission): ReviewRouting {
  const { deps } = this;
  const evaluation = [...deps.evaluations.listEvaluations(review.id)].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1);
  const blocking = evaluation === undefined ? [] : blockingFindings(evaluation);
  if (blocking.length === 0) return { kind: 'none' };
  const reviewed = reviewedTaskOf(review, deps.tasks.listByMission(mission.id), deps.artifacts.listByMission(mission.id));
  if (reviewed === null || !ROUND_START_STATUSES.includes(reviewed.status)) return { kind: 'none' };
  // The bound counts rounds an agent started, so a person's rounds never use up the reviewer's.
  const aiRounds = new Set(deps.feedback.listByTask(reviewed.id).filter((i) => i.round !== null && this.#isAgent(i.authorId)).map((i) => i.round)).size;
  if (aiRounds >= MAX_REMEDIATION_CYCLES) return { kind: 'exhausted', blocking };
  const author = runActorOf(deps.runs, { runId: evaluation!.runId, taskId: review.id }, review) ?? RUNTIME_ACTOR;
  const items = blocking.map((f) => this.record({
    task: reviewed, artifactId: null, authorId: author, recordedBy: SYSTEM_ACTOR, status: 'open', round: null,
    text: summarize(`${f.title}${f.location ? ` (${f.location})` : ''}${f.detail.trim() ? `: ${f.detail.trim()}` : ''}${f.suggestedFix ? ` Suggested fix: ${f.suggestedFix}` : ''}`, FEEDBACK_TEXT_MAX),
  }));
  // The reviewer asked for it, so everything that used the old version is redone without asking, the review included.
  const reopened = this.startRound({ task: reviewed, feedbackIds: items.map((i) => i.id), downstream: 'redo', actorId: author });
  return { kind: 'round', reviewedTaskId: reviewed.id, round: reopened.round ?? 2, items: items.length };
}

#isAgent(id: string): boolean {
  return id === RUNTIME_ACTOR || this.deps.members.get(asId<'MemberId'>(id))?.kind === 'agent';
}
```

`scheduler.ts#settled`, replacing the remediation call:

```ts
const current = this.deps.missions.get(mission.id) ?? mission;
if (settledTask.expectedOutputs.includes('ReviewReport')) {
  const routed = this.deps.rounds.fromReviewFindings(settledTask, current);
  if (routed.kind === 'round') {
    this.deps.log.info('scheduler.review_round', { missionId: mission.id, reviewed: routed.reviewedTaskId, round: routed.round, findings: routed.items });
    this.wake();
    return;
  }
  if (routed.kind === 'exhausted') {
    this.deps.remediation.escalate(settledTask, current, routed.blocking);
    return;
  }
}
const planned = this.deps.remediation.plan(settledTask, current);
```

`remediation.ts`: delete the revision code listed above; rename `#exhausted` → `escalate` (public, same body); `plan()` keeps its own cap for QA chains.

Fixture updates:
- `feedback-loop-check.mjs` "reject with a note" section: keep the fixture tasks and completion cards; assert instead that after `decide(REJECT_OPTION, note)` the same `design` task is `READY` with `round === 2`, no `design_revision_1` exists, `build.dependsOn` is still `["design"]`, a feedback item holds the note verbatim, and a second rejection after `repo.tasks.update(design.id, { status: 'AWAITING_APPROVAL' })` makes round 3 with the round-2 item still `in_round` or `addressed`. Approving then succeeds the task and spawns nothing.
- `staffing-check.mjs` A8: the note starts round 2 of `arch` (its only dependent is a human step with no run, so there are no consumers); assert `task(t.arch).round === 2` and a feedback item, instead of `needsAttention`.
- `staffing-check.mjs` C2: find no `revised_revision_1`; assert `task(t.revised).round === 2 && task(t.revised).needsAttention === false` and the feedback item's `authorId === ana.id`, `recordedBy === owner`.

- [ ] **Step 4:** `npm run build && node scratch/rounds-check.mjs && node scratch/feedback-loop-check.mjs && node scratch/staffing-check.mjs && node scripts/run-checks.mjs && npm run check:boundaries`.
- [ ] **Step 5:** commit `feat(reviews): request changes starts a round, and AI review findings become feedback`.

### Task 6: Desktop — Request changes, impact dialog, rounds on cards, reader versions, feedback thread

**Files:**
- Create: `apps/desktop/src/renderer/src/components/RequestChanges.tsx`, `components/ImpactDialog.tsx`, `lib/line-diff.ts`
- Modify: `components/HandoffCard.tsx`, `components/Decision.tsx`, `screens/mission/FeedPane.tsx`, `screens/mission/TaskDetail.tsx`, `screens/artifacts/ArtifactReader.tsx`, `screens/approvals/ApprovalCard.tsx`, `screens/Inbox.tsx`
- Modify: `lib/daemon.ts`, `lib/queries.ts`, `lib/events.ts`, `lib/domain.ts`, `styles/features.css`
- Modify: `scratch/acceptance/p0/scripted-agent.mjs` (handed to this task for the harness screenshots; the full mode set is written here so Task 7 only adds scenarios)

**Interfaces consumed:** `FeedbackView`, `FeedChange`, `DownstreamImpactView`, `FeedbackGivenView`, `TaskFeedbackView`, `FeedCard.{round,openFeedback,changed,canRequestChanges}`, `TaskView.{round,feedback}`, `ArtifactReadView.{round,versions,changes}` (Task 3); `REQUEST_CHANGES_OPTION` (mirrored in `lib/domain.ts`); `RecordingFor`, `behalfOf`, `defaultRecordFor`, `useActors`, `Modal`, `useDaemonMutation`.

**Interfaces produced:**

```ts
// lib/daemon.ts
giveFeedback(taskId: string, body: GiveFeedbackRequest): Promise<FeedbackGivenView>;        // POST /tasks/:id/feedback
startRound(taskId: string, body: StartRoundRequest): Promise<TaskView>;                   // POST /tasks/:id/rounds
taskFeedback(taskId: string): Promise<TaskFeedbackView>;                                  // GET  /tasks/:id/feedback
dismissFeedback(id: string, body?: { onBehalfOf?: string }): Promise<FeedbackView>;       // POST /feedback/:id/dismiss
// retryTask keeps its signature; the note is now sent from TaskDetail.

// lib/queries.ts
keys.taskFeedback = (id: string) => ['mission-task-feedback', id] as const;   // invalidated with the 'tasks' topic
export function useTaskFeedback(taskId: string | null): UseQueryResult<TaskFeedbackView>;

// components/RequestChanges.tsx
export function RequestChangesButton(props: { taskId: string; taskTitle: string; missionId: string; outputs?: readonly { id: string; label: string }[]; variant?: 'ghost' | 'default' }): JSX.Element;
export function RequestChangesComposer(props: { taskId: string; taskTitle: string; missionId: string; outputs: readonly { id: string; label: string }[]; onClose: () => void }): JSX.Element;
// components/ImpactDialog.tsx
export function ImpactDialog(props: { impact: DownstreamImpactView; missionId: string; recordFor: string | null; onClose: () => void }): JSX.Element;
// lib/line-diff.ts
export type DiffLine = { readonly kind: 'same' | 'added' | 'removed'; readonly text: string };
export function lineDiff(before: string, after: string): readonly DiffLine[];
```

**Requirements (spec §6):**
- **Composer:** one textarea labelled "What should change?", "Recording for" (P0 rule; `RecordingFor` already renders nothing for a solo owner), optional "About" select (the whole task, or one output). Submit calls `giveFeedback`. If the response carries `impact` with dependents, the composer closes and `ImpactDialog` opens. Otherwise it closes with a one-line notice: "Round N started", or "Queued: delivered when the current pass ends", or "Added to the task".
- **Impact dialog:** heading "`<Build (done), Review (running)>` used `<Design>` v`<n>`"; options "Redo them after the new version" and "Keep their work", defaulting to `impact.defaultChoice`; one checkbox per dependent (all checked). Confirm calls `startRound` with `feedbackIds: impact.feedbackIds`, `downstream`, and `redoTaskIds` = the checked ones. No dependents: never shown.
- **Feed card** (`HandoffCard`): a "Round N" badge when `round > 1`; under the headline, "What changed" lists `card.changed` (≤ 3), each "what · Author" and a "Declined" chip for declines, also on needs_you cards; "N notes pending" (`openFeedback.length`) with the latest note's text on one line, and "Start round" when `FeedbackView` items are `open` and the task can start one (it opens `ImpactDialog` from `useTaskFeedback(taskId).pendingImpact`); "Request changes" in the actions when `card.canRequestChanges`. Still ≤ 8 visible lines; the pending line replaces the points when both would overflow. Never an `fb_` id.
- **Inbox and approval cards:** the options come from the daemon ("Request changes", "Reject without changes"). In `copyFor`, `request_changes` is `noteRequired: true` with placeholder "What should change? It goes back as the next round, using exactly what you write."; it is not destructive and not confirmed. "Reject without changes" keeps the confirm step and the danger style. After deciding `needs_changes` on a check, `useApprovalDecision` reads `taskFeedback(taskId)`; when `pendingImpact` has dependents it opens `ImpactDialog`.
- **Reader:** "Request changes" in the header for an artifact with a `taskId` ("About" preset to this output). A version switcher (`v1 … vN` from `view.versions`) that opens that version in the reader. "Changes in vN" replaces P1's "Changed": each change expands to the note text and its author; declines are marked. A "Compare with vN-1" toggle shows `lineDiff` of the two bodies (front matter stripped), added lines and removed lines styled with `--status-succeeded-soft` and `--status-failed-soft`.
- **Task drawer:** "Feedback" section, a flat list grouped by round ("Round 2", "Waiting for a round", "Dismissed"), each item's author, text, status chip, and "Dismiss" for open or queued items. "Request changes" in the footer when the task can take feedback (not a wait step). "Retry with a note": a textarea under the Retry button for FAILED and BLOCKED; with text, the button reads "Retry with this note" and sends `retryTask(task.id, { note })`.
- **Timeline** (`lib/events.ts`): `feedback.given` → "`<actor>` asked for changes" with the excerpt; `feedback.addressed` → "Round N answered a note" or "Round N declined a note"; `feedback.dismissed` → "A note was dismissed"; `task.round_started` → "Round N started", detail "Redone: build, review" when `redone` is non-empty.
- Tokens only; `npm run check:design` must pass.

- [ ] **Step 1: `lib/line-diff.ts`** (pure, small inputs: artifact bodies are capped by the word budgets):

```ts
/**
 * A line diff by longest common subsequence. Artifact bodies are a few hundred
 * lines at most, so the quadratic table is cheaper than a dependency.
 */
export function lineDiff(before: string, after: string): readonly DiffLine[] {
  const a = before.split('\n');
  const b = after.split('\n');
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { out.push({ kind: 'same', text: a[i]! }); i++; j++; }
    else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) out.push({ kind: 'removed', text: a[i++]! });
    else out.push({ kind: 'added', text: b[j++]! });
  }
  while (i < a.length) out.push({ kind: 'removed', text: a[i++]! });
  while (j < b.length) out.push({ kind: 'added', text: b[j++]! });
  return out;
}
```

- [ ] **Step 2: the composer and the dialog.**

```tsx
// components/RequestChanges.tsx
export function RequestChangesComposer({ taskId, taskTitle, missionId, outputs, onClose }: {
  taskId: string; taskTitle: string; missionId: string; outputs: readonly { id: string; label: string }[]; onClose: () => void;
}): JSX.Element {
  const actors = useActors();
  const [text, setText] = useState('');
  const [about, setAbout] = useState<string>('');
  const [recordFor, setRecordFor] = useState<string | null>(defaultRecordFor(actors, null));
  const [impact, setImpact] = useState<DownstreamImpactView | null>(null);
  const give = useDaemonMutation(
    (daemon) => daemon.giveFeedback(taskId, { text: text.trim(), ...(about ? { artifactId: about } : {}), ...behalfOf(actors, recordFor) }),
    ['tasks', 'missions', 'approvals', 'artifacts'],
    missionId,
  );
  if (impact !== null) return <ImpactDialog impact={impact} missionId={missionId} recordFor={recordFor} onClose={onClose} />;
  const tooLong = text.trim().length > 4000;
  return (
    <Modal
      title={`Request changes to ${taskTitle}`}
      onClose={onClose}
      footer={
        <>
          <RecordingFor actors={actors} value={recordFor} onChange={setRecordFor} />
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={text.trim() === '' || tooLong || give.isPending}
            onClick={() => give.mutate(undefined, {
              // A finished task whose output was used waits for the person's choice about that work.
              onSuccess: (given) => (given.impact !== null && given.impact.dependents.length > 0 ? setImpact(given.impact) : onClose()),
            })}
          >
            {give.isPending ? 'Sending…' : 'Request changes'}
          </button>
        </>
      }
    >
      <div className="stack" style={{ gap: 'var(--s3)' }}>
        <label className="field">
          <span className="field__label">What should change?</span>
          <textarea className="textarea" rows={5} value={text} onChange={(e) => setText(e.target.value)} autoFocus />
          {tooLong ? <span className="field__error">At most 4000 characters.</span> : null}
        </label>
        {outputs.length > 1 ? (
          <label className="field">
            <span className="field__label">About</span>
            <select className="select" value={about} onChange={(e) => setAbout(e.target.value)}>
              <option value="">The whole task</option>
              {outputs.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
            </select>
          </label>
        ) : null}
        {give.isError ? <ErrorState error={give.error} /> : null}
      </div>
    </Modal>
  );
}
```

```tsx
// components/ImpactDialog.tsx
export function ImpactDialog({ impact, missionId, recordFor, onClose }: {
  impact: DownstreamImpactView; missionId: string; recordFor: string | null; onClose: () => void;
}): JSX.Element {
  const actors = useActors();
  const [choice, setChoice] = useState<'redo' | 'keep'>(impact.defaultChoice);
  const [picked, setPicked] = useState<readonly string[]>(impact.dependents.map((d) => d.taskId));
  const start = useDaemonMutation(
    (daemon) => daemon.startRound(impact.taskId, {
      feedbackIds: impact.feedbackIds, downstream: choice,
      ...(choice === 'redo' ? { redoTaskIds: picked } : {}), ...behalfOf(actors, recordFor),
    }),
    ['tasks', 'missions', 'approvals'],
    missionId,
  );
  const used = impact.dependents.map((d) => `${titleCase(d.title)} (${d.running ? 'running' : humanizeStatus(d.status).toLowerCase()})`).join(', ');
  const version = Math.max(...impact.dependents.map((d) => d.usedVersion));
  return (
    <Modal
      title={`Round ${impact.nextRound} of ${impact.taskTitle}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Not now</button>
          <button type="button" className="btn btn--primary" disabled={start.isPending || (choice === 'redo' && picked.length === 0)}
            onClick={() => start.mutate(undefined, { onSuccess: onClose })}>
            {start.isPending ? 'Starting…' : `Start round ${impact.nextRound}`}
          </button>
        </>
      }
    >
      <div className="stack impact" style={{ gap: 'var(--s3)' }}>
        <p className="impact__used">{used} used {impact.taskTitle} v{version}.</p>
        <label className="row impact__choice"><input type="radio" checked={choice === 'redo'} onChange={() => setChoice('redo')} /> Redo them after the new version</label>
        {choice === 'redo' ? (
          <ul className="impact__list">
            {impact.dependents.map((d) => (
              <li key={d.taskId}>
                <label className="row">
                  <input type="checkbox" checked={picked.includes(d.taskId)}
                    onChange={(e) => setPicked(e.target.checked ? [...picked, d.taskId] : picked.filter((id) => id !== d.taskId))} />
                  {d.title}
                </label>
              </li>
            ))}
          </ul>
        ) : null}
        <label className="row impact__choice"><input type="radio" checked={choice === 'keep'} onChange={() => setChoice('keep')} /> Keep their work (they are flagged when the new version lands)</label>
        {start.isError ? <ErrorState error={start.error} /> : null}
      </div>
    </Modal>
  );
}
```

- [ ] **Step 3:** the card, drawer, reader, decision and timeline changes above; CSS in `features.css` for `.feedcard__round`, `.feedcard__changed-list`, `.feedcard__pending`, `.impact__*`, `.feedback-thread__*`, `.reader__versions`, `.diff__line--added` (`background: var(--status-succeeded-soft)`), `.diff__line--removed` (`background: var(--status-failed-soft)`), spacing with `--s*` only.

- [ ] **Step 4: scripted agent modes** (`scratch/acceptance/p0/scripted-agent.mjs`). Keep every P1 mode. Add, after `prompt` is read:

```js
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
if (process.env.SCRIPTED_PROMPT_DIR) {
  mkdirSync(process.env.SCRIPTED_PROMPT_DIR, { recursive: true });
  writeFileSync(join(process.env.SCRIPTED_PROMPT_DIR, `${Date.now()}-${process.pid}.txt`), prompt);
}
if (SLOW) await new Promise((r) => setTimeout(r, 20_000));
if (FAIL_UNTIL_NOTE) { console.log('SCRIPTED_FAIL_UNTIL_NOTE: nothing written'); process.exit(0); }

const cite = OMIT_ONCE ? feedbackItems.slice(0, -1) : feedbackItems;
const changed = !inRound ? [] : DECLINE
  ? [{ what: 'Declined: the scripted agent keeps the page as it is', feedback: feedbackItems.map((f) => f.id).join(', ') }]
  : [{ what: `Applied: ${feedbackItems[0].text}`.slice(0, 140), ...(cite.length > 0 ? { feedback: cite.map((f) => f.id).join(', ') } : {}) }];
```

In the output loop: `handoff.changed = changed` when non-empty; the body gains `Round notes:\n${feedbackItems.map((f) => `- ${f.text}`).join('\n')}` when `inRound`; `FRONT.ReviewReport` is `{ verdict: 'fail', reviewedRef: 'HEAD', findings: [{ severity: 'blocking', title: 'The greeting ignores the visitor name', location: 'hello.txt' }] }` when `REVIEW_BLOCKING`; for a `ChangeSet`, append `round ${inRound ? feedbackItems.map((f) => f.id).join(',') : 'first'}\n` to `join(workIn, 'hello.txt')` (`appendFileSync`) and set `filesChanged: 1`, so a round leaves a commit on the task's branch.

- [ ] **Step 5: verify.** `npm run -w @tandemise/desktop typecheck && npm run check:design && npm run check:boundaries`. Then visually, with the harness: `node scratch/acceptance/p0/setup.mjs /tmp/tdm-p2a` (after Task 7 Step 1's setup change, or copy `p2-solo.yaml` into the project by hand), launch the desktop as `run-all.mjs` does on CDP port 9337, run a solo mission, request changes from the feed card, and screenshot: the composer, a Round 2 card with "What changed", "1 note pending" on a running card, the impact dialog on a chain mission, the reader's version switcher with "Changes in v2" and the comparison, the drawer's feedback thread, "Retry with a note". Save to `.superpowers/sdd/p2/task-6-shots/` and read every PNG.
- [ ] **Step 6:** commit `feat(desktop): request changes, impact dialog, rounds on cards, reader versions and feedback threads`.

### Task 7: Real-app acceptance C1–C12, with full P0 and P1 regressions (controller)

The controller runs this in the main session, on a fresh install, in one uninterrupted run per suite. Findings are fixed through dispatched fixes on the branch and the affected suite is run again from the start. Evidence is committed to `docs/superpowers/evidence/2026-09-14-p2/`.

**Files:**
- Create: `scratch/acceptance/p0/workflows/p2-solo.yaml`, `p2-chain.yaml`
- Create: `scratch/acceptance/p2/suite/c01-tweak-doc.mjs`, `c02-dependents.mjs`, `c03-review-request-changes.mjs`, `c04-note-while-running.mjs`, `c05-c06-notes-and-citations.mjs`, `c07-ai-reviewer.mjs`, `c08-person-step.mjs`, `c09-decline.mjs`, `c10-real-claude.mjs`, `c11-code-round.mjs`, `c12-retry-blocked.mjs`
- Modify: `scratch/acceptance/p0/setup.mjs` (copy every `workflows/*.yaml`; daemon env `SCRIPTED_PROMPT_DIR=<scratch>/prompts`), `p0/run-all.mjs` (`--p2`; C ids in `order`), `p0/lib/ctx.mjs` (helpers below)
- Modify: `scratch/acceptance/p0/suite/s03-team-mission.mjs` (A8 per spec §10)

**Interfaces consumed:** everything above; `context()`, `Evidence`, `page.*` from `scratch/acceptance/p0/lib/`.

- [ ] **Step 1: harness.**

```yaml
# p2-solo.yaml
name: P2 solo
description: One document task and nothing downstream, for rounds without dependents.
steps:
  - key: doc
    role: product
    objective: Write a short spec for a hello page.
    outputs: [ProductSpec]
```

```yaml
# p2-chain.yaml
name: P2 chain
description: A design, a build that uses it, and an independent review of the build.
steps:
  - key: design
    role: design
    objective: Design the hello page.
    outputs: [DesignBrief]
  - key: build
    role: development
    dependsOn: [design]
    objective: Build the hello page.
    inputs: [DesignBrief]
    outputs: [ChangeSet]
  - key: review
    role: review
    dependsOn: [build]
    objective: Review the build against the design.
    inputs: [ChangeSet]
    gate: review.blocking_findings == 0
    outputs: [ReviewReport]
```

(`inputs`, `gate` and `outputs` are the step keys `packages/domain/src/workflow.ts` accepts.)

`setup.mjs`: replace the single `copyFileSync` with a loop over `readdirSync(join(here, 'workflows')).filter((f) => f.endsWith('.yaml'))`, for a project that already exists too (copy, then commit only when `git status --porcelain` is non-empty); pass `SCRIPTED_PROMPT_DIR: join(scratch, 'prompts')` in the daemon env.

`ctx.mjs` additions:

```js
/** New mission on a named workflow; the title is the goal, so mode names in it reach the scripted agent. */
async createMission(title, { workflow = 'P0 acceptance' } = {}) { /* as today, with page.select('Workflow', workflow) */ },

/** Opens the composer from a feed card's "Request changes", types the note, optionally records it for someone, sends. */
async requestChangesOnCard(missionId, cardKey, note, { recordingFor } = {}) {
  await page.navigate(`#/missions/${missionId}`); await sleep(1500);
  const opened = await page.evaluate(`(() => { const card = document.querySelector('[data-feed-card=${JSON.stringify(cardKey)}]'); const b = card && [...card.querySelectorAll('button')].find((x) => x.innerText.trim() === 'Request changes'); if (!b) return false; b.click(); return true; })()`);
  if (!opened) throw new Error(`no Request changes on card ${cardKey}`);
  await page.fill('What should change?', note);
  if (recordingFor) await page.select('Recording for', recordingFor);
  await page.click('Request changes', { within: '[role=dialog]' });
  await sleep(800);
},

feedback: async (taskId) => api.get(`/v1/tasks/${taskId}/feedback`),
prompts: () => readdirSync(`${SCRATCH}/prompts`).sort().map((f) => readFileSync(`${SCRATCH}/prompts/${f}`, 'utf8')),
```

`run-all.mjs`: `const P2 = process.argv.includes('--p2');` with scenarios `['../../p2/suite/c01-tweak-doc.mjs'] … ['../../p2/suite/c12-retry-blocked.mjs']` in order C1–C12, `c10` skipped under `--skip-claude`; add `'C1'…'C12'` to the head of `order`; the report title reads `P2` under the flag.

- [ ] **Step 2: scenarios.** Each scenario creates its missions with a unique title, drives the desktop over CDP for every gesture under test (API calls only for setup and for reading state), saves screenshots, and cancels its missions at the end. Every check below is an `ev.check`.

`c01-tweak-doc.mjs` (C1). The scripted agent cannot continue a session (generic CLI has no `session_resume`), so C1 runs on the daemon's built-in fake runtime, which declares it, with a script that cites the numbered notes:

```js
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
const c = await context();
const { page, api, env, sleep, until } = c;
const ev = new Evidence('C1', 'Tweak a finished doc: round 2 continues the session and cites the note');
const spec = (headline, changed) => ['---', 'type: ProductSpec', 'title: Hello spec', 'handoff:', `  headline: ${headline}`,
  ...(changed ? ['  changed:', '    - what: "Shortened the intro"', '      feedback: "{{fb}}"'] : []),
  'acceptanceCriteria:', '  - id: AC1', '    statement: The page greets the visitor.', 'nonGoals: []', '---', '', `# Hello\n\n${headline}.`].join('\n');
const fake = await api.post('/v1/runtimes', { adapterId: 'fake', name: `Fake rounds ${Date.now().toString(36)}`, workspaceId: null, enabled: true, maxConcurrent: 2,
  settings: { script: { captures: { fb: '^\\d+\\. (fb_[0-9a-z]{20}) \\(' }, steps: [
    { kind: 'checkpoint', sessionId: 'c1-session', label: 'session.init' },
    { kind: 'write-file', path: '.tandemise/out/ProductSpec.md', content: spec('A hello page with a long intro') },
    { kind: 'write-file', path: '.tandemise/out/ProductSpec.md', content: spec('A hello page with a short intro', true), when: { promptIncludes: 'Feedback to address' } },
    { kind: 'complete', summary: 'done' },
  ] } } });
const fakeId = (fake.profile ?? fake).id;
const writer = (await api.post(`/v1/workspaces/${env.workspaceId}/members`, { kind: 'agent', name: `C1 writer ${Date.now().toString(36)}`, reportsTo: c.me, roleIds: ['product'], runtimeProfileIds: [fakeId] })).id;
await api.patch(`/v1/workspaces/${env.workspaceId}/staffing`, { product: { assignees: [writer], reviews: [] } });

const title = `C1 tweak ${Date.now().toString(36)}`;
const missionId = await c.createMission(title, { workflow: 'P2 solo' });
await c.approvePlan(missionId, title);
const doc = await until(async () => { const t = await c.task(missionId, 'doc'); return t.status === 'SUCCEEDED' && t; }, { label: 'doc done', timeoutMs: 60_000 });
await c.requestChangesOnCard(missionId, 'doc', 'Shorter intro');
ev.check('no dependents: no impact dialog opened', !(await page.text('body')).includes('used Hello'));
const done2 = await until(async () => { const t = await c.task(missionId, 'doc'); return t.round === 2 && t.status === 'SUCCEEDED' && t; }, { label: 'round 2 done', timeoutMs: 60_000 });
const thread = await c.feedback(doc.id);
ev.check('the note is addressed in round 2', thread.items[0]?.status === 'addressed' && thread.items[0].round === 2, thread.items);
ev.check('round 2 ran on the same session', done2.latestRun?.purpose === 'round' && done2.latestRun.round === 2 && done2.latestRun.externalSessionId === 'c1-session', done2.latestRun);
await page.navigate(`#/missions/${missionId}`); await sleep(1500);
const card = await page.evaluate(`document.querySelector('[data-feed-card="doc"]')?.innerText ?? ''`);
ev.check('the card shows Round 2 and What changed citing the note\'s author', /Round 2/.test(card) && /Shortened the intro/.test(card) && !/fb_/.test(card), card);
await page.screenshot(ev.shot('card-round-2'));
await api.post(`/v1/missions/${missionId}/cancel`, { reason: 'acceptance: C1 proven' });
c.close(); ev.save();
```

The rest, each with the same shape:

| File | Setup | Gestures (desktop) | Checks |
|---|---|---|---|
| `c02-dependents.mjs` (C2) | `P2 chain`, scripted agents for design, development, review; no reviews | Mission 1: when build SUCCEEDED, Request changes on the design card → impact dialog → "Redo them after the new version" → Start round. Mission 2: same, "Keep their work" | Dialog text lists `Build (done)` and says "used … v1"; redo: build goes PENDING with "Redone after design round 2", reruns, its latest run's inputs (via the task drawer's timeline or `GET /v1/missions/:id/artifacts` plus the round-2 run) used design v2; keep: build stays SUCCEEDED, then shows needsAttention and a timeline line "Built against design v1; v2 is out." once design round 2 lands. Screenshots: dialog, redo feed, keep flag |
| `c03-review-request-changes.mjs` (C3) | `P2 solo`, product staffed with a blocking review by the responsible person | Inbox → "Approve the output of doc?" → option "Request changes" with a note → send | Same task id, `round === 2`, `GET /v1/missions/:id/tasks` has no key containing `_revision_`, card REJECTED with `selectedOptionId === 'request_changes'`, a second review card for round 2 appears. Screenshot: Inbox card with the three options |
| `c04-note-while-running.mjs` (C4) | `P2 solo`, title includes `SCRIPTED_SLOW_20S` | While doc is RUNNING (≤ 20 s), Request changes on its card "Mention the pricing page" | Right after sending, the card shows "1 note pending" and the item is `queued`; after it settles: `attempts === 1`, `round === 1`, the task's runs are exactly two with the second `purpose === 'feedback'`, the item `addressed` in round 1, and the last saved prompt contains the note's id. Screenshot: running card with the pending note |
| `c05-c06-notes-and-citations.mjs` (C5, C6) | `P2 solo`, title includes `SCRIPTED_OMIT_CITATION_ONCE`; after doc finishes, pause the mission via the header so the round cannot start between notes | Resume only after two Request changes on the card (the second joins the round the first started, shown as "2 notes pending" or both in the drawer thread) | C5: both items `addressed` in round 2, and the reader's "Changes in v2" links both notes. C6: a round-2 run failed its harvest; the saved prompt of the retry contains `must cite <second id>`; the task SUCCEEDED; timeline shows the retry. Two Evidence ids, C5 and C6 |
| `c07-ai-reviewer.mjs` (C7) | `P2 chain`, title includes `SCRIPTED_REVIEW_BLOCKING`; a "Review agent" member staffed to `review` | None beyond plan approval (the loop is automatic); open the build card and drawer | Build's thread holds an item authored by "Review agent" (`recordedBy` Tandemise); build `round === 2` started without a person; review ran twice and its last ReviewReport verdict is pass; no task key starts with `fix_`. Screenshots: build drawer thread, feed after the loop |
| `c08-person-step.mjs` (C8) | `P0 acceptance`, solo (no other people): the docs step is yours | When docs is AWAITING_HUMAN: task drawer → Request changes "Mention the pricing page"; then complete docs yourself | The docs card and drawer show the note text and "1 note pending"; after completion the item is `addressed` with `round === 1` and the artifact `round === 1`, author You. No "Recording for" anywhere on screen. Screenshot: your card with the note |
| `c09-decline.mjs` (C9) | `P2 solo`, title includes `SCRIPTED_DECLINE` | Request changes on the finished doc card | Card's "What changed" shows "Declined: …" with a Declined chip and the note's author; reader "Changes in v2" links it to the note text; event `feedback.addressed` has `declined: true` |
| `c10-real-claude.mjs` (C10) | `P2 solo`, product staffed to a Claude Code agent (as `b11-real-claude.mjs` creates it), no reviews | After doc finishes on Claude: Request changes "Make the intro one sentence"; later open the reader, switch v1/v2, toggle "Compare with v1" | Both runs on the Claude profile; round-2 run `purpose === 'round'` and `externalSessionId` equal to round 1's; v2 handoff cites the note; the comparison shows removed and added lines around the intro. Screenshots: reader v2 with "Changes in v2", the comparison |
| `c11-code-round.mjs` (C11) | `P2 chain`; development staffed with a blocking review by the responsible person; approve design | On the build review card in the Inbox: Request changes "Escape the visitor name" | Same build task, round 2; its round-2 ChangeSet has the same `git.branch` source ref as round 1 and a different `git.commit`; `git -C <project> log <branch> --oneline` shows a second commit touching `hello.txt`; a new build review card appears (the review pipeline reran). Screenshot: second review card |
| `c12-retry-blocked.mjs` (C12) | `P2 solo`, title includes `SCRIPTED_FAIL_UNTIL_NOTE` | When doc is BLOCKED: task drawer → type in "Retry with a note" "Write it even if short" → "Retry with this note" | Item created and `addressed` in round 2; task SUCCEEDED; the last saved prompt contains "Feedback to address" and the note, and does not contain "did not satisfy this task's completion gate". Screenshot: drawer with the note field |

`s03-team-mission.mjs` A8, per spec §10: after "Needs changes" with the note, the Inbox opens the impact dialog (build used architecture v1); choose "Keep their work"; check that architecture starts round 2, build was not stopped, and once architecture round 2 lands build shows needsAttention. Title stays "AI drafts, you check later".

- [ ] **Step 3: run.** Build once, then each suite on a fresh install, copying evidence after each (the runner clears `p0/evidence` at start):

```bash
npm run build
node scratch/acceptance/p0/run-all.mjs --p2
mkdir -p docs/superpowers/evidence/2026-09-14-p2/p2 && cp -R scratch/acceptance/p0/evidence/. docs/superpowers/evidence/2026-09-14-p2/p2/
node scratch/acceptance/p0/run-all.mjs
mkdir -p docs/superpowers/evidence/2026-09-14-p2/p0 && cp -R scratch/acceptance/p0/evidence/. docs/superpowers/evidence/2026-09-14-p2/p0/
node scratch/acceptance/p0/run-all.mjs --p1
mkdir -p docs/superpowers/evidence/2026-09-14-p2/p1 && cp -R scratch/acceptance/p0/evidence/. docs/superpowers/evidence/2026-09-14-p2/p1/
npm run ci
```

Each `REPORT.md` must read **ALL PASS**. Read every screenshot before trusting a check.

- [ ] **Step 4:** commit `test(acceptance): P2 real-app scenarios C1–C12 with P0 and P1 regressions and evidence`.

---

## Focus: you plus agents (2026-09-14)

The user chose to focus on one person working with agents. Every real-app scenario (C1–C12) runs in a solo workspace, with no other people added, and each asserts that no "Recording for" control appears. Team paths stay implemented per P0 and are covered offline only.

## Rulings made while planning

Where the spec left a choice open, this plan decides as follows. Each is small to reverse.

1. **Citation rule scope:** the round contract applies to any pass that carries notes, including round 1 with notes attached before it started, not only rounds ≥ 2. Otherwise attached notes could never become `addressed`.
2. **Several ids per `changed` entry:** `feedback` may hold several ids separated by commas, because `changed` is capped at 3 and a round can carry more notes.
3. **Where a note must be cited:** in the handoff of the artifact it is about (`artifactId`'s type), or of the task's first expected output for a note about the whole task.
4. **Round attempt budget:** starting a round sets `retryPolicy.maxAttempts = attempts + DEFAULT_RETRY_POLICY.maxAttempts` (2), since the planned budget is lost after manual extensions.
5. **Session continuation needs the same runtime profile:** a round continues the last session only when that run used the profile now selected.
6. **Feedback while a pass fails:** queued notes are promoted into the round and ride with the counted retry. A delivery pass whose rewrite breaks the citation contract fails the gate, and the retry that follows is counted.
7. **At most 5 delivery passes per attempt;** notes arriving after that, or after the executor's last read, become `open` through the scheduler sweep and show as pending with "Start round".
8. **AWAITING_APPROVAL on a start card** (nothing ran) attaches the note to round 1; only an output card is decided "Request changes".
9. **Wait steps refuse feedback** (PRECONDITION_FAILED); SKIPPED behaves like CANCELLED.
10. **Retry with a note:** from FAILED/BLOCKED/CANCELLED/SKIPPED/AWAITING_APPROVAL/SUCCEEDED it is a round; from SUCCEEDED it keeps consumers (the retry API cannot show the dialog). From AWAITING_INPUT with more access, it keeps today's framing.
11. **Legacy reject-with-note** on a two-option output card is treated as Request changes; a bare reject blocks.
12. **Check "Needs changes" without a note** keeps P0's `needsAttention` flag; with a note and consumers, the item stays open and the impact dialog decides.
13. **Reviewed task** for AI findings is the review's single direct dependency with a live ChangeSet (else its single producing dependency). When that is ambiguous, today's fix-task flow runs. At the cap, the review task escalates with today's intervention card.
14. **AI round cap** counts distinct rounds holding items authored by agents or the runtime.
15. **Keep flags** are derived when the new round lands (consumers still standing on a superseded version and not redone), not stored at confirm time.
16. **A redone dependent** keeps its round number, and its reruns are `purpose: retry`. A dependent that never ran but was READY goes back to PENDING without appearing in the dialog.
17. **Person steps:** completing addresses every open or in-round note in the current round; they are not asked to cite ids.
18. **`FeedCard.openFeedback`** carries the items (open and queued), not a bare count, so a person step's card can show the note (C8). `FeedCard.canRequestChanges` is added.
19. **C1 in the real app runs on the built-in fake runtime** (which declares `session_resume`), since the scripted generic-CLI agent cannot resume. C10 proves the same on Claude Code. The fake runtime gains script `captures` for this.
20. **C10's "diff between versions"** is a line comparison toggle in the reader ("Compare with vN-1"), in addition to the version switcher.

---

## Self-review

**Spec coverage:**

| Spec section / row | Task(s) |
|---|---|
| Problem: revision clones | T5 (planRevision removed), T3 (review → round) |
| Problem: retry-with-note framing, SUCCEEDED retry | T3 (note → round), T4 (request framing, cleared `retryFeedback`) |
| Problem: retry doesn't see previous output | T4 (`RoundBrief.previous`) |
| Problem: no note to a running task | T3 (`queue`), T4 (delivery pass) |
| Problem: consumption not recorded | T1 (`run_inputs`), T4 (recorded at run start) |
| Problem: finished session never continued | T4 (`#settledSession`) |
| §1 Round fields (`mission_tasks/artifacts/runs.round`) | T1, T4 |
| §1 Feedback item fields and statuses, timeline events | T1, T2, T3, T4 |
| §2 Entry points (feed card, reader, Inbox, drawer) and composer | T6 |
| §2 Table: AWAITING_APPROVAL | T3 (`review` effect), T5 (decide `request_changes`) |
| §2 Table: SUCCEEDED (impact first) | T2, T3 |
| §2 Table: RUNNING / AWAITING_INPUT | T3, T4 |
| §2 Table: AWAITING_HUMAN | T3, T4 (`onPersonCompleted`) |
| §2 Table: PENDING / READY | T3, T4 (`openRound`) |
| §2 Table: FAILED / BLOCKED / CANCELLED | T3 |
| §2 Several items into one round | T2 (`joining`), T4 check C5 |
| §2 Revision clones; old `_revision_` tasks still display; AI fix tasks stay | T5 |
| §3 Consumers from `run_inputs`, pre-010 fallback | T2 |
| §3 Dialog, defaults, per-task checkboxes | T3 (`DownstreamImpactView`), T6 |
| §3 Redo (cancel, reset incl. finished, withdraw cards, re-resolve staffing) | T2 |
| §3 Keep (flag when the new round lands) | T4 (`#flagKeptConsumers`) |
| §3 No dependents → no dialog | T3, T6 |
| §4 Wake rules, end_of_pass, session resume, not counted, slot hand-over | T4 (`#deliverQueued`) |
| §5 Round prompt (previous output, numbered feedback, instruction, request framing) | T4 |
| §5 Session continuation / fresh fallback | T4 |
| §5 Validation → retry naming missing ids | T4 (`checkRoundHandoff` in harvester) |
| §5 Reviews rerun per round | T4 (unchanged `onRoundPassed`), T5 check C3 |
| §5 AI review findings → feedback, automatic round, review redone, cap, QA unchanged | T5 |
| §5 Addressed items | T4 (`onRoundLanded`) |
| §6 Feed card (round badge, What changed with authors, notes pending, Request changes) | T3 (view), T6 |
| §6 Reader (version switcher, Changes in vN) | T3 (view), T6 |
| §6 Task drawer thread | T3 (`TaskView.feedback`), T6 |
| §6 Inbox (Request changes, Reject without changes) | T5 (options), T6 |
| §6 Timeline | T1 (events), T6 (copy) |
| §7 Migration 010 (all tables and columns) | T1 |
| §7 Retry `{note}` becomes feedback | T3, T4 |
| §8 `POST /feedback`, `POST /rounds`, `GET /feedback`, `POST /feedback/:id/dismiss` | T3 |
| §8 `decide` option `request_changes` | T5 |
| §8 Views `FeedCard`, `TaskView` | T3 |
| §10 rulings (run_inputs, redo resets finished, settled sessions, per-call-site guards, AI reviews vs QA, interrupt parked, check cards) | T1, T2, T4, T5 (interrupt: not built) |
| C1 | T4 (offline), T7 |
| C2 | T2, T4 (offline), T7 |
| C3 | T5 (offline), T7 |
| C4 | T4 (offline), T7 |
| C5 | T4 (offline), T7 |
| C6 | T4 (offline), T7 |
| C7 | T5 (offline incl. cap), T7 |
| C8 | T4 (offline), T7 |
| C9 | T4 (offline), T7 |
| C10 | T7 |
| C11 | T7 |
| C12 | T3, T4 (offline), T7 |

**Names used consistently:** `FeedbackItem`, `FeedbackStatus`, `FEEDBACK_STATUSES`, `PENDING_FEEDBACK_STATUSES`, `RunPurpose`, `REQUEST_CHANGES_OPTION`, `citedFeedbackIds`, `isDeclinedChange`, `FeedbackRepositoryPort`, `RunInputRepositoryPort`, `FEEDBACK_REPOSITORY`, `RUN_INPUT_REPOSITORY`, `FEEDBACK_ROUNDS`, `FEEDBACK_SERVICE`, `FeedbackRounds` (`record`, `impactOf`, `startRound`, `releaseStranded`, `decideReviewCard`, `openRound`, `roundContract`, `promoteQueued`, `requeue`, `hasQueued`, `onRoundLanded`, `onPersonCompleted`, `fromReviewFindings`), `ROUND_START_STATUSES`, `ROUND_ATTEMPTS`, `downstreamConsumers`, `reviewedTaskOf`, `feedbackEffectFor`, `RoundBrief`, `RoundContract`, `checkRoundHandoff`, `renderRoundBrief`, `roundRequest`, `FeedbackService`, `FeedbackView`, `FeedChange`, `DownstreamImpactView`, `FeedbackGivenView`, `TaskFeedbackView`, `RequestChangesComposer`, `ImpactDialog`, `lineDiff`.
