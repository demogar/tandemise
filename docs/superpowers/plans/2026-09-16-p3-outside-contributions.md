# P3: Outside contributions — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A person can hand work *in* (an upload) and hand it *back* (an external hand-back). Each lands as a typed artifact with an author and a pinned snapshot, so downstream work consumes exactly what was handed in.

**Architecture:**
- The contribution type, the attachment shape, the workspace-link `path`, and the plan `skipped` declaration are pure types/schemas in `@tandemise/domain` and `@tandemise/artifacts`.
- Uploads are pinned as `Evidence` (content-addressed) and converted to typed artifacts by an intake step *before* planning; the planner may then omit covered stages and materializes them as `SKIPPED` tasks.
- A hand-back generalises `MissionService.completeTask`: it parks a task `AWAITING_EXTERNAL`, then writes a human-authored round from a file or link, reusing `supersedes`, `run_inputs`, and the P2 downstream-impact dialog.
- No migration: P3 reuses `feedback.attachments` (migration 010), the `artifacts`/`artifact_links` tables, and `supersedes`/`superseded_by`.

**Tech stack:** as P1/P2. TypeScript ESM, zod, better-sqlite3, React 19. Checks are `scratch/*.mjs` node scripts run against `dist/`.

**Spec:** `docs/superpowers/specs/2026-09-16-p3-outside-contributions-design.md`. Read it first.

## Global Constraints

- Node 22; `npm run build`; CI = `npm run ci`, which must pass.
- Layering is enforced by `npm run check:boundaries`. `@tandemise/artifacts` and `@tandemise/domain` may import only domain/shared/zod.
- **No new migration.** Released migrations are immutable; P3 needs no table or column because `feedback.attachments` (010), `artifacts` (001/008/009/010) and `artifact_links` (001) already carry everything. If implementation proves otherwise, that is a finding to escalate, not a migration to invent.
- Workspace link rule: `handoff.links[].kind === 'workspace'` may carry a `path`; all other kinds keep `url` `http(s)`-only. A `workspace` path is validated at the service layer against the project's repositories.
- Uploads are always reduced to a typed artifact before any downstream task reads them; the raw upload remains an `Evidence` artifact.
- `taskId` is nullable on `ArtifactManifest`; intake artifacts are stored with `taskId: null` (like the `MissionPlan` document).
- Zero-config solo behaviour stays intact apart from the new UI. All P0/P1/P2 checks keep passing (`staffing-check`, `handoff-check`, `feedback-loop-check`, the acceptance suites).
- Desktop uses design-system tokens only (`npm run check:design`).
- Comments explain *why*, in full sentences.
- Commit messages follow Conventional Commits, matching the repo's existing trailer convention.

---

## File map

| File | Responsibility |
|---|---|
| `packages/domain/src/entities/contribution.ts` (create) | `OutsideContribution` (file \| link) |
| `packages/domain/src/entities/feedback.ts` (modify) | concrete `FeedbackAttachment` (replaces the `Record<string, unknown>` stub) |
| `packages/domain/src/entities/artifact.ts` (modify) | `HandoffLink.path?` |
| `packages/domain/src/plan.ts` (modify) | `SkippedStage`, `MissionPlan.skipped`, validation |
| `packages/artifacts/src/handoff.ts` (modify) | workspace-link `path` schema |
| `packages/api-contract/src/requests.ts` (modify) | `uploads` on createMission, `attachments` on giveFeedback, `handBackRequest`, `parkTaskRequest` |
| `packages/api-contract/src/views.ts` (modify) | `parkedExternal` on `TaskView`, `coveredByUpload` on the planned-task view |
| `packages/application/src/services/contribution-service.ts` (create) | ingest uploads → Evidence, snapshot links via an integration |
| `packages/application/src/services/planning-service.ts` (modify) | intake before planning; thread `preexistingArtifacts` |
| `packages/application/src/planning/prompt.ts` (modify) | uploads + "skipped" instruction |
| `packages/application/src/planning/materialize.ts` (modify) | materialize `skipped` → `SKIPPED` tasks |
| `packages/application/src/services/mission-service.ts` (modify) | `parkTask` (continue elsewhere) + `handBack` |
| `packages/application/src/engine/scheduler.ts` (modify) | confirm non-`wait` `AWAITING_EXTERNAL` is left parked (test only) |
| `apps/daemon/src/routes.ts` (modify) | upload / park / hand-back routes |
| `apps/desktop/src/renderer/src/lib/daemon.ts` (modify) | client methods; base64 binary upload body |
| `apps/desktop/src/renderer/src/screens/NewMission.tsx` (modify) | upload control |
| `apps/desktop/src/renderer/src/components/RequestChanges.tsx` (modify) | attachments in the composer |
| `apps/desktop/src/renderer/src/components/HandoffCard.tsx`, `screens/artifacts/ArtifactReader.tsx` (modify) | workspace-link rendering |
| `apps/desktop/src/renderer/src/screens/mission/FeedPane.tsx`, `components/HandoffCard.tsx` (modify) | Continue elsewhere / Hand back actions |
| `apps/desktop/src/renderer/src/screens/mission/PlanPane.tsx` (modify) | "covered by your upload" skip rows |
| `scratch/p3-check.mjs` (create) | offline check |
| `scratch/acceptance/p3/` (create) | real-app acceptance D1–D7, reusing the P0 libraries |

