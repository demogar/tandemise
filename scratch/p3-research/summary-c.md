# P2 Feedback/Rounds: What P3 "Outside Contributions" Builds On

## 1. Design spec (docs/superpowers/specs/2026-09-14-p2-feedback-rounds-design.md)

The P2 spec explicitly reserves P3's territory: **"Uploads, hand-backs from external tools, and snapshots → P3. The feedback shape reserves `attachments` for them."** Key decisions relevant to external contributions:

- **Round:** a task has rounds 1..n. Round 1 is the first *passed* attempt; retries (gate failures) happen *inside* a round. Stored as `mission_tasks.round`, `artifacts.round`, `runs.round`. The artifact `supersedes` chain links versions, so "v2" equals "round 2" when one artifact per type.
- **Feedback item** fields: `id` (`fb_…`), `taskId`, `artifactId?`, `authorId` (person *or* agent member), `recordedBy` (P0 on-behalf-of), `text` (1–4000), **`attachments` (`[]`, reserved for P3)**, `status` (`open`/`queued`/`in_round`/`addressed`/`dismissed`), `round`, `createdAt`.
- **A person completing a task** (C8, "your own step"): feedback on a `human` step while it waits attaches; completing it records the round and addresses all open notes — *"A person cannot cite ids: completing addresses every open or in-round note."*
- **Wake rules** (§4): notes to a running task are `queued`, delivered at pass end via `session_resume` in the same round, as an extra pass that doesn't count against `maxAttempts`. Only `end_of_pass` delivery; an `interrupt` wake is parked.
- **Parking/resuming**: `AWAITING_HUMAN` (person-staffed) and `AWAITING_EXTERNAL` (polling) are already task statuses. Rounds pass `continueSession` to resume a runtime session.
- **Evidence/snapshot** (§7, migration 010): new `run_inputs(run_id, artifact_id)` table records which artifacts a run actually consumed, written from the compiler's `includedArtifactIds` — "nothing records consumption today."

## 2. Feedback items & rounds in code (`packages/application`)

**Storage** — `packages/persistence/src/migrations/010_feedback_rounds.ts` creates `feedback` (with `attachments TEXT NOT NULL DEFAULT '[]'`, status CHECK constraint matching the spec), adds `round` columns, `runs.purpose` (`round`|`tighten`|`feedback`|`retry`), `artifacts.withdrawn_at`, and `run_inputs`. Nothing is copied/rebuilt.

**Feedback item domain shape** — `packages/domain/src/entities/artifact.ts` and the migration define statuses; the round contract is in `packages/application/src/support/feedback-rules.ts`:
- `feedbackEffectFor(task, pending, runs)` maps task state → effect: `queue` (RUNNING/AWAITING_INPUT), `attach` (PENDING/READY/AWAITING_HUMAN/start-card), `review` (AWAITING_APPROVAL output card), `reopen` (SUCCEEDED), `round_now` (FAILED/BLOCKED/CANCELLED/SKIPPED).
- `RoundBrief` carries `toAddress` (must-cite), `earlier` (context), `previous` (latest output per type), `redoneAfter` (upstream round that redid it).
- `checkRoundHandoff` validates: `changed` non-empty, no unknown ids, every owed id cited or declined (`Declined: <reason>`).

**Round engine** — `packages/application/src/engine/feedback-rounds.ts` (`FeedbackRounds` class):
- `record()` creates the item (`attachments: []` hard-coded — the P3 hook) and emits `feedback.given`.
- `impactOf()` reads `downstreamConsumers` (from `run_inputs`, transitively) with `via: 'record' | 'inferred'`.
- `beginRound()` (single unit-of-work): sets joining `open` items to `in_round`, bumps `task.round`, resets to `READY`, withdraws cards, emits `task.round_started`; `stopOvertaken()` cancels live dependents.
- `openRound()` promotes open notes → `in_round` and builds the brief; `promoteQueued()`/`requeue()` handle queued→in_round delivery.
- `onRoundLanded()` marks cited notes `addressed` (and flags kept consumers `needsAttention`); `onPersonCompleted()` addresses *all* open/in-round notes for a person's completion.
- `fromReviewFindings()` turns AI review blocking findings into feedback authored by the reviewer's agent member, capped at `MAX_REMEDIATION_CYCLES`.

**Service** — `packages/application/src/services/feedback-service.ts`: `give()` records the note then either starts a round or returns `DownstreamImpactView` for the dialog; `startRound()` confirms `redo`/`keep`.

## 3. A person completing a human task (`mission-service.ts:396` `completeTask`)

`packages/application/src/services/mission-service.ts` (around line 396–470):

