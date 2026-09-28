# P3 Outside contributions and evals: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A person can hand work in (uploads) and back (external hand-backs), each pinned as an `Evidence` snapshot and typed before downstream use (P3a); and every run is scored, finished steps become eval cases, and a suite runs against a candidate setup before it goes live (P3b).

**Architecture:**
- P3a is additive on the existing schema: pure types in `@tandemise/domain` / `@tandemise/artifacts` / `@tandemise/api-contract`, a `ContributionService` that pins contributions and resolves GitHub PR links through a new domain port, lazy intake at the first refinement or planning, `SKIPPED` placeholder tasks for covered stages, and `parkTask` / `handBack` on `MissionService`.
- P3b adds migration 020, a `run_scores` write after every gate assessment, an `EvalService` (save cases, start/cancel runs) and an `EvalRunner` that executes trials in hidden missions by calling `TaskExecutor.execute` directly. The scorecard is a pure function in `@tandemise/evaluation`.
- Every check is a `scratch/*.mjs` node script against `dist/`, registered in `scripts/run-checks.mjs` `OFFLINE_CHECKS`; real-app proof is a CDP acceptance suite in `scratch/acceptance/`.

**Tech stack:** Node 22, TypeScript ESM, zod, better-sqlite3, Electron + React 19, `gh` CLI.

**Spec:** `docs/superpowers/specs/2026-09-16-p3-outside-contributions-design.md` (revised 2026-09-27). Read it first; section numbers below (A1…B7) refer to it.

## Global Constraints

- Branch `feat/p3-contributions-and-evals` in worktree `../tandemise-p3`, based on `origin/main` 0.6.0. **Two PRs**: P3a (Tasks 1–8) is opened and merged first; P3b (Tasks 9–17) is rebased on it and opened second. PR titles: `feat: hand work in and back, pinned as a snapshot` and `feat: score every run and try a setup on evals before it goes live`.
- `npm run ci` green before each PR (build, `check:boundaries`, `check:design`, licenses, desktop typecheck, offline checks).
- **P3a adds no migration**; its check asserts `SCHEMA_VERSION === 19`. **P3b adds exactly migration 020 (`evals`)**, additive only, in the style of `019_issues.ts`, registered in `packages/persistence/src/migrations/index.ts` `MIGRATIONS`.
- Layering (`npm run check:boundaries`): `@tandemise/domain` and `@tandemise/artifacts` import only domain/shared/zod. Integrations implement domain ports; application binds them via `tokens.ts` + `module.ts` `bind(...)`, never `services.ts` alone.
- File cap 24 MB decoded; contribution routes accept 32 MiB bodies; every other route keeps `MAX_BODY_BYTES = 8 MiB`. Desktop timeout 120 s on contribution calls only.
- A non-`workspace` handoff link keeps `url` http(s)-only; only `kind: 'workspace'` may carry `path`.
- Copy strings, verbatim: "Covered by your upload: <filename>", "Continued in <tool>", "Waiting for your work in <tool>", "Nothing here can read that link. Attach an export of it.", "Open workspace ↗", "Stopped at your $<cap> cap", "few repeats, differences may be noise".
- Eval defaults: `repeats` 1–10, default 3; `spendCapUsd` required, default 5. Trials run one at a time.
- Desktop uses design-system tokens only (`npm run check:design`). Comments explain *why*, in full sentences, matching surrounding density.
- Commits and PR titles are Conventional Commits with lowercase subjects; commit bodies end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Daemon restart mid-eval-run.** Recovery (`engine/recovery.ts`) resumes RESUMABLE runs; it must never resume a trial mission's run, and on boot an eval run left `running` becomes `failed` with "The daemon stopped during this run." (Task 13 check.)
2. **Double hand-back / hand-back after the mission was cancelled.** A second `handBack` on the same task, or one on a task whose mission is `CANCELLED`, is refused with a 409 and writes nothing. (Task 4 check.)
3. **The same file uploaded twice** (creation and again in feedback) is one blob and runs intake once. (Task 3 check.)
4. **An eval case whose input content is missing from the store** (blob deleted by hand) refuses the run at start naming the case, rather than failing every trial. (Task 13 check.)
5. **A file over 24 MB** is refused by the route with "That file is larger than 24 MB." before any Evidence is written, not a timeout. (Task 5 check.)

---

## File map