---

### Task 1: Domain — contribution, attachment, workspace link, skipped stage

**Files:**
- Create: `packages/domain/src/entities/contribution.ts`
- Modify: `packages/domain/src/entities/feedback.ts`, `entities/artifact.ts`, `plan.ts`
- Modify: `packages/artifacts/src/handoff.ts`
- Create: `scratch/p3-check.mjs`; Modify: `scripts/run-checks.mjs` (add `p3-check`)

**Interfaces produced:**

```ts
// domain/entities/contribution.ts
export type OutsideContribution =
  | { readonly kind: 'file'; readonly filename: string; readonly mediaType: string; readonly bytes: Uint8Array }
  | { readonly kind: 'link'; readonly url: string; readonly label?: string };

// domain/entities/feedback.ts — replaces the P2 stub. Stored shape only: bytes are
// never JSON, so a file contribution is first ingested to an Evidence artifact.
export type FeedbackAttachment =
  | { readonly kind: 'artifact'; readonly artifactId: string }
  | { readonly kind: 'link'; readonly url: string; readonly label?: string };

// domain/entities/artifact.ts — extract `HandoffLink` from the inline
// `ArtifactHandoff.links` type (today it is anonymous); add `path`.
export interface HandoffLink {
  readonly label: string;
  readonly url: string;        // http(s) for every kind except 'workspace'
  readonly kind: HandoffLinkKind;
  readonly path?: string;      // only when kind === 'workspace'
}

// domain/plan.ts
export interface SkippedStage { readonly stage: string; readonly artifactId: string; readonly reason: string }
// MissionPlan gains: readonly skipped: readonly SkippedStage[];
```

**Requirements:**
- `handoffSchema` gains `links[].path` (`z.string().min(1).optional()`), allowed only when `kind === 'workspace'` — enforce with `.superRefine` so an `other`/`pr`/`preview`/`doc` link with a `path` is a path-specific issue (`handoff.links[n].path: only a workspace link may carry a path`). A `workspace` link keeps `url` required but it may now be a non-http path *placeholder*; the real path validation happens at the service layer against repository roots (Task 3/4), because zod cannot see the filesystem.
- `validateMissionPlan` gains a rule: every `skipped[].stage` must name a known role and every `skipped[].artifactId` must be a known preexisting artifact type; unknown ones are warnings, not rejections.
- `FeedbackAttachment` is exported from `domain` so `feedback-rounds.ts` and the repository stop typing it as `Record<string, unknown>`.

**Check (`scratch/p3-check.mjs`, section "domain"):**
- a `workspace` link with a `path` parses; a `pr` link with a `path` is rejected with the exact issue path above;
- `OutsideContribution` and `FeedbackAttachment` type-level checks (a file vs link discriminated union);
- `validateMissionPlan` accepts a valid `skipped` and warns on an unknown stage/artifact.

