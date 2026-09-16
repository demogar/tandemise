Here is the summary.

---

# Artifact + Handoff + Evidence/Snapshot System

## 1. Artifact types and schemas

Artifact types are a closed union in `packages/domain/src/entities/artifact.ts` (`ARTIFACT_TYPES`, 14 members): `ProblemBrief`, `ProductSpec`, `DesignBrief`, `ArchitecturePlan`, `ImplementationPlan`, `ChangeSet`, `ReviewReport`, `QAPlan`, `QAReport`, `ReleaseCandidate`, `DecisionRecord`, `FinanceReport`, `Evidence`, `MissionPlan`.

Zod front-matter contracts live in `packages/artifacts/src/schemas.ts`. A shared `base(type)` spreads into every schema: `type` (literal), `schemaVersion` (int, default 1), `title` (1–60 chars), and **`handoff`** (preprocessed: a missing block parses as `{}` so the retry prompt names `handoff.headline`, not the whole block). So **every** artifact type carries a `handoff` block; `hasSchema()` returns true for all 14.

Per-type additions:

- **ProblemBrief** — `successMetric` (non-empty); `evidence` (array of non-empty refs, default `[]`).
- **ProductSpec** — `acceptanceCriteria[]` (≥1, each `{id, statement}`); `nonGoals[]`.
- **DesignBrief** — `flows[]` (≥1); `accessibility[]`; `openQuestions[]`.
- **ArchitecturePlan** — `components[]` (≥1); `risks[]` (`{severity: high|medium|low, description}`); `migration` (string).
- **ImplementationPlan** — `steps[]` (≥1, each `{id, summary, files[], dependsOn[]}`).
- **ChangeSet** — `branch`; `commits[]`; `filesChanged` (int ≥0); `testsRun[]`; `knownLimitations[]`.
- **ReviewReport** — `verdict` (`pass|needs_changes|fail`); `reviewedRef`; `findings[]` (`{severity: blocking|major|minor|nit, title, location}`).
- **QAPlan** — `cases[]` (≥1, `{id, criterion, method: manual|automated|browser|accessibility|performance}`).
- **QAReport** — `results[]` (≥1, `{criterion, outcome: PASS|FAIL|SKIP, evidence}`); `blockingDefects` (int ≥0).
- **ReleaseCandidate** — `ref`; `checks[]` (`{name, outcome}`); `unresolvedRisks[]`; `rollback`.
- **DecisionRecord** — `status` (`proposed|accepted|rejected|superseded`); `decision`; `owner`; `supersedes` (string).
- **FinanceReport / Evidence / MissionPlan** — `base(type).passthrough()`; no machine-read facts of their own, but unknown keys are kept (not dropped) for backward compatibility.

## 2. The handoff block (`packages/artifacts/src/handoff.ts`)

`HANDOFF_LIMITS`: title 60, headline 90, point 140, **points 3**, needs 140, changedWhat 140, **changed 3**, linkLabel 40, **links 5**.

`handoffSchema` fields (all normalized: absent → null/`[]`/kind `other`):

- `headline` — trimmed 1–90 chars.
- `points` — ≤3, each 1–140 chars.
- `needs` — optional string (1–140); a blank string is preprocessed to `null` (`blankAsAbsent`), so `needs: ""` means "nothing needed".
- `changed` — ≤3, each `{what (1–140), feedback (nullable, blank→null)}`.
- `links` — ≤5, each `{label (1–40), url, kind}`.

`url` is `httpUrl`: must be a full URL and `http://`/`https://` only (a `file:`/`javascript:` link would be a way to run something locally, per the comment). `kind` is `z.enum(HANDOFF_LINK_KINDS)` default `'other'`, where `HANDOFF_LINK_KINDS = ['workspace','preview','pr','doc','other']` (`domain/src/entities/artifact.ts`).

`deriveHandoff(source)` builds a handoff for **human-authored** text (no YAML): the headline is the first sentence (word-boundary cut with ellipsis, headings dropped, abbreviation/initial-aware sentence-end detection), with empty `points`/`needs`/`changed`/`links`.

## 3. Versioning, supersession, and storage

### Filesystem bodies (`packages/artifacts/src/store.ts`)

Layout under the workspace artifact root: `index/<artifactId>.json` (manifest sidecar, id-resolvable without the DB), `<missionId>/<type>/<id>.md` (structured bodies, human-browsable), `blobs/<aa>/<sha256>` (content-addressed, two-char fan-out).

Two load-bearing rules: **`contentRef` is never absolute** (a path relative to the artifact root or `sha256:<hex>`), and **Evidence is content-addressed** — `contentAddressed = (type === 'Evidence' || body instanceof Uint8Array)`, so identical screenshots captured by three QA runs are one file on disk, identity = hash. Writes are temp-then-rename (atomic); paths are `assertInsideRoot`-checked against `..` traversal.

### Manifest (`domain/src/entities/artifact.ts`)

`ArtifactManifest` fields: `id, workspaceId, missionId, taskId, createdByRunId, type, title, contentRef, mediaType, sha256, byteSize, schemaVersion, sourceRefs, supersedes, summary, createdAt, authorId?, responsibleId?, recordedBy?, handoff?, wordCount?, overBudget?, round?, withdrawnAt?`.

Note the three distinct "who" fields: **authorId** (who did it), **responsibleId** (who answers for it), **recordedBy** (who put it on record — differs from author "when a person uploads for an agent").

### SQLite (`packages/persistence/src/repositories/artifact-repository.ts`, migrations)

