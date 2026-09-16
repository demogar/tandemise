# P3: Outside contributions — uploads, hand-backs, and snapshots

Status: design, 2026-09-16. Parent: [collaboration roadmap](2026-09-13-collaboration-roadmap.md). Builds on P1 (`feat/p1-handoff-feed`) and P2 (`feat/p2-feedback-rounds`).

## Problem

Tandemise starts every mission from one sentence and does all the work in its
own runtimes. Real work does not work that way:

- **You cannot bring your own work in.** A spec you already wrote, a Figma
  file, a Lovable prototype, a branch you started — none of it can seed a
  mission. The planner re-derives what you already have. Mission creation
  (`createMissionRequest`) is text-only: goal, constraints, success criteria,
  workflow inputs, base branch. There is no file or link field.
- **You cannot take work out and hand it back.** If the real work happens in
  Figma, your editor, or a pull request, there is no way to park the task
  there and accept the result back. `AWAITING_EXTERNAL` exists but only means
  "a `wait` step is polling a command"; it returns success/failure, never
  content.
- **Nothing is pinned.** When work lives outside and moves on, Tandemise has
  no snapshot of the version downstream work actually used. `run_inputs` stores
  an artifact *id* (immutable), but nothing captures an external version —
  `ExternalRef` and the `Evidence` artifact type exist, and are unused for this.

The hooks are all there and deliberately reserved: `feedback.attachments`
("Reserved for P3"), `AWAITING_EXTERNAL`, `ExternalRef.kind: 'file'`,
`handoff.links[].kind: 'workspace'`, `preexistingArtifacts` in plan
validation, and the `recordedBy`/`authorId` split on every artifact.

## Goal

A person can hand work *in* (an upload) and hand it *back* (an external
hand-back). Each lands as a typed artifact with an author and a pinned
snapshot, so downstream work consumes exactly what was handed in — no
copy-paste between tools.

## Not in P3

- Accounts, invites, and multi-seat teams → P4. The solo-owner path is the
  one proven; team scenarios (a teammate hands back) reuse `onBehalfOf` and
  stay covered offline only.
- Live multi-user editing of the same artifact.
- Pulling a *feed* of comments from external tools (PR review comments, Figma
  comments) as feedback items. A hand-back captures the state at hand-back
  time, not the ongoing comment thread. Revisit as P3.x if needed.
- Arbitrary file types for downstream *agents*: an upload is always reduced to
  a typed artifact (with an `Evidence` blob) before any downstream task reads
  it.

## 1. One shape for everything handed across the boundary

An **outside contribution** is any of:

```ts
type OutsideContribution =
  | { kind: 'file'; filename: string; mediaType: string; bytes: Uint8Array }
  | { kind: 'link'; url: string; label?: string };
```

A file is bytes the daemon can store itself. A link points at an external
system and is only useful when something can read it; when nothing can, the
link must be accompanied by a file export (see §4).

Every contribution is accepted at three places, and in all three it goes
through the same two steps:

1. **Pinned first.** The contribution is stored as an `Evidence` artifact —
   content-addressed, deduplicated, with `recordedBy` = the person who handed
   it in and `authorId` = whoever the work is attributed to (the person, or
   `onBehalfOf`). This is the snapshot of *what was handed in*, and it never
   changes.
2. **Typed second.** An intake step turns the `Evidence` into the typed
   artifact(s) the mission actually consumes, each with a handoff. Downstream
   work reads the typed artifact; the `Evidence` remains the source of truth.

`Evidence` is already content-addressed and byte-agnostic (`store.ts`), and
`recordedBy` already exists "for a person uploads for an agent" — nothing new
is needed for step 1 except the write path.

## 2. Uploads

### Where they are accepted

- **Mission creation** (`createMissionRequest` gains `uploads: OutsideContribution[]`).
- **Feedback** (any note, via the P2 composer — `feedback.attachments` stops
  being `[]`).
- **Hand-back** (§4).

### Intake

At mission creation, intake runs **before planning**. Uploads are first pinned
as `Evidence`, then an **intake task** converts each one into the typed
artifact that owns its content. The intake task is an ordinary agent task whose
role is the one that produces that artifact type:

| Upload maps to | Intake role | Produces |
|---|---|---|
| A spec / brief / doc | `product` | `ProductSpec` or `ProblemBrief` |
| A Figma file, image, prototype link | `design` | `DesignBrief` (+ the `Evidence`) |
| A branch, PR, or code | `development` | `ImplementationPlan` (or a `ChangeSet` when it is already code) |
| Anything else | `product` | `ProblemBrief` |

