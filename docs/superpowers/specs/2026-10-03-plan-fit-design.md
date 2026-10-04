# Plan fit: a step can say the plan no longer fits

Status: agreed direction (2026-10-03). Found on a real mission.

## The problem

A plan is written before any step runs. A step can find something that makes
the steps after it pointless, and nothing notices.

The mission that showed it: "Create a new job post for <Ashby role>".

1. `intake` (agent) found the role is US-only. Following the project's own
   rules it stopped before writing the CV and the questions file. Its handoff
   said so, and `needs` read "Decide whether to skip (Postergado) or ask Ashby
   whether Panama counts as Americas".
2. `demo_answers` (person) had been planned as "read the questions in
   `applications/23/questions.md` and paste your answers". It started anyway,
   pointing at a file that was never written.
3. `facts_improve_notion` and `verify` waited behind it, ready to build on
   whatever was pasted.

Two smaller fixes ship separately: a person's step now shows what came in
(the upstream handoff), and the planner is told that a worker's questions go
through `ask_human`, never a person step. Neither stops the plan from running
on. That is this spec.

## Decisions

- **The step says it, explicitly.** The handoff block gets an optional
  `stop`: one sentence, 200 characters or fewer, saying why the steps after
  this one should not run as planned. It is set only when that is true; a
  step that merely has a caveat uses `points` or `needs`. Nothing is inferred
  from `needs`, which is also used for ordinary "approve this" requests.
- **The work still counts.** The step that says `stop` succeeds: it did its
  job, and what it found is the result. The steps after it are what wait.
- **The hold is at promotion.** When a PENDING step's dependencies have all
  finished, the scheduler looks at each dependency's live output. If one
  carries `stop` and nobody has answered it yet, the step stays PENDING with
  "Waiting for you: '<step>' says the plan no longer fits." This one place
  covers every way a step succeeds: straight away, after its reviews, or after
  a round.
- **One card per stopped output.** The first time a stop holds something, a
  card is filed on the stopping step, addressed like any other card on it. It
  is an `intervention` recognised by its options, the way the limit card is,
  so no new approval kind and no migration. Its evidence names the artifact
  that said stop, so a later round that says stop again gets a new card, and
  one that does not releases the hold.
- **Three answers.**

  | Option | Effect |
  |--------|--------|
  | Skip the steps after it (`skip_rest`) | Every unfinished step downstream of it is SKIPPED with "Skipped: '<step>' said the plan no longer fits." The mission finishes on what was done. Recommended: the step itself asked for it. |
  | Send it back with a note (`request_changes`) | A new round of the stopping step, briefed by the note. Nothing downstream has used its output, so nothing else is redone. The note is required. |
  | Continue as planned (`continue_plan`) | The hold is released and the next steps start on what the step wrote. |

  Cancelling the whole mission stays where it already is, on the mission
  header.
- **Eval trials never hold.** A trial has nobody to ask (ask_human is
  answered "nobody" there too), so a stop in a trial is ignored and the trial
  runs on.
- **The worker is told when to use it.** The handoff instructions every
  output template carries say what `stop` is for, and that it is rare.

## Out of scope

- Replanning the rest of the mission from the stop. Skip and Send back cover
  the cases seen so far; a real replan of a running mission is its own
  sub-project.
- A stop from a person's own step. A person who finds the plan wrong can skip
  steps or cancel the mission already.

## Acceptance (real app)

On a fresh install, with the scripted agent:

1. A step whose handoff says `stop` succeeds; the person step after it stays
   PENDING with the waiting reason; the card is in the Inbox and inline on the
   step's feed card with the three options.
2. "Skip the steps after it" in the window: every downstream step is SKIPPED
   with the reason, and the mission completes.
3. "Send it back with a note": round 2 of the step runs with the note in its
   prompt; when round 2 does not say stop, the next step starts on it.
4. "Continue as planned": the next step starts.