| File | Responsibility | Task |
|---|---|---|
| `packages/domain/src/entities/contribution.ts` (create) | `OutsideContribution`, `ContributionExport`, size limit | 1 |
| `packages/domain/src/entities/feedback.ts` | concrete `FeedbackAttachment` | 1 |
| `packages/domain/src/entities/artifact.ts` | named `HandoffLink` with `path?` | 1 |
| `packages/domain/src/plan.ts` | `SkippedStage`, `MissionPlan.skipped?` | 1 |
| `packages/domain/src/entities/liveness.ts` | T8 split (wait vs parked hand-back) | 1 |
| `packages/domain/src/event.ts` | `task.parked_external`, `task.handed_back`, `mission.intake_completed` | 1 |
| `packages/domain/src/ports/snapshot.ts` (create) | `PullRequestSnapshotPort` | 1 |
| `packages/artifacts/src/handoff.ts` | `path` schema, workspace-only | 1 |
| `packages/api-contract/src/requests.ts`, `views.ts` | uploads, attachments, park, hand-back; view fields | 1 |
| `packages/integration-github/src/pull-requests.ts` (create) | `GhPullRequestSnapshots` | 2 |
| `packages/application/src/services/contribution-service.ts` (create) | pin, resolve, workspace-path validation | 2 |
| `packages/application/src/planning/intake.ts` (create) | intake prompt + type choice + run | 3 |
| `packages/application/src/services/planning-service.ts`, `refinement` path | `ensureIntake`, `preexistingArtifacts` | 3 |
| `packages/application/src/planning/prompt.ts`, `materialize.ts` | skip instruction, `SKIPPED` placeholders | 3 |
| `packages/application/src/services/projection-service.ts` | `coveredBy`, `parkedExternal`, `uploads` | 3, 4 |
| `packages/application/src/services/mission-service.ts` | uploads at create, `parkTask`, `handBack` | 3, 4 |
| `packages/application/src/engine/feedback-rounds.ts` | attachments into round inputs | 4 |
| `packages/application/src/services/desk-service.ts`, inbox, `liveness-service.ts` | parked hand-backs as waiting | 4 |
| `apps/daemon/src/http/router.ts`, `routes.ts` | per-route body cap; new routes | 5 |
| `apps/desktop/src/renderer/src/lib/daemon.ts` | client methods, 120 s timeout | 5 |
| `apps/desktop/src/renderer/src/components/ContributionPicker.tsx` (create) | file / link (+ export) picker | 6 |
| `NewMission.tsx`, `RequestChanges.tsx`, `HandoffCard.tsx`, `FeedPane.tsx`, `ArtifactReader.tsx`, `PlanPane.tsx`, `Inbox.tsx`, `HandBackDialog.tsx` (create) | P3a UI | 6 |
| `scratch/p3-contributions-check.mjs` (create) | P3a offline check, grown task by task | 1–5 |
| `scratch/acceptance/p3/` (create) | D1–D8 | 8 |
| `packages/persistence/src/migrations/020_evals.ts` (create), repositories | eval tables, `run_scores`, `missions.eval_trial_id` | 9 |
| `packages/domain/src/entities/eval.ts` (create), `ports/repositories.ts` | eval entities and repository ports | 9 |
| `packages/application/src/engine/task-executor.ts` | score write, `roleFor` seam, trial blocking | 10, 11 |
| `packages/domain/src/entities/models.ts` | pinned step model beats R3 | 11 |
| backlog / desk / projection / liveness / issue / notification / limit services | exclude trial missions | 11 |
| `packages/application/src/services/eval-service.ts` (create) | save case, suites, start/cancel runs, summaries | 12, 13 |
| `packages/application/src/engine/eval-runner.ts` (create) | trial seeding, execution, cleanup, spend cap | 13 |
| `packages/evaluation/src/scorecard.ts` (create) | `scoreEvalRun`, `summarizeRunScores` (pure) | 13 |
| daemon routes, desktop client | eval API | 14 |
| `apps/desktop/src/renderer/src/screens/evals/*` (create) + entry points | Evals screen, Save as eval case, Try on evals | 15 |
| `scratch/p3-evals-check.mjs` (create) | P3b offline check, grown task by task | 9–14 |
| `docs/guides/evals.md`, `docs/guides/outside-contributions.md` (create), `KNOWN_LIMITATIONS.md`, `README.md` | docs | 7, 16 |
| `scratch/acceptance/p3-evals/` (create) | E1–E6 | 17 |

---

# P3a — outside contributions

### Task 1: Pure types, schemas, events and the liveness split

**Files:**
- Create: `packages/domain/src/entities/contribution.ts`, `packages/domain/src/ports/snapshot.ts`
- Modify: `packages/domain/src/entities/feedback.ts:13-14`, `entities/artifact.ts:28-51`, `plan.ts:21-24,83-99`, `entities/liveness.ts:59,153`, `event.ts` (union + list at `:119-125`), `packages/domain/src/index.ts`
- Modify: `packages/artifacts/src/handoff.ts:35-60`
- Modify: `packages/api-contract/src/requests.ts:93-122`, `views.ts:409`
- Create: `scratch/p3-contributions-check.mjs`; Modify: `scripts/run-checks.mjs` (`OFFLINE_CHECKS` += `p3-contributions-check`)

**Interfaces — Produces:**

