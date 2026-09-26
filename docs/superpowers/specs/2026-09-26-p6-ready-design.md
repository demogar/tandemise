# P6: Ready before planning (refinement and a Definition of Ready)

Status: design, 2026-09-26. Builds on P5 (the Done-when ledger, `mission_criteria`). Stacked on P5.

## Problem

A person can hand Tandemise a one-line request with no idea of what "done" means, and the planner will plan it anyway.

- A mission with no Done-when lines has an empty ledger. Nothing downstream can be verified against the person's intent, because the person never stated it. The spec invents criteria, QA verifies the spec, and "shipped" means "shipped what the agent thought you meant".
- Nobody asks the questions that change the plan: which pages, which users, what happens offline. The planner guesses, silently.
- Nothing stops planning. `POST /v1/missions/:id/plan` and `planNow` plan any DRAFT, whatever it says.

A product owner's first job is exactly this: turn a rough request into one that is ready to plan. Tandemise should do that job, ask the person only what matters, and refuse to plan until the request is specified.

## Goal

I drop a rough request. I press **Refine**. The product agent reads the request (and the repository) and comes back with:

- up to 8 **proposed criteria**, each an observable statement I could check myself, and
- up to 5 **questions**, each one whose answer changes the plan or the criteria, with one-click options where it can.

I accept, reject or edit each criterion and answer each question. Until every proposal is decided, every question answered and at least one criterion accepted, the mission cannot be planned, by the window or by the API. The daemon decides that from counts, never from the agent.

## Not in P6

- A multi-turn conversation with the refinement agent (one pass; Refine again for another).
- Refining a mission that has already been planned. Refinement is a DRAFT activity.
- Removing or rewording a criterion once accepted; uploads (P3).

## 1. Concepts

### The refinement pass

A bounded service step modelled on planning: the **product** role's runtime routing, read-only grants plus `artifact.write`, one run per attempt, 10 minutes of wall time, two attempts (the second quotes the first's validation issues). It writes a `Refinement` artifact. A pass that cannot run (no runtime, the run failed, the output invalid twice) leaves the mission in DRAFT with a plain reason; the person can still add criteria by hand, so a mission is never stuck.

Refinement runs in the background: `POST /v1/missions/:id/refine` returns at once, and the result arrives over the event stream (topic `refinement`), like planning.

### Proposals and questions

- A proposed criterion is a `mission_criteria` row with `status = 'proposed'` and key `P<n>`. It is not on the ledger yet: `listActive` (every gate fact, every prompt, the Done-when checklist) reads **accepted** rows only.
- **Accept** gives it the next `U<n>` key and makes it a user criterion, exactly as if the person had typed it. **Accept with changes** does the same with the person's wording. **Reject** retires it.
- A question is a `mission_questions` row, `open` until answered (free text, or one of its options).
- **Refine again** marks every proposal still undecided and every question still open as `stale` ("Replaced by a newer proposal"). What the person already decided stays decided.
- Keys `P<n>` and `Q<n>` are numbered across the mission and never reused, so "P4" always means one proposal.

### Autonomy

A mission with autonomy `autonomous` accepts proposed criteria automatically ("Accepted automatically"). It never answers questions: only the person knows the answers, so an open question still blocks planning.

### The readiness gate (Definition of Ready)

A gate expression over three measured facts, evaluated by the daemon:

```
ready_to_plan := ready.criteria >= 1 && ready.open_questions == 0 && ready.proposed_pending == 0
```