The intake task's objective is fixed: *"Turn the uploaded input into `<type>`,
preserving its content; the Evidence is the source of truth."* It reads the
`Evidence` (text, or the bytes if a runtime can see them) and writes the typed
artifact with a handoff, whose `links` include the original link or a
`kind: workspace` link when the upload was a local file.

Intake is a **single pass, best effort**. If it fails or the runtime cannot
read the upload, the pinned `Evidence` remains and planning proceeds without a
skip; the worst case is the stage runs normally as it does today.

### Planner may skip, and must say so

After intake, the typed artifacts are passed to planning as
`preexistingArtifacts` (the validation already accepts these). The planner
prompt gains one instruction: *"An upload already covers a stage when a
`preexisting` artifact of that stage's output type exists. Omit the stage, and
name it under `skipped` with the artifact it was covered by."* The plan shape
gains `skipped: [{ stage, artifactId, reason }]`, shown on the Plan tab as
"Spec · covered by your upload" rather than a task row.

## 3. The snapshot

A **snapshot** pins an external version so downstream work uses exactly it.
There is no snapshot entity; a snapshot is the combination of two things that
already exist:

- an `Evidence` artifact holding the captured content (a file the person
  attached, or bytes an integration fetched), and
- an `ExternalRef` on that artifact — `artifact_links` already stores
  `{kind: git.commit | git.branch | github.pr | github.issue | url | file,
  value, label}`.

Rule: **every outside contribution's pinned `Evidence` carries at least one
`ExternalRef`.** A file upload gets `kind: 'file'` (the stored blob path). A
link gets `kind: 'url'` plus, when an integration can resolve it, the concrete
ref it resolved to (`github.pr`, `git.commit`, …).

Because downstream consumes via `run_inputs`, which points at the immutable
`Evidence` id, the snapshot is automatically what later tasks read. The redo /
keep dialog from P2 (`downstreamConsumers`) already asks the right question
when a new hand-back supersedes a consumed version.

## 4. External hand-back

### Parking: "I'll continue there"

An agent task whose work can leave the machine (one that produces a linkable
artifact — a design, a branch, a PR) gains a **"Continue elsewhere"** action on
its card. It:

- sets the task `AWAITING_EXTERNAL` with reason `Continued in <tool>`;
- writes the current output's `workspace` link (or the task's branch) as the
  handoff `links` entry the person will hand back against;
- records a timeline event `task.parked_external`.

This **extends** `AWAITING_EXTERNAL` beyond `executor: 'wait'`. The scheduler's
wait-adoption keys off `executor === 'wait'`, so a parked hand-back task is
simply not re-adopted by that path; it is woken only by the hand-back arriving
(§4). `PARKED_TASK_STATUSES` already keeps it out of the concurrency ceiling.

### Handing back

The parked card shows one control: **"Hand back"**. It accepts a note and a
contribution (file or link). Handing back creates a **human-authored round** —
the same path as `MissionService.completeTask`, generalized to accept content
that is not person-typed text:

- Guard changes from `executor === 'human'` to "a hand-back is permitted on a
  task parked `AWAITING_EXTERNAL`" (plus the existing human-task path).
- The contribution is pinned as `Evidence` (§1) with an `ExternalRef` (§3).
- If the contribution is a **link** an integration can read (GitHub PR, Figma,
  a repo path), the integration fetches the referenced version and that fetched
  snapshot is the `Evidence`. If **no integration can read it, an attached
  export is required** — the "Hand back" control refuses a bare unreadable link.
- The task's `expectedOutputs` are written as the typed artifact(s) the step
  declared, reusing `deriveHandoff` for person text or a filled handoff for a
  structured hand-back, with `supersedes: previous?.id`, `round` bumped per P2,
  and `authorId`/`recordedBy` set from the person (or `onBehalfOf`).
- `onPersonCompleted()` runs, addressing open notes without id citation, and
  the review pipeline runs exactly as for any other round.

The P2 downstream-impact dialog then offers redo / keep for any task that
consumed the superseded version.

### What a hand-back is not

A hand-back does not resume the parked runtime session. The work moved to
another tool; what comes back is a fresh human-authored round, not a
continuation of the agent's session. (Session resume stays a P2 concern for
in-place rounds.)

## 5. Workspace links become real