Columns (`COLUMN_LIST`): `id, workspace_id, mission_id, task_id, created_by_run_id, type, title, content_ref, media_type, sha256, byte_size, schema_version, supersedes, superseded_by, summary, created_at, author_id, responsible_id, recorded_by, handoff (JSON), word_count, over_budget (0/1), round, withdrawn_at`.

Versioning is a **two-pointer chain**: `supersedes` (forward) plus denormalized `superseded_by` (back-pointer, for indexed "latest live artifact" lookup). `create()` sets the back-pointer on the replaced row when `manifest.supersedes` is set. `latest()` reads `superseded_by IS NULL AND withdrawn_at IS NULL`; `search`/`listRecent` exclude superseded rows by default (`includeSuperseded` opt-in); `withdraw()` stamps `withdrawn_at` **and clears back-pointers** so the versions a withdrawn output had replaced are live again.

`artifact_links` (separate from handoff links) stores `sourceRefs`/`ExternalRef`: `{ordinal, kind, value, label}` where `kind` ∈ `git.commit|git.branch|github.pr|github.issue|url|file` — "pointers into systems that own the real truth," normalized for "what did we produce for PR #42?" lookups (`ix_artifact_links_target`).

FTS: `artifacts_fts` over `title, summary, handoff_text`; `handoff_text` is a generated virtual column joining headline + `points[0..2]` + `needs` (guarded by `json_valid`).

Migrations: **001** creates the base table + `artifact_links` + FTS; **008** adds `author_id`/`responsible_id`/`recorded_by`; **009** adds `handoff`/`word_count`/`over_budget`/`handoff_text`; **010** adds `round`/`withdrawn_at`.

### Writing paths

Agent outputs are harvested (`application/src/engine/harvester.ts`): parse → validate → measure → `store.write` (filesystem) → `artifacts.create` with `handoff`, `wordCount`, `overBudget`, `round`, `authorId=RUNTIME`, `recordedBy=SYSTEM`. Human-completed tasks (`application/src/services/mission-service.ts` ~line 400) write each `expectedOutputs` with `deriveHandoff`, `mediaType: 'text/markdown'` (so the reader can show it), `supersedes: previous?.id`, `overBudget: false` (a person's output is never held to a budget). Both supersede in the same breath as the write via `supersededBy(...)`.

## 4. What "Evidence" and "snapshot" are today

**Evidence** is a first-class artifact type ("supporting evidence: screenshots, logs, videos, test output"). Schema is `base('Evidence').passthrough()` (title + handoff only). Default media type is `application/octet-stream`; bodies are content-addressed `sha256` blobs, deduplicated.

**Tool evidence** (`packages/integrations-core/src/tool.ts`): `ToolEvidence {filename, mediaType, bytes, title}` is what tools return (e.g. `browser.screenshot` returns PNG bytes in `packages/browser/src/tools.ts`). The comment is explicit: persisting them as an Evidence artifact needs a mission + artifact store "which live a layer up" — the browser package does **not** persist; the application layer does. `ApprovalEvidence` (separate) is `{kind, label, value}` text/diff/artifact markers shown on approval cards.

**"snapshot"** in the codebase is *not* a file/version snapshot concept: it means (a) `browser.snapshot` — an accessibility-text snapshot of a page (ephemeral, `browser/src/tools.ts`), and (b) staffing/task "snapshot" — a frozen record of resolved staffing (`application/src/engine/staffing-resolver.ts`, `staffing.ts`). There is **no representation of an external-link/workspace snapshot** yet — that is the P3 gap.

## 5. Handoff `links` and the UI

`links` = `{label, url, kind}`. `kind: workspace` means "the real work lives here" (collaboration roadmap), but `url` is still validated `http(s)`-only.

Rendering (both `apps/desktop/src/renderer/src/screens/artifacts/ArtifactReader.tsx` and `components/HandoffCard.tsx`): the component filters to `/^https?:\/\//i` and renders `{label} ↗` buttons calling `window.tandemise.openExternal(link.url)`. **`kind` is not used to change rendering** — it is stored metadata; the UI treats every link as an external http(s) URL. `sourceRefs` (the `ExternalRef` pointers) render separately as muted chips (branch/link icon + `label ?? value`). Binary artifacts that can't be shown inline offer "Reveal in Finder" via `resolvePath` (`ArtifactStorePort.resolvePath`).

## Implications for P3 (uploads + hand-backs)

- **Uploads** map cleanly onto the existing **Evidence** type: content-addressed, deduplicated, byte-agnostic, already one of the 14 types. An intake task just needs to write uploaded files through `artifactStore.write` + `artifacts.create`. `recordedBy` vs `authorId` already encodes "a person uploads for an agent."
- **Hand-backs** already have a partial model: `mission-service.completeTask` writes human-authored outputs with `deriveHandoff` and `supersedes: previous`. The roadmap's "hand-back = human-authored round" slots into this path plus the `supersedes`/`superseded_by` version chain (and `withdrawn_at` for overtaken work).
- **Snapshots are the real gap.** Nothing pins an external version. `ExternalRef`/`artifact_links` (git.commit, github.pr, url, file) is the natural place to record the pinned reference; the roadmap says the integration "snapshots the referenced version into Evidence" — reuse the `ToolEvidence`→`Evidence` path.
- **`kind: workspace` is reserved but unimplemented.** The handoff `httpUrl` constraint and the UI's http(s)-only filter block local/workspace links today. P3 needs to widen link URL validation (or resolve a workspace path) and render `kind` differently (e.g. "Open workspace" resolving via `resolvePath` rather than `openExternal`), since "workspace" links should point at local files/worktrees, not `http://`.
- **Attachments** are already reserved: `feedback.attachments` (`domain/src/entities/feedback.ts`, "Reserved for P3 (uploads, hand-backs); always empty in P2").