| Fact | Meaning |
|---|---|
| `ready.criteria` | accepted Done-when criteria (the person's lines, hand-added ones and accepted proposals) |
| `ready.open_questions` | refinement questions not yet answered |
| `ready.proposed_pending` | proposed criteria not yet accepted or rejected |

- A mission created with at least one Done-when line passes trivially.
- `PlanningService` checks it when a **DRAFT** mission is asked to plan. `plan()` and `begin()` both go through that one check, so `POST /v1/missions/:id/plan`, the window's Plan button and `planNow` cannot bypass it. A refused plan is `PRECONDITION_FAILED` with a sentence and the gate's own explanation, e.g. "Not ready to plan: answer 1 question and decide 3 criteria first. (Not met: ready.open_questions is 1, needs 0; ready.proposed_pending is 3, needs 0)".
- `POST /v1/missions` with `planNow: true` and no Done-when line is refused **before anything is written**: the request would create a mission that immediately fails its own plan.
- The same numbers produce the sentence the Plan button shows: "Answer 1 question and decide 3 criteria to plan", "Add at least one Done-when criterion to plan", or "Plan".

## 2. The Refinement artifact

```yaml
type: Refinement
title: …
handoff: …
proposedCriteria:          # at most 8
  - key: P1
    statement: <an observable outcome the person could check>
questions:                 # at most 5
  - key: Q1
    text: <one question whose answer changes the plan or the criteria>
    why: <what changes depending on the answer>          # optional
    options: [<a likely answer>, …]                      # optional, at most 4
```

The body says what the agent understood, why these criteria, and what it assumed instead of asking. The template (packages/artifacts) carries the product-owner guidance: ask only what changes the plan or the criteria; never ask what the repository or the request already answers; criteria are observable, testable, cover the whole request, and do not prescribe implementation; restate what the person already wrote rather than duplicate it.

The daemon numbers proposals and questions itself (in the order written) rather than trusting the agent's keys. Validation beyond the schema: a pass that proposes no criterion while the mission has none accepted is refused with an issue ("propose at least one criterion") and retried.

## 3. Prompts

- The refinement prompt gives the goal, constraints, the accepted criteria, earlier answers, the repository, and the template; it asks for the file at `.tandemise/out/refining-<mission>-<attempt>/Refinement.md`.
- The **planner prompt** replaces "Stated success criteria" with the accepted ledger (`- U1: …`) and adds "Decided during refinement" with each answered question and its answer. Rejected and stale proposals are never shown.
- The context compiler's Mission section (every task's prompt) lists the same answers under "Decided before planning".

## 4. Data (migration 012)