- Guards: `task.executor === 'human'` and `status === 'AWAITING_HUMAN'`; resolves `actorId`/`recordedBy` via `actorFor` (P0 on-behalf-of).
- Claims an unclaimed pool task (assignee = whoever did the work).
- **Artifact write:** for each `expectedOutputs` type, writes `request.result` as `mediaType: 'text/markdown'` (a person's text, even for `Evidence`), `supersedes: previous?.id` (re-completion replaces like a retry), then `artifacts.create({ ...authorId: actorId, recordedBy, responsibleId, handoff: deriveHandoff(request.result), round: task.round ?? 1 })`.
- **Handoff:** `deriveHandoff` (`packages/artifacts/src/handoff.ts`) derives the headline from the person's first sentence — people aren't made to write YAML. Note: a person's handoff has `changed: []` (no feedback citations).
- `onPersonCompleted()` addresses all open/in-round notes (no id citation needed).
- `reviews.onRoundPassed()` runs the same review pipeline (blocking look, sign-off, checks) as an agent's output, with `gate: null, checks: []` for a person step.
- Sets final status (`SUCCEEDED` → reason `request.note?.trim() || 'Completed by you.'`).

**Key framing** (docstring): *"What they bring back is written as the artifact the step declared, so downstream consumes it the same way it consumes an agent's output… a design made in Figma and a design written by a model arrive at the next task in the same shape."* This is exactly P3's hand-back premise.

## 4. Parking / "continue elsewhere" today

There is **no general external hand-back mechanism yet** — P3 is the gap. What exists:

- **`AWAITING_EXTERNAL`** (`packages/domain/src/entities/task.ts:17`, `PARKED_TASK_STATUSES`) — a `wait` step polling an outside command. `packages/application/src/engine/scheduler.ts` `#startWait` sets `AWAITING_EXTERNAL: Waiting: <command>`, polls `waitPolicy.command` on `everyMs`, exit 0 ends the wait (no hand-back of *content*, only success/failure). In-memory: daemon restart re-adopts orphaned `AWAITING_EXTERNAL` waits (`scheduler.ts:275`).
- **`AWAITING_HUMAN`** — person-staffed steps (the closest existing "human hand-back", completed via `completeTask` above).
- **`AWAITING_INPUT` / `ask_human`** (`packages/application/src/tools/ask-human.ts`) — a *running* agent asks a question: task parked (`AWAITING_INPUT`), an `Approval` card is created, the answer flows back to the worker which then resumes (`unpark` → `RUNNING`). This is the model of "park a run, hand something to a person, resume the same run/session."
- **Session resume** (`packages/application/src/engine/task-executor.ts`): `session_resume` capability + `externalSessionId` + `continueSession`; `findResumableSession`/`resumableSession` (around lines 962, 1988–1999). Only `RESUMABLE` (interrupted) runs resume today; P2 extends this to continuing settled sessions for rounds.

So "park external work" today = `AWAITING_EXTERNAL` (poll, no artifact return) + `ask_human` (in-session question, person answers). There is no path for an external tool to *return an artifact* as a round.

## 5. Evidence / snapshot / consumed versions

- **`run_inputs`** (`packages/persistence/src/repositories/run-input-repository.ts`, migration 010) records `(run_id, artifact_id)` from the compiler's `includedArtifactIds` (`packages/context/src/compiler.ts:60`, `types.ts:74`). Written when a run starts (`task-executor.ts:417,603,976,1115`).
- **`downstreamConsumers`** (`packages/application/src/support/downstream.ts`) is the transitive "who consumed what" walk: latest run per task, its recorded inputs; for pre-010 runs (`round IS NULL`) it *infers* from `inputArtifacts` type match + `createdAt <= run.startedAt` (`via: 'inferred'`).
- **`Evidence`** is an artifact *type* (`packages/domain/src/entities/artifact.ts:12-13`) — "supporting evidence: screenshots, logs, videos, test output" — defaulting to `application/octet-stream`, unlike other types' `text/markdown`. A person's `Evidence` upload is forced to `text/markdown` in `completeTask` (because a person types text).
- **No version *snapshot* of consumed content exists** — `run_inputs` stores only the artifact *id* (immutable, content-addressed via `sha256` in `artifacts`). "Snapshot" in code refers to *staffing* snapshots (`staffing-resolver.ts`), not content versions. The `artifacts` table has `supersedes`/`superseded_by` for the version chain, plus `sha256`, `content_ref`, `schema_version`.

## Implications for P3

1. **The `feedback.attachments` column and the whole feedback shape are already reserved and built** (migration 010, `attachments TEXT DEFAULT '[]'`, hard-coded `[]` in `FeedbackRounds.record()`). P3 hand-backs/upload attachments slot in here without a migration.
2. **`completeTask` is the template for an external hand-back**: an external tool's returned output should be written through the *same* `artifactStore.write` + `artifacts.create({ authorId, recordedBy, round })` path so downstream consumes it identically. P3 must decide the `authorId`/`recordedBy` for a non-member external actor (today `RUNTIME_ACTOR`/`SYSTEM_ACTOR` cover agent/system, and `completeTask` requires a `human` executor + `AWAITING_HUMAN`).
3. **`AWAITING_EXTERNAL` is the parking status**, but today it only polls a shell command and returns success/failure — no artifact. P3 needs a hand-back path that lands content as an artifact and, likely, starts the task's next round (reusing `FeedbackRounds.beginRound`/`onPersonCompleted`/`onRoundLanded`).
4. **Rounds give the versioning story for free**: an external hand-back can be a round of the same task; `artifacts.round` + `supersedes` already chain versions, and `downstreamConsumers` (via `run_inputs`) already answers "who used the old version" for the redo/keep dialog.
5. **Evidence is the natural artifact type for uploads**, but its octet-stream default and the `completeTask` text/markdown override show media-type handling is where P3 must generalize (real binary uploads, not just person-typed text).
6. **Resume is a proven primitive** (`session_resume`, `continueSession`, `externalSessionId`), but currently gated to `RESUMABLE` runs and P2's round continuation; P3 "hand-back and continue elsewhere" will reuse it, but Codex declares resume yet lacks `session_resume` (spec §10) — fresh runs fall back.
7. **No content snapshot exists** — `run_inputs` stores only artifact ids (immutable + `sha256`). If P3 needs "snapshot the consumed version's *content*," that's new; today only the id/version chain is recorded.