```ts
// domain/entities/contribution.ts
export const CONTRIBUTION_MAX_BYTES = 24 * 1024 * 1024;
export interface ContributionExport { readonly filename: string; readonly mediaType: string; readonly dataBase64: string }
export type OutsideContribution =
  | { readonly kind: 'file'; readonly filename: string; readonly mediaType: string; readonly dataBase64: string }
  | { readonly kind: 'link'; readonly url: string; readonly label?: string; readonly export?: ContributionExport };
/** Decoded size of a base64 payload without decoding it. */
export function decodedSize(dataBase64: string): number;

// domain/entities/feedback.ts (replaces the Record<string, unknown> stub)
export type FeedbackAttachment =
  | { readonly kind: 'artifact'; readonly artifactId: ArtifactId }
  | { readonly kind: 'link'; readonly url: string; readonly label?: string };

// domain/entities/artifact.ts
export interface HandoffLink { readonly label: string; readonly url?: string; readonly path?: string; readonly kind: HandoffLinkKind }
// ArtifactHandoff.links: readonly HandoffLink[]  (url required unless kind==='workspace' with path)

// domain/plan.ts
export interface SkippedStage { readonly stage: string; readonly outputType: ArtifactType; readonly artifactId: ArtifactId; readonly reason: string }
// MissionPlan gains: readonly skipped?: readonly SkippedStage[]
// validateMissionPlan: each skipped.artifactId must be in ctx.preexistingArtifacts with type === outputType,
//   else an error "skipped stage '<stage>' names <id>, which is not an upload of type <T>".

// domain/ports/snapshot.ts
export interface PullRequestSnapshot {
  readonly url: string; readonly number: number; readonly repo: string;
  readonly headRefName: string; readonly headRefOid: string;
  readonly title: string; readonly body: string; readonly diff: string;
}
export interface PullRequestSnapshotPort {
  /** null when the URL is not a GitHub PR this machine can read. Never throws for "not mine". */
  read(url: string, cwd: string): Promise<PullRequestSnapshot | null>;
}

// domain/event.ts — three new event types
// 'task.parked_external' { tool }  'task.handed_back' { artifactIds, round, contribution: 'file'|'link' }
// 'mission.intake_completed' { uploads: number, produced: { artifactId, type }[], failed: { evidenceId, reason }[] }

// api-contract requests
createMissionRequest.uploads: OutsideContribution[] (optional, max 10)
giveFeedbackRequest.attachments: OutsideContribution[] (optional, max 5)
parkTaskRequest = { tool: string (1..40) }
handBackRequest = { note: string (1..4000), contribution: OutsideContribution, downstream?: 'redo'|'keep', onBehalfOf?: PersonId }

// api-contract views
TaskView.parkedExternal: { tool: string; since: string } | null
TaskView.coveredBy: { artifactId: string; filename: string } | null
MissionDetail.uploads: { evidenceId: string; filename: string; mediaType: string; refs: ExternalRefView[]; intakeArtifactId: string | null }[]
```

**Liveness T8 split:** the rule that maps `AWAITING_EXTERNAL` to *moving* now applies only when `task.executor === 'wait'`. An `AWAITING_EXTERNAL` agent task maps to *waiting on a person* (the same bucket as `AWAITING_HUMAN`). Update the rule table comment and the rule itself; keep its id T8 and add T8b for the parked case.

- [ ] **Step 1: Write the failing check.** Create `scratch/p3-contributions-check.mjs` using the `check/section/eq` preamble from `scratch/p13-skills-check.mjs:19-27`, with section `pure: contributions, links, plans, liveness`:

```js
const D = await import('@tandemise/domain');
const A = await import('@tandemise/artifacts');
section('pure: contributions, links, plans, liveness');
check('decodedSize of 4 base64 chars is 3', D.decodedSize('YWJj') === 3);
check('decodedSize honours padding', D.decodedSize('YQ==') === 1);
check('the cap is 24 MB', D.CONTRIBUTION_MAX_BYTES === 25165824);
const ok = A.handoffSchema.safeParse({ headline: 'h', points: [], links: [{ label: 'Repo', kind: 'workspace', path: 'docs/spec.md' }] });
check('a workspace link may carry a path and no url', ok.success, ok.error?.issues);
const bad = A.handoffSchema.safeParse({ headline: 'h', points: [], links: [{ label: 'PR', kind: 'pr', url: 'https://x/1', path: 'a' }] });
check('a pr link with a path is refused', !bad.success && bad.error.issues.some((i) => /only a workspace link may carry a path/.test(i.message)));
const file = A.handoffSchema.safeParse({ headline: 'h', points: [], links: [{ label: 'X', kind: 'doc', url: 'file:///etc/passwd' }] });
check('a non-workspace link stays http(s) only', !file.success);
const pre = [{ id: 'art_up', type: 'ProductSpec' }];
const plan = { summary: 's', tasks: [/* a design task depending on nothing */ minimalTask('design', 'DesignBrief', [])], skipped: [{ stage: 'product', outputType: 'ProductSpec', artifactId: 'art_up', reason: 'upload' }] };
check('a skipped stage naming a real upload validates', D.validateMissionPlan(plan, ctx({ preexistingArtifacts: pre })).errors.length === 0);
check('a skipped stage naming an unknown artifact is an error', D.validateMissionPlan({ ...plan, skipped: [{ ...plan.skipped[0], artifactId: 'art_nope' }] }, ctx({ preexistingArtifacts: pre })).errors.some((e) => /not an upload of type ProductSpec/.test(e)));
check('T8: a waiting wait-step is moving', D.taskLiveness({ status: 'AWAITING_EXTERNAL', executor: 'wait' }).state === 'moving');
check('T8b: a parked agent task waits on a person', D.taskLiveness({ status: 'AWAITING_EXTERNAL', executor: 'agent' }).state === 'waiting');
check('the new events are in the list', ['task.parked_external', 'task.handed_back', 'mission.intake_completed'].every((t) => D.EVENT_TYPES.includes(t)));
```