- `artifacts.type` CHECK widened for `Refinement` and `StatusReport` (P10's type, widened now so there is one rebuild). The 006 pattern: edit the stored CHECK text in `sqlite_master`, bump `schema_version`, assert the post-condition. A copy-and-rename rebuild would cascade-delete every artifact link, run input and feedback row pointing at artifacts.
- `mission_criteria` gains `status` (`proposed|accepted|rejected|stale`, default `accepted`), `refinement_artifact_id`, `decided_by`, `decided_at`. Existing rows read `accepted`.
- `mission_questions(id, mission_id → missions CASCADE, key, text, why, options JSON, answer NULL, answered_by NULL, status CHECK('open','answered','stale'), refinement_artifact_id, position, created_at, answered_at)`.

## 5. API

| Route | Does |
|---|---|
| `POST /v1/missions/:id/refine` | starts a refinement pass (DRAFT only; one at a time) → the refinement view |
| `GET /v1/missions/:id/refinement` | `{ state: idle|running|failed, failure, artifactId, headline, criteria[], questions[], readiness }` |
| `POST /v1/criteria/:id/verdict` | `{ verdict: accept|reject, statement? }` on a proposed criterion |
| `POST /v1/questions/:id/answer` | `{ text }` on an open question |
| `POST /v1/missions/:id/criteria` | `{ statement }` adds an accepted criterion by hand (DRAFT only) |
| `GET /v1/inbox` | gains `refinements[]`: DRAFT missions with something to decide |

`readiness = { ready, criteria, openQuestions, proposedPending, label, detail }` where `label` is the Plan button sentence and `detail` the gate's explanation. Every write invalidates `refinement`, `criteria` and `missions`.

## 6. Desktop

- **New mission.** With no Done-when lines the button reads **"Create and refine …"** and creates the mission without planning; the person lands on it with "Get it ready" open. With lines it stays "Plan mission …".
- **Mission header (DRAFT).** The Plan button is disabled while the gate fails and its label is the readiness sentence ("Answer 1 question and decide 3 criteria to plan").
- **Get it ready** (top of a DRAFT mission's feed):
  - Intro: what refinement does. **Refine** / **Refine again** (Refining… while it runs; the failure reason when it failed).
  - **Done when**: accepted criteria (key, statement, "Accepted", "Accepted automatically", "Added by you", "From your request").
  - **Proposed**: one row per undecided proposal with **Accept**, **Reject**, **Edit** (edit shows a field and "Accept with changes").
  - **Questions**: one card; each question, its "why", its options as buttons, a free-text field and **Answer**; answered ones show the answer.
  - **Add a criterion**: a field and **Add**.
  - Decided history: rejected ("Rejected") and stale ("Replaced by a newer proposal") rows, dimmed.
- **Inbox.** One row per DRAFT mission with something to decide: "Refinement: 4 to decide", with the mission's title; it opens the mission. It disappears when nothing is left to decide.

## Testing

**Offline:** `scratch/p6-ready-check.mjs`, added to OFFLINE_CHECKS, written first and seen failing. It covers: migration 012 (CHECK widened, both types insertable, columns, question table, schema 12); the pure readiness rule and sentences; the Refinement schema and template; the repository (propose, keys, accept → next U, reject, stale on re-propose, `listActive` excludes proposals); a real refinement pass through a generic-cli runtime running the scripted agent (3 proposals + 1 question; autonomy auto-accept; question still blocks); the gate on `plan()`, `begin()`, `POST /missions/:id/plan` over HTTP and `planNow` (no mission written); verdict/answer/add refusals outside DRAFT; the planner prompt (accepted and answer in, rejected out); the inbox rows.

**Real app** (`scratch/acceptance/p6/`, CDP 9341, home `/tmp/tdm-p6`, scripted agent):

| # | Scenario | Must observe in the window |
|---|---|---|
| F1 | Goal only → Create and refine → Refine | three proposed rows with Accept/Reject, question Q1, Plan button reads "Answer 1 question and decide 3 criteria to plan" |
| F2 | Cannot plan | Plan button disabled; `POST /plan` → 412 with the gate text; SQL status DRAFT |
| F3 | Accept 2, reject 1, answer Q1 → Plan | "Planning"; the planner prompt holds the answer and both accepted statements, not the rejected one |
| F4 | Refine again with one proposal undecided | the old row reads "Replaced by a newer proposal" |
| F5 | Autonomous mission → Refine | "Accepted automatically" on every proposal; Plan still disabled by the open question |
| F6 | Inbox | "Refinement: 4 to decide" appears, then disappears once everything is decided |

## Rulings

1. **The gate guards the first plan.** It runs when a DRAFT mission is planned. Re-planning a mission that already left DRAFT is not gated: its readiness was decided then, and missions from before P6 must stay re-plannable.
2. **`planNow` without a Done-when line is refused, not downgraded.** Creating the mission and silently not planning it would answer a request with something it did not ask for. The window never sends it without lines.
3. **Proposals are not criteria.** They live in `mission_criteria` with `status = 'proposed'` and `P<n>` keys, and only accepted rows are the ledger. Accepting assigns the next `U<n>` so the person's criteria stay one dense, ordered list.
4. **Rejected and stale rows leave the live key space** (`superseded_at` set) and keep their status as the reason.
5. **Refinement state is in memory.** Running/failed is not persisted; a daemon that stops mid-pass has written nothing, and Refine can simply be pressed again.
6. **DRAFT only.** Refine, verdicts, answers and hand-added criteria are refused (`PRECONDITION_FAILED`) once the mission has left DRAFT.
7. **Questions may say `why`.** Optional, shown under the question: it is what makes a question answerable without opening the document, and it forces the agent to justify asking.
8. **The daemon numbers proposals and questions** (`P<n>`, `Q<n>`, across the mission) instead of trusting the agent's keys.
9. **Autonomous accepts, never answers** (roadmap decision 7). Auto-accepted rows record `decided_by = 'autonomy'`.
10. **Answers reach every role**, not only the planner: the context compiler lists them in the Mission section.
11. **Inbox row audience.** It is for the person who created the mission (anyone, when the creator is unknown), like the plan approval.
12. **StatusReport widened now** with a minimal schema (title and handoff) and template; P10 gives it its content.
13. **Neither Refinement nor StatusReport is offered to the planner** as a task output: no task produces them.