- [ ] Step 1: write the failing check section
- [ ] Step 2: `npm run build && node scratch/p3-check.mjs` → see it fail
- [ ] Step 3: implement
- [ ] Step 4: `node scratch/p3-check.mjs && node scripts/run-checks.mjs`
- [ ] Step 5: commit `feat(domain): outside contributions, feedback attachments, workspace links, skipped stages`

### Task 2: Upload ingestion, intake, and the planner's "skipped"

**Files:**
- Create: `packages/application/src/services/contribution-service.ts`
- Modify: `packages/application/src/services/planning-service.ts`
- Modify: `packages/application/src/planning/prompt.ts`, `planning/materialize.ts`
- Modify: `packages/application/src/services.ts` (register the new service)

**Interfaces produced:**

```ts
// contribution-service.ts
export interface ContributionService {
  ingest(missionId: MissionId, caller: Caller, uploads: readonly OutsideContribution[]): Promise<readonly ArtifactManifest[]>;
  snapshot(missionId: MissionId, link: OutsideContribution & { kind: 'link' }): Promise<ArtifactManifest>; // Evidence + ExternalRef
}
```

**Requirements:**
- **`ingest`** pins each upload as an `Evidence` artifact: `artifactStore.write({ …, type: 'Evidence', body: bytesOrBody, mediaType, summary: derived, sourceRefs })` then `artifacts.create({ …manifest, authorId, recordedBy, responsibleId, taskId: null })`, with `sourceRefs` carrying `{kind:'file'}` for a file or `{kind:'url', value}` for a link. Files are content-addressed and deduplicated by the store (already true for `Evidence` + `Uint8Array`).
- **Intake** runs inside `planning-service.#planFrom`, before `materializePlan` and before `tasks.replaceAll`: for each ingested `Evidence` (and each `link` contribution), invoke an agent using the existing planner ladder (`#planWith`'s mechanism, not a new executor) with the fixed objective *"Turn the uploaded input into `<type>`, preserving its content; the Evidence is the source of truth."* The role is mapped per the spec table (`product`/`design`/`development`). The typed artifact is stored with `taskId: null`, authored by `RUNTIME_ACTOR`, `recordedBy: SYSTEM_ACTOR`, with a handoff whose `links` include the original link or a `workspace` link for a local file. Intake is single-pass, best-effort: on failure the `Evidence` remains and planning proceeds without a skip.
- **`preexistingArtifacts` threading:** collect the typed artifact types (and the ingested `Evidence`) into a `ReadonlySet<ArtifactType>` and pass it through `#planWith`'s validation context so `validateMissionPlan` treats those inputs as satisfied (the field already exists in `PlanValidationContext`; it is simply not threaded today).
- **Planner prompt:** `buildPlannerPrompt` gains a "What you may skip" instruction: *"An upload already covers a stage when a preexisting artifact of that stage's output type exists. Omit the stage and list it under `skipped` with the artifact that covers it."* The plan JSON shape in `parse.ts` gains `skipped` (array of `{stage, artifactId, reason}`), defaulting to `[]`.
- **Materialization:** `materializePlan` turns each `skipped` entry into a `SKIPPED` task (`key: '_skip_<n>'`, `roleId` = the stage's role, `status: 'SKIPPED'`, `statusReason: 'Covered by your upload: <artifactId>'`), so dependents and the DAG renderer see it as satisfied and the Plan tab can label it distinctly (Task 6).

**Check (section "intake", offline, scripted fake runtime):**
- a mission created with an uploaded spec runs intake → a `ProductSpec` artifact with `taskId: null` and a `workspace`/`url` link; the plan omits the product stage and materialises a `SKIPPED` task with the reason naming the artifact;
- a bare link that no integration can read: intake pins the `Evidence` but no typed artifact; planning proceeds with no skip;
- `preexistingArtifacts` is threaded: a plan whose required input is the uploaded type validates without "missing input";
- two identical uploads produce one content-addressed Evidence blob (sha256 dedup).

- [ ] Steps: failing section → implement → offline suite → commit `feat(application): upload ingestion, intake and planner-skipped stages`

### Task 3: External hand-back and parking

**Files:**
- Modify: `packages/application/src/services/mission-service.ts`
- Modify: `packages/application/src/engine/scheduler.ts` (verification only)
- Modify: `packages/application/src/support/identity.ts` if a new actor form is needed (not expected)

**Requirements:**
- **`parkTask(caller, taskId)`** ("Continue elsewhere"): guard the task is an `agent` task in a parkable state (`RUNNING`, `READY`, or a parked-awaiting state), cancel the active run (reuse the cancel path that stops a run and keeps the worktree/branch), set `status: 'AWAITING_EXTERNAL'`, `statusReason: 'Continued in <tool>'` (the tool inferred from the task's latest `workspace` link, else "an external tool"), and record a `task.parked_external` timeline event. The scheduler already excludes `AWAITING_EXTERNAL` from the concurrency ceiling; add a regression check that a non-`wait` `AWAITING_EXTERNAL` task is neither promoted nor dispatched (it is woken only by `handBack`).
- **`handBack(caller, taskId, request)`** generalises `completeTask`:
  1. Guard: `task.status === 'AWAITING_EXTERNAL'` (or the existing human path), and a contribution or note is present.
  2. `actorFor(...)` → `{ actorId, recordedBy }`.
  3. Pin the contribution via `ContributionService.ingest`/`snapshot` → an `Evidence` artifact with an `ExternalRef` (§3 of the spec). If the contribution is a **link no integration can read**, refuse (`PRECONDITION_FAILED`, "attach an export") unless a file export is attached.
  4. Write the task's `expectedOutputs` as the typed artifact(s) of this round, reusing `deriveHandoff` for the note or a filled handoff for a structured hand-back, with `supersedes: previous?.id`, `round: task.round ?? 1` bumped per P2, `authorId/recordedBy` from `actorFor`, and the pinned `Evidence` referenced from the typed artifact's `sourceRefs`.
  5. `rounds.onPersonCompleted(task, scope)` (addresses open notes without citation), then `reviews.onRoundPassed({ gate: null, checks: [] })`, then the status write and `scheduler.wake()` — the same tail as `completeTask`.
- **Snapshot** is not a new entity: it is the pinned `Evidence` + its `ExternalRef` (git.commit / github.pr / url / file). The first integration capability to ship is `github.pr` (read the PR and store its diff/patch as the `Evidence`); `url` and `file` are always available without an integration.

**Check (section "handback", offline):**
- parking a `RUNNING` agent task lands it `AWAITING_EXTERNAL` with the reason and a `task.parked_external` event; the scheduler does not re-dispatch it;
- a hand-back with a file creates a human-authored round: `round` bumped, `supersedes` set, open notes addressed, the review pipeline runs, and downstream impact is reported;
- a bare unreadable link is refused; a link resolved by a (scripted) integration writes an `Evidence` with a `github.pr` `ExternalRef`;
- the hand-back's `Evidence` is content-addressed and immutable (re-ingesting the same bytes reuses the blob).

- [ ] Steps: failing section → implement → offline suite → commit `feat(application): external hand-back and parking`

### Task 4: API — requests, routes, client

**Files:**
- Modify: `packages/api-contract/src/requests.ts`, `views.ts`
- Modify: `apps/daemon/src/routes.ts`
- Modify: `apps/desktop/src/renderer/src/lib/daemon.ts`

**Interfaces produced:**

```ts
// requests.ts
// createMissionRequest gains: uploads: z.array(contributionRequestSchema).optional()
// giveFeedbackRequest gains: attachments: z.array(feedbackAttachmentRequestSchema).optional()
export const contributionRequestSchema;    // file: {filename, mediaType, base64} | link: {url, label?}
export const handBackRequest;              // { contribution?: …, note?: string, onBehalfOf? }
export const parkTaskRequest;              // { onBehalfOf? }

// views.ts
// TaskView gains: parkedExternal: { tool: string | null; since: string } | null
// planned task view gains: coveredByUpload: string | null   // artifactId, when SKIPPED by intake
```

**Requirements:**
- File bytes cross the wire as **base64 in JSON** (a `base64` string, not raw bytes), to avoid a multipart parser. `contributionRequestSchema` for a file is `{kind:'file', filename, mediaType, base64}`; the route decodes to `Uint8Array` before calling `ContributionService.ingest`. Cap decoded size (e.g. 50 MB) at the route.
- Routes, beside the existing task/feedback block: `POST /v1/tasks/:id/park` → `parkTaskRequest`; `POST /v1/tasks/:id/handback` → `handBackRequest`; uploads ride `POST /v1/missions` (creation) and `POST /v1/tasks/:id/feedback` (attachments) rather than a standalone upload route.
- `DaemonClient` methods: `parkTask(id)`, `handBack(id, body)`, and `createMission`/`giveFeedback` gain the new optional fields via their inferred request types (no signature change needed beyond the request type). Add a `#request` body helper that encodes `Uint8Array`→base64 when the caller passes a file (or leave encoding to the renderer, documented in Task 5).

**Check (section "api", HTTP over a seeded daemon):**
- `createMission` with an upload returns a mission whose intake ran (typed artifact exists, plan shows a skip);
- `park` then `handback` on a parked task returns the `TaskView` with `parkedExternal` cleared and `round` bumped;
- a `handback` with a bare unreadable link returns `PRECONDITION_FAILED` with the "attach an export" message;
- a >50 MB file is rejected before decode.

- [ ] Steps: failing section → implement → offline suite → commit `feat(api): uploads, parking and hand-back routes`

### Task 5: Desktop — upload controls and composer attachments

**Files:**
- Modify: `apps/desktop/src/renderer/src/screens/NewMission.tsx`
- Modify: `apps/desktop/src/renderer/src/components/RequestChanges.tsx`
- Modify: `apps/desktop/src/renderer/src/lib/daemon.ts` (base64 encoding of picked files)

**Requirements:**
- **New mission upload:** a new `Field` (label "Bring your own work", hint "A spec, design file, prototype, or a link — optional.") after the goal hero textarea. It holds a list of contributions: a file picker (a renderer `<input type="file">` read with `FileReader` into base64 — no new preload method needed) and a link input. Picked files are base64-encoded before `create.mutate`; the list is sent as `uploads`. The `ready` gate is unchanged (uploads remain optional).
- **Composer attachments:** `RequestChangesComposer` gains an attachments row mirroring the NewMission control. Attachments are sent in the `giveFeedback` payload. A file is first ingested (a client-side call to the new ingest route or by letting `giveFeedback` accept base64 directly — follow whichever Task 4 decided) so the feedback references an artifact id; a link is sent as-is.
- All controls use design tokens; new copy is reviewed against the clarify/consistency standards already in the repo.

**Check:** desktop typecheck and `check:design`. A unit assertion in `p3-check` for the renderer's base64 encoding helper (put the helper in `lib/` and test it; if the renderer cannot import a shared module, duplicate a tiny pure copy and justify it in the report).

- [ ] Steps: implement → typecheck/design → screenshots via the harness → commit `feat(desktop): upload controls on mission creation and feedback`

### Task 6: Desktop — hand-back actions, workspace links, skip rows

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/HandoffCard.tsx`, `screens/mission/FeedPane.tsx`
- Modify: `apps/desktop/src/renderer/src/screens/artifacts/ArtifactReader.tsx`
- Modify: `apps/desktop/src/renderer/src/screens/mission/PlanPane.tsx`

**Requirements:**
- **Continue elsewhere / Hand back:** on a parkable `agent` card, a "Continue elsewhere" action calls `parkTask`; a parked card (`AWAITING_EXTERNAL` with `parkedExternal`) shows "Waiting for external work" as its headline/status and a "Hand back" action that opens a small dialog (reuse the composer host or a `Modal`) accepting a note + contribution, then calls `handBack`. Wire through `FeedPane.card()` the same way `onDoIt`/`onReplan` are wired.
- **Workspace links:** both link renderers stop filtering `/^https?:\/\//i` for `kind === 'workspace'`; a `workspace` link renders "Open workspace ↗" and resolves its `path` to an absolute path through the daemon (`ArtifactStorePort.resolvePath`, exposed via a `DaemonClient` method), then reveals it with `window.tandemise.revealInFinder` (already in the bridge) rather than `openExternal`. Non-workspace links keep the existing external opener.
- **Skip rows:** `PlanPane.TaskCard` renders a `SKIPPED` task whose `coveredByUpload` is set as "Spec · covered by your upload" (no status dot for a live task; use a muted row). Reuse `taskBadge`/`taskTone` for `SKIPPED`, adding only the upload-specific label.

**Check:** desktop typecheck and `check:design`. Visually verify with the harness (`/tmp/tdm-p3`, CDP 9337): screenshot a parked card, the hand-back dialog, a workspace link button, and a skip row. Read every PNG.

- [ ] Steps: implement → typecheck/design → harness screenshots → commit `feat(desktop): hand-back actions, workspace links and upload skip rows`

### Task 7: Real-app acceptance D1–D7 (controller)

The controller runs this in the main session. It extends the suite as `scratch/acceptance/p3/` using the P0–P2 libraries:
- `run-all.mjs` gains a `--p3` branch adding the P3 scenario files to the ordered list;
- `scripted-agent.mjs` (or a sibling) gains an intake mode that reads a pinned `Evidence` and writes the typed artifact, and a mode that emits a `workspace` link;
- `ctx.mjs` gains `attachFile` (a `DataTransfer`-based file-input setter — the existing `fill` helper sets text value, which does not work for `<input type=file>`), `clickContinueElsewhere`, and `handBack` helpers.

Runs D1–D7 from the spec on a fresh install in one uninterrupted run, fixes findings through dispatched fixes, and commits evidence to `docs/superpowers/evidence/2026-09-16-p3/`.

---

## Rulings made while planning

1. **No migration.** P3 fits the existing schema (`feedback.attachments` from 010, `artifacts`/`artifact_links`/`supersedes`). A new migration would be a sign of scope creep.
2. **Intake is a pre-planning service step, not a DAG task.** Its typed artifacts carry `taskId: null` (the `MissionPlan` precedent) and are surfaced to the planner as `preexistingArtifacts`. No new `executor` value.
3. **A skipped stage is materialised as a `SKIPPED` task** with `statusReason: 'Covered by your upload: …'`, so the DAG, downstream satisfaction, and the Plan tab all work without new storage. `MissionPlan.skipped` is the planner's *declaration*; materialization converts it.
4. **Hand-back is `completeTask`, generalised.** No new executor; "Continue elsewhere" parks an agent task by cancelling its run and setting `AWAITING_EXTERNAL`. The scheduler needs no re-adoption path — `AWAITING_EXTERNAL` is already parked — only a regression test that it stays parked.
5. **File bytes cross the wire as base64 JSON**, not multipart, to reuse the existing `#request` transport; the route decodes and size-caps.
6. **`FeedbackAttachment` (stored) ≠ `OutsideContribution` (wire).** Bytes are never JSON, so a file attachment is ingested to an `Evidence` artifact first and the feedback stores an `{artifactId}` reference; a link is stored as a URL.
7. **A snapshot is `Evidence` + `ExternalRef`, nothing new.** The first integration resolver is `github.pr`; `url` and `file` need no integration.
8. **Workspace-link `path` is validated at the service layer** (against repository roots), not in zod, because zod cannot see the filesystem.

## Self-review

**Spec coverage:**

| Spec section | Task(s) |
|---|---|
| §1 One shape (file \| link, pinned-then-typed) | T1, T2 |
| §2 Uploads (creation/feedback/hand-back; intake; planner skip) | T1, T2, T4, T5 |
| §3 The snapshot (Evidence + ExternalRef) | T2, T3 |
| §4 External hand-back (park, hand back, human-authored round) | T3, T4, T6 |
| §5 Workspace links become real | T1, T6 |
| §6 Attribution | T2, T3 |
| §7 API and storage changes | T4 |
| §8 Testing (offline + real app D1–D7) | T1–T7 |

**Names used consistently:** `OutsideContribution`, `FeedbackAttachment`, `HandoffLink.path`, `SkippedStage`, `MissionPlan.skipped`, `ContributionService`, `ingest`, `snapshot`, `parkTask`, `handBack`, `parkedExternal`, `coveredByUpload`.