`minimalTask` and `ctx` are helpers at the top of the check: build them from the shapes `validateMissionPlan` already accepts (copy the fixture in `scratch/p15-setup-check.mjs` that calls `validateMissionPlan`). Use whatever the liveness module actually exports for classifying one task (read `liveness.ts` first; if the function name differs, use the real one — do not add a new export only for the check).

- [ ] **Step 2: Run it and see it fail.** `npm run build && node scratch/p3-contributions-check.mjs` → FAIL (missing exports).
- [ ] **Step 3: Implement** the interfaces above. Zod: `handoffSchema.links[]` becomes an object with `url` optional, `path` optional, and a `.superRefine` that (a) refuses `path` unless `kind === 'workspace'` with message `only a workspace link may carry a path`, (b) requires `url` (http(s)) unless `kind === 'workspace'` and `path` is set. Add the requests/views to api-contract with zod, capping `dataBase64` length at `ceil(CONTRIBUTION_MAX_BYTES/3)*4`.
- [ ] **Step 4: Run** `node scratch/p3-contributions-check.mjs` and `npm run check:offline` → all pass (existing p9 check must still pass; if a p9 assertion encoded the old T8 for an agent task, that assertion was wrong for P3 — update it and say so in the commit body).
- [ ] **Step 5: Commit** `feat(domain): outside contributions, workspace link paths, skipped stages and the parked-task liveness split`.

### Task 2: Pinning contributions and the GitHub PR resolver

**Files:**
- Create: `packages/integration-github/src/pull-requests.ts`; export from its `index.ts`
- Create: `packages/application/src/services/contribution-service.ts`
- Modify: `packages/application/src/tokens.ts` (`CONTRIBUTION_SERVICE`, `PULL_REQUEST_SNAPSHOTS`), `module.ts` (bind near `:759` where `GhIssueTracker` is bound), `services.ts` (interface)

**Interfaces — Consumes:** Task 1 types; `ArtifactStorePort.write/resolvePath`; `ArtifactWriteRequest` (`domain/entities/artifact.ts:101`); `Caller` (`support/identity.ts:6`).

**Produces:**

```ts
export interface PinnedContribution {
  readonly evidence: ArtifactManifest;                // type 'Evidence'
  readonly filename: string; readonly mediaType: string;
  readonly resolved: PullRequestSnapshot | null;      // set when a PR link resolved
}
export interface ContributionService {
  /** Pins one contribution as Evidence with ExternalRefs. Throws ContributionError('unreadable_link' | 'too_large' | 'empty'). */
  pin(input: { missionId: MissionId; taskId?: TaskId | null; caller: Caller; onBehalfOf?: PersonId | null; contribution: OutsideContribution }): Promise<PinnedContribution>;
  /** Resolves a workspace link path to an absolute path inside a repository root or the artifact root; throws ContributionError('outside_workspace'). */
  resolveWorkspacePath(workspaceId: WorkspaceId, path: string): Promise<string>;
}
export class ContributionError extends Error { constructor(readonly code: 'unreadable_link'|'too_large'|'empty'|'outside_workspace', message: string) }
```

**Requirements:**
- File → `Evidence` with `body` = decoded bytes, `mediaType` as given, `title` = filename (≤60 chars, truncated with …), `sourceRefs: [{ kind: 'file', value: <stored contentRef>, label: filename }]`, `authorId`/`recordedBy` per A6.
- Link → try `PullRequestSnapshotPort.read(url, repoPath)` for each repository of the mission's workspace until one returns non-null. Resolved: `Evidence` body is Markdown `# <title>\n\n<body>\n\n## Diff\n\n```diff\n<diff>\n```` with refs `[{kind:'url',value:url},{kind:'github.pr',value:'<repo>#<n>'},{kind:'git.commit',value:headRefOid},{kind:'git.branch',value:headRefName}]`. Not resolved + `export` present → the export's bytes, refs `[{kind:'url',value:url},{kind:'file',…}]`. Not resolved and no export → `ContributionError('unreadable_link', 'Nothing here can read that link. Attach an export of it.')`.
- `too_large` message: `That file is larger than 24 MB.` — check with `decodedSize` before decoding.
- `GhPullRequestSnapshots.read`: only URLs matching `^https://github\.com/[^/]+/[^/]+/pull/\d+`; run `gh pr view <url> --json number,title,body,headRefName,headRefOid,url` and `gh pr diff <url>` with `cwd`, through the same command-execution helper `GhIssueTracker` uses (`integration-github/src/issues.ts:50`); return null on non-matching URL or a `gh` exit that says not found/no access; cap the diff at 2 MB (truncate with a trailing line `… diff truncated at 2 MB`).
- `resolveWorkspacePath`: `realpath` the joined path; accept only if it is equal to or inside the `realpath` of a repository root of the workspace or the artifact root; refuse `..` segments before resolving.