P1 reserved `handoff.links[].kind: 'workspace'` for "the real work lives here",
but left the URL `http(s)`-only and the UI treating every link as external.
P3 makes them real:

- The handoff link schema gains a `path` field allowed **only** for
  `kind: 'workspace'`, validated as a path inside one of the project's
  repositories (or the workspace artifact root). `url` stays `http(s)`-only
  for the other kinds.
- The feed card and reader render `kind: 'workspace'` as **"Open workspace ↗"**
  resolving through the artifact store / filesystem (`resolvePath`), not
  `openExternal`.

This is the one schema change in P3: a `path` field inside the existing
`handoff` JSON for `kind: 'workspace'` links. There is **no migration** —
`handoff` is already a JSON column (migration 009) and `artifact_links` already
models `ExternalRef`.

## 6. Attribution

- Every contribution carries an **author** (who did the work) and a
  **recordedBy** (who handed it in), distinct per P0. For the solo owner both
  are you; `onBehalfOf` already threads the team case.
- An external person without a seat is recorded as the principal's
  `onBehalfOf` — no account is required, matching P0's "record on a person's
  behalf".
- The intake task's own output is authored by the runtime (`RUNTIME_ACTOR`),
  responsible to the owner, `recordedBy: SYSTEM` — as today's agent outputs.

## 7. API and storage changes

- `createMissionRequest` gains `uploads: OutsideContribution[]`.
- `CompleteTaskRequest` (or a sibling `HandBackRequest`) gains
  `contribution?: OutsideContribution` and a `note`.
- `feedback` already has `attachments TEXT DEFAULT '[]'` (migration 010); P3
  starts writing real `FeedbackAttachment` values into it.
- **No migration.** Nothing new in the `artifacts` table — `handoff` is JSON
  and `artifact_links` already models `ExternalRef`. The only additive change
  is the `path` field inside `handoff.links` for `kind: 'workspace'`
  (schema-level).
- `plan` gains `skipped` (a plan-shape field; stored with the existing plan
  JSON).

## 8. Testing

### Offline

`scratch/p3-check.mjs` (added to the offline checks) covers:

- the upload → Evidence → typed-artifact intake path over a scripted runtime;
- Evidence content-addressing (two identical uploads are one blob);
- `ExternalRef` written for file and link contributions, and the bare-link
  refusal when no integration can read it;
- hand-back on an `AWAITING_EXTERNAL` task lands a human-authored round with a
  bumped `round`, `supersedes`, and addressed notes;
- the planner `skipped` statement: a preexisting ProductSpec makes the plan
  omit the product stage and name it under `skipped`;
- `kind: 'workspace'` link validation (in-repo path ok, `../` and out-of-repo
  paths rejected);
- no migration is introduced: a P2 database opens unchanged at schema version 010.

### Real app

Proven in the real app; the harness extends as `scratch/acceptance/p3` reusing
the P0–P2 libraries. The scripted agent gains an "intake" mode that reads a
pinned `Evidence` and writes the typed artifact.

| # | Scenario | Must observe in the window |
|---|---|---|
| D1 | Mission created with an uploaded spec | Intake runs first, produces a `ProductSpec`; the Plan tab shows "Spec · covered by your upload" and no product task |
| D2 | "Continue elsewhere" on a design task | The card shows "Waiting for external work"; the timeline records `task.parked_external` |
| D3 | Hand back a link a connected integration can read | A human-authored round lands a `DesignBrief`; an `Evidence` snapshot holds the fetched version; downstream consumes it |
| D4 | Hand back a link nothing can read, with an attached export | The export becomes the `Evidence`; a bare unreadable link is refused with "attach an export" |
| D5 | Hand-back supersedes a version downstream used | The P2 impact dialog offers redo / keep for the consuming tasks |
| D6 | Workspace link | A `kind: 'workspace'` link renders "Open workspace ↗" and resolves to the local path, not an external URL |
| D7 | Attribution | The hand-back card shows "by You · responsible You" and the reader shows recorded-by correctly |

## Open questions (resolved in the implementation plan)

- Exact intake role mapping for ambiguous uploads (e.g. a generic PDF).
- Whether a `wait` task may also hand back, or only agent tasks.
- Media-type handling for binary typed artifacts (P3 generalizes `Evidence`
  beyond person-typed `text/markdown`).
- Which integrations ship with a "resolve this link to a snapshot" capability
  first (GitHub PR and a Figma/design connector are the candidates).