- [ ] **Step 1: Failing check.** Add section `daemon: pinning` to the check. Start an in-process daemon exactly as `scratch/p13-skills-check.mjs` does (fixture repo in a temp dir, fake/scripted runtime), then reach the service through the module container the way that check reaches services (copy its bootstrap block). Inject a stub `PullRequestSnapshotPort` that returns a fixed snapshot for `https://github.com/acme/app/pull/7` and null otherwise (rebind the token before start — read how p14's check stubs `IssueTrackerPort` and copy it). Assert:
  - two pins of the same file bytes give two Evidence manifests with the same `contentRef` (dedupe);
  - file refs contain `kind:'file'`;
  - the PR link's Evidence has `github.pr` = `acme/app#7` and `git.commit` = the stub oid, body contains `## Diff`;
  - `https://www.figma.com/file/x` without export throws code `unreadable_link` with the exact message; with an export it pins the export bytes and carries `kind:'url'`;
  - a 24 MB + 1 byte payload throws `too_large` and writes no artifact (count Evidence before/after);
  - `resolveWorkspacePath` accepts `docs/a.md` inside the repo, refuses `../x`, and refuses a symlink inside the repo pointing at `/tmp`.
- [ ] **Step 2:** `npm run build && node scratch/p3-contributions-check.mjs` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** check passes; `npm run check:boundaries` passes.
- [ ] **Step 5: Commit** `feat(application): pin outside contributions as evidence and resolve github pull requests`.

### Task 3: Uploads at creation, lazy intake, and skipped stages

**Files:**
- Create: `packages/application/src/planning/intake.ts`
- Modify: `services/mission-service.ts:100-163` (create), `services/planning-service.ts:186-284,422-429`, the refinement entry (`POST /v1/missions/:id/refine` handler's service method — find it from `routes.ts:189`), `planning/prompt.ts`, `planning/materialize.ts:15,114`, `support/dag.ts:28-43` (accept preexisting producers), `services/projection-service.ts:240,398-400,575-591`
- Modify: `harvester.ts:355-356,395+` only to export the existing `checkSpecCriteria`/`replaceSpecCriteria` path as a function intake can call (no behaviour change).

**Interfaces — Consumes:** `ContributionService.pin`; `SkippedStage`; `mission.intake_completed`.

**Produces:**

```ts
// planning/intake.ts
export type IntakeTarget = 'ProductSpec' | 'ProblemBrief' | 'DesignBrief' | 'ImplementationPlan';
/** Pure: choose the target type from media type, filename and refs. ProductSpec vs ProblemBrief is decided after the run by whether the output has acceptance criteria. */
export function intakeTargetFor(e: { mediaType: string; filename: string; refs: readonly ExternalRef[] }): 'spec-or-brief' | 'DesignBrief' | 'ImplementationPlan';
export function intakeObjective(type: IntakeTarget | 'spec-or-brief', filename: string): string;
// PlanningService gains (internal, also called by refinement):
ensureIntake(missionId: MissionId): Promise<readonly ArtifactManifest[]>; // idempotent; returns intake artifacts whose criteria check passed (the preexisting set)
```

**Requirements:**
- `MissionService.create` pins every `uploads[]` item (`taskId: null`) **before** returning; if any pin fails, the mission is not created (pin first into a list, then create, then attach — or create inside the same transaction the service already uses; read the method and choose the order that leaves no orphan mission on a refused upload).
- Intake idempotency: an Evidence counts as converted when an artifact of the mission has `sourceRefs` containing `{kind:'file'|'url', …}` equal to the Evidence's first ref **and** `taskId: null` and type ≠ `Evidence`. No new column.
- `ensureIntake` runs one intake pass per unconverted Evidence on the planner's runtime ladder (the same way refinement runs its agent — reuse that runner, do not create a `Run` row). Output artifact: `taskId: null`, `sourceRefs` = the Evidence's refs, handoff with a `workspace` link when the upload was a local file (path = the stored artifact path relative to the artifact root), authored per A6. Record `mission.intake_completed`.
- `ProductSpec` outputs go through the existing spec-criteria check; only passing ones are returned as preexisting. `spec-or-brief` → `ProductSpec` if the agent's output has an acceptance-criteria section, else `ProblemBrief`.
- Call `ensureIntake` at the first refinement and at the top of `#planWithin` **before** `#authoredWorkflow`. Pass its result as `preexistingArtifacts` (`{id, type}[]`) into the validation context in `#planWith` (`:422`). Intake failure never throws out of planning: log the failure in the event and continue with `[]`.
- Prompt (`prompt.ts`): list preexisting uploads (`- <type> "<title>" (id <id>)`) and add: *"An upload already covers a stage when a preexisting artifact of that stage's output type exists. Omit the stage and name it under `skipped` with the artifact it was covered by."* Also include the plan JSON schema line for `skipped`.
- `materializePlan`: for each `skipped` entry create a task with `status: 'SKIPPED'`, `roleId` = the stage, `expectedOutputs: [outputType]`, `statusReason: "Covered by your upload: <filename>"`, no gate; rewrite any planned task whose `inputArtifacts` include `outputType` to also `dependsOn` the placeholder.
- `validateTaskGraph` on read and the planner's validation both treat a `SKIPPED` producer as a producer.
- Projection: `TaskView.coveredBy` for a `SKIPPED` task whose `statusReason` starts with `Covered by your upload:` and whose output type has an intake artifact; `MissionDetail.uploads` from the mission's `Evidence` with `taskId: null`.

- [ ] **Step 1: Failing check** section `daemon: intake and skips`. The scripted/fake runtime needs an intake response: extend the fake script used by the check with a `when.promptIncludes: 'Turn the uploaded input into'` step that writes a ProductSpec (with an `## Acceptance criteria` section whose criteria cover the mission's U1) to the requested destination. Assert:
  - creating with an upload pins Evidence and runs **no** intake (no `mission.intake_completed` event yet);
  - `POST /plan` runs intake once → one ProductSpec with `taskId: null`, the event lists it; planning again (replan) runs no second intake;
  - uploading the same bytes in creation and then again later yields one blob and still one intake;
  - the planner (fake) returns a plan with `skipped: [product]` → tasks include a `SKIPPED` product placeholder with the exact statusReason, its dependents `dependsOn` it, `MissionDetail.plan` problems list is empty, and `TaskView.coveredBy.filename` is the upload's filename;
  - an intake ProductSpec that leaves U1 uncovered is **not** passed as preexisting (planner prompt capture does not list it) and a plan skipping product is rejected by validation;
  - a project with `.tandemise/workflows/*.yaml` authored workflow: intake still runs, no placeholder is created;
  - a refused upload (bare unreadable link) at creation returns 400 and no mission exists.
- [ ] **Step 2:** run → FAIL. **Step 3:** implement. **Step 4:** check passes and `npm run check:offline` passes (P5/P6/P15 checks unchanged).
- [ ] **Step 5: Commit** `feat(application): lazy intake of uploads and stages covered by an upload`.

### Task 4: Park, hand back, attachments, and parked tasks as waiting

**Files:**
- Modify: `services/mission-service.ts:445-597` (next to `completeTask` and `skipTask`), `engine/feedback-rounds.ts:128,224`, `engine/scheduler.ts:176,326-328` (no behaviour change; comment only if needed), `services/desk-service.ts:88,201`, inbox projection (find the Inbox view builder used by `Inbox.tsx`), `services/liveness-service.ts:70,89`, `services/projection-service.ts` (`parkedExternal`)

**Interfaces — Consumes:** `ContributionService.pin`; `handBackRequest`; `parkTaskRequest`; `startRound`'s downstream handling in `feedback-rounds.ts`.

**Produces:**

```ts
MissionService.parkTask(taskId: TaskId, caller: Caller, req: { tool: string }): Promise<TaskView>;
MissionService.handBack(taskId: TaskId, caller: Caller, req: HandBackRequest): Promise<{ task: TaskView; artifacts: ArtifactManifest[] }>;
MissionService.giveFeedback(...) // existing, now pins req.attachments and stores FeedbackAttachment[]
```

**Requirements:**
- `parkTask`: allowed for `executor === 'agent'` in `READY | RUNNING | SUCCEEDED` whose `expectedOutputs` include one of `DesignBrief, ChangeSet, ImplementationPlan, ProductSpec`, and none of whose live outputs appear in any other task's `run_inputs`; otherwise 409 with a reason. Order: `#assertMayTake` → write `AWAITING_EXTERNAL` + `statusReason "Continued in <tool>"` → `scheduler.cancelTask(taskId)` if a run is live → event `task.parked_external`. `parkedExternal.since` = the event time (read it from the newest `task.parked_external` event in projection).
- `handBack`: refuse (409, nothing written) unless the task is `AWAITING_EXTERNAL`, `executor === 'agent'`, has a `task.parked_external` event newer than its last `task.handed_back`, and the mission is not `CANCELLED`/`COMPLETED`. Then: `#assertMayTake`, `pin` (taskId = the task), write each `expectedOutputs` type as a round `task.round + 1` with `supersedes` = the current live output of that type, `authorId`/`recordedBy` per A6, handoff from `deriveHandoff(note)` plus a link (`pr` kind for a resolved PR URL, `doc` for another URL, `workspace` path for a file); the output's `sourceRefs` include the Evidence's refs; a `ChangeSet` from a resolved PR carries `git.branch`/`git.commit` from the snapshot. Record the Evidence and outputs in `run_inputs`? No — there is no run; record the Evidence id in the output's `sourceRefs` only. Set task `SUCCEEDED`, `round` bumped, `#claimFields` applied. Event `task.handed_back`. Then `rounds.onPersonCompleted`, `reviews.onRoundPassed`, the downstream rule from `startRound` for `redo|keep` (default `keep` when omitted), `scheduler.wake`.
- Feedback attachments: `giveFeedback` pins files (taskId = the feedback's task) and stores `FeedbackAttachment[]`; when `feedback-rounds.ts` starts the round that addresses the feedback, append the attachment artifact ids to the round's inputs so the executor records them in `run_inputs` and the prompt lists them (find where round inputs are assembled; the executor records `input.inputs` at `task-executor.ts:664`).
- Desk `#needsAPerson` and the "waits on a person" rows include `AWAITING_EXTERNAL` agent tasks with a park event; Inbox lists them with title `Waiting for your work in <tool>` and an action that opens the mission at that task. Liveness service uses the T8b rule from Task 1.

- [ ] **Step 1: Failing check** section `daemon: park and hand back`. Use a mission with a running design task (fake runtime with a `delay` step so it is RUNNING). Assert:
  - park while running → status `AWAITING_EXTERNAL` (not `CANCELLED`) after the run aborts; `task.parked_external` recorded; the task is not re-dispatched after `scheduler.wake()` and 2 ticks; the concurrency ceiling count excludes it;
  - Desk needs-a-person count is 1; Inbox has "Waiting for your work in Figma"; the mission's liveness is `waiting`;
  - hand back with a file → task `SUCCEEDED`, `round` 2, new `DesignBrief` with `supersedes` = the round-1 output (if the agent had finished) and `recordedBy` = the local person; `task.handed_back` event; a second hand-back → 409 and artifact count unchanged;
  - hand back with the stub PR link on a ChangeSet task → the ChangeSet's refs include `git.commit` = stub oid;
  - hand back on a task whose mission was cancelled → 409;
  - downstream: a consumer that read round 1, hand back with `redo` → consumer re-queued as a new round; with `keep` → consumer flagged stale;
  - feedback with a file attachment → the feedback row stores `{kind:'artifact'}`, and the next round's run has that artifact id in `run_inputs`;
  - a `wait` task cannot be parked (409).
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** check + `npm run check:offline` pass (p9, p10, p16 checks must still pass).
- [ ] **Step 5: Commit** `feat(application): continue a step elsewhere and hand it back as a new round`.

### Task 5: Daemon routes and desktop client

**Files:**
- Modify: `apps/daemon/src/http/router.ts:77-86` (per-route `maxBodyBytes`), `apps/daemon/src/routes.ts`
- Modify: `apps/desktop/src/renderer/src/lib/daemon.ts:151`

**Produces (routes):**
- `POST /v1/missions` (existing) — accepts `uploads`; route cap 32 MiB.
- `POST /v1/tasks/:id/feedback` (existing path — use the real one) — accepts `attachments`; 32 MiB.
- `POST /v1/tasks/:id/park` `{tool}` → `TaskView`.
- `POST /v1/tasks/:id/hand-back` `HandBackRequest` → `{task, artifacts}`; 32 MiB.
- `GET /v1/artifacts/:id/path` → `{ path }` (absolute, via `resolvePath`).
- `POST /v1/workspace-links/resolve` `{workspaceId, path}` → `{ path }`.
- `ContributionError` maps to 400 (`too_large`, `empty`, `unreadable_link`, `outside_workspace`) with `{ error: { code, message } }` in the shape the router already uses.

**Client:** `DaemonClient.parkTask, handBack, artifactPath, resolveWorkspaceLink`; `createMission`/`giveFeedback` pass uploads/attachments; a `#request` option `{ timeoutMs }`, used as 120 000 on the three contribution calls.

- [ ] **Step 1: Failing check** section `http: contributions` (real HTTP against the in-process daemon with the bearer token, as p14/p15 checks do): a 25 MB file is refused 400 with `That file is larger than 24 MB.` and no Evidence written; a 10 MB file succeeds (would have failed the global 8 MiB cap); a 9 MiB body to an unrelated route is still refused; park and hand-back round-trip; `GET /v1/artifacts/:id/path` returns an absolute existing path.
- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** pass; desktop typecheck passes.
- [ ] **Step 5: Commit** `feat(daemon): routes for uploads, park and hand-back, with a larger body cap on those alone`.

### Task 6: Desktop UI for contributions

**Files:**
- Create: `apps/desktop/src/renderer/src/components/ContributionPicker.tsx`, `components/HandBackDialog.tsx`
- Modify: `screens/NewMission.tsx:92-126`, `components/RequestChanges.tsx`, `components/HandoffCard.tsx:34-79`, `screens/mission/FeedPane.tsx:72-86`, `screens/artifacts/ArtifactReader.tsx:77,243`, `screens/mission/PlanPane.tsx:203`, `screens/Inbox.tsx`, `screens/mission/GetReady.tsx` (list uploads read-only)

**Requirements:**
- `ContributionPicker`: "Add file" (hidden `<input type=file>`, read as base64 via `FileReader`, reject > 24 MB inline with the same copy as the daemon) and "Add link" (URL + optional "Attach an export" file). Shows chips with filename/URL and remove. Used by NewMission (uploads, all three submit modes), RequestChanges (attachments, max 5) and HandBackDialog (exactly one).
- HandoffCard / FeedPane: agent card with a linkable output and a status in `READY|RUNNING|SUCCEEDED` shows **Continue elsewhere** (small dialog: tool name, default "Figma" for DesignBrief, "your editor" for ChangeSet/ImplementationPlan, "your doc" for ProductSpec); a card with `parkedExternal` shows status text `Waiting for your work in <tool>` and **Hand back**. HandBackDialog: note, one contribution, and — when the daemon's existing downstream-consumers view for the task is non-empty — the P2 redo/keep choice (reuse the component P2's RequestChanges uses for it). Daemon errors render inline (the refused bare link shows the daemon's message).
- Workspace links in HandoffCard and ArtifactReader: `kind === 'workspace'` with `path` → button **Open workspace ↗** → `resolveWorkspaceLink` → `window.tandemise.revealInFinder(abs)`. ArtifactReader's existing reveal uses `artifactPath(id)` instead of `manifest.contentRef`.
- PlanPane `TaskCard`: `coveredBy` → muted row `<Stage> · covered by your upload` with the filename as secondary text; no status dot.
- Inbox: parked rows from Task 4.
- Tokens only; run `npm run check:design`.

- [ ] **Step 1:** implement. **Step 2:** `npm run typecheck -w apps/desktop && npm run check:design`. **Step 3:** visual pass with the harness from Task 8's `setup` (fresh `TANDEMISE_HOME=/tmp/tdm-p3`, CDP 9337): screenshot NewMission with two uploads, a parked card, the HandBackDialog with the redo/keep choice, a workspace link button, a covered-by-upload row, and the Inbox row; read every PNG and fix what looks wrong.
- [ ] **Step 4: Commit** `feat(desktop): add uploads, continue a step elsewhere and hand it back`.

### Task 7: Docs for P3a

**Files:** Create `docs/guides/outside-contributions.md`; modify `docs/WORKFLOWS.md` (skipped stages, parked tasks), `docs/KNOWN_LIMITATIONS.md` (intake runs are not counted by limits; only GitHub PR links resolve), `README.md` feature list line, retire `scratch/p3-baseline-check.mjs` (delete; its premise "creation is text-only" is no longer true — say so in the commit body).

- [ ] Write; run `npm run ci`; commit `docs: guide for handing work in and back`.

### Task 8: Real-app acceptance D1–D8 and PR P3a (controller)

Run by the controller in the main session.

- Build `scratch/acceptance/p3/{run-all.mjs, common.mjs, suite/d1…d8.mjs}` on the P5+ pattern (copy `scratch/acceptance/p15/` structure; reuse `p0/setup.mjs` and `p0/lib`); CDP 9337, `/tmp/tdm-p3`.
- `p0/lib/cdp.mjs` gains `attachFile(selector, { name, type, text|bytes })`, which sets an `<input type=file>` through `DataTransfer` in `Runtime.evaluate`.
- `p0/scripted-agent.mjs` gains mode `INTAKE` (responds to "Turn the uploaded input into" by writing the requested type from the Evidence text) and `WORKSPACE_LINK` (adds a `workspace` link to its handoff).
- D3 uses a local stub for `gh`: put a fake `gh` script first on the daemon's `PATH` that answers `pr view --json …` and `pr diff` for one URL (document this in the suite's README; the real `gh` is exercised by the offline stub-port test and by hand).
- Run all eight in one uninterrupted run on a fresh install; fix findings through dispatched fixes; save DOM text, API state and screenshots under `docs/superpowers/evidence/2026-09-27-p3a/` with a `README.md` table of scenario → evidence.
- `npm run ci` green; push; open the PR with title `feat: hand work in and back, pinned as a snapshot`, body `## What and why` / `## How it was verified`, ending with the Claude Code attribution line. Wait for CI green.

---

# P3b — evals

See [the P3b plan](2026-09-27-p3b-evals.md).

---

## Rulings made while planning

1. **Intake has no `Run` row**, like planning and refinement; its spend is not limited. Recorded in `KNOWN_LIMITATIONS.md`.
2. **Intake idempotency is derived from `sourceRefs`**, not a new column, to keep P3a migration-free.
3. **A hand-back writes no `run_inputs`** (there is no run); the Evidence is linked from the output's `sourceRefs`.
4. **`handBack` defaults `downstream` to `keep`**, the non-destructive choice, when the request omits it.
5. **One eval run per workspace at a time**, trials sequential — predictable spend and no contention with real work beyond one extra run.
6. **Trial stub tasks use the step's own role id** so no fake role appears anywhere; they never run.
7. **`run_scores.eval_trial` is denormalised** so "From your runs" never joins missions.
8. **The acceptance D3 uses a stub `gh` on `PATH`**; the real `gh` path is covered by the port's contract and exercised by hand, because CI has no GitHub session.

## Self-review

| Spec section | Task(s) |
|---|---|
| A1 one shape, pin first, size | 1, 2, 5 |
| A2 uploads, lazy intake, Done-when, skips, authored workflow | 3 |
| A3 feedback attachments | 4, 6 |
| A4 park, P9/P10/P16, hand-back, resolver, redo/keep | 1, 2, 4, 6 |
| A5 workspace links + reveal fix | 1, 2, 5, 6 |
| A6 attribution | 2, 4 |
| A7 API/storage, no migration | 1, 5 |
| A8 testing D1–D8 | 1–5, 8 |
| B1 run scores + From your runs | 9, 10, 15 |
| B2 cases and suites | 9, 12, 15 |
| B3 runs, trials, hidden, spend | 11, 13 |
| B4 scorecard | 13, 15 |
| B5 UI entry points | 15 |
| B6 migration 020, routes | 9, 14 |
| B7 testing E1–E6 | 9–14, 17 |

Review Focus items are pinned in Tasks 4 (double hand-back, cancelled mission), 3 (same file twice), 13 (restart mid-run, missing input), 5 (> 24 MB).
