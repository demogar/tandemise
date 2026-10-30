# Replan the rest: a new plan for what is left, keeping what is done

Status: design, 2026-10-09. Follows plan fit (2026-10-03), whose spec names
"replanning the rest of the mission from the stop" as its own sub-project.

## The problem

A plan is written once, before any step runs. When the work shows the plan
was wrong, the person has two blunt tools:

- **Plan fit** (2026-10-03) lets a step say the plan no longer fits. The
  person can skip the rest, send the step back, or continue as planned. None
  of these gives the mission a *different* rest: when intake finds the role is
  US-only, "ask Ashby whether Panama counts, then tailor the CV for the
  Americas" is a new plan, not a skip.
- **Re-plan** throws the whole plan away. The window only offers it while
  nothing has started (P9). The route itself does not check that: a re-plan
  from BLOCKED, PAUSED or FAILED materialises the new plan with fresh task ids,
  `tasks.replaceAll` deletes every old row, and the cascade takes their runs,
  run inputs, evaluations, check results and notes with them. Their artifacts
  and cards stay behind, pointing at tasks that no longer exist.

So the only way to change course mid-mission today loses the work already
done, or reaches past the window into a route that quietly deletes history.

## Goal

The person can ask for **a new plan for what is left**. Finished work stays
exactly as it is, the planner sees what it found, and the new steps build on
it. Nothing a step did is ever deleted by planning.

## Decisions

### What is kept, what is replaced

- **Kept: every step that has started.** A step with a run, an attempt, a
  round, or a finished status (SUCCEEDED, FAILED, SKIPPED or CANCELLED after
  it started) keeps its row, id, key, runs, artifacts, notes and evaluations
  untouched. "Started" is decided from rows (`attempts > 0`, or `startedAt`
  set, or any run), never from what an agent said.
- **Replaced: every step that has not started** (PENDING or READY with no
  attempt and no run, or SKIPPED before it started). These were only ever a
  promise; the new plan supersedes them.
- **A replan needs a still mission.** It is refused while any step is RUNNING
  or waiting on a live run (AWAITING_INPUT, AWAITING_APPROVAL with a live
  run): "Wait for '<step>' to finish, or stop it, before planning the rest
  again." Steps parked on a person or an outside tool are fine; they are
  started, so they are kept.
- **The same rule fixes the old route.** `POST /v1/missions/:id/plan` on a
  mission with started steps becomes a replan of the rest instead of a
  replace-all. A mission where nothing has started re-plans whole, as before.
  No path through planning deletes a started step again.

### What the planner gets

The planner prompt gains one section, **Already done**, when there is
anything kept:

- each kept step: key, role, status, round, its handoff headline and points
  (and `stop` if it said one), and the types and ids of its live outputs;
- why the person is replanning, in their words when they gave a note, else
  the stopping step's `stop` sentence;
- the instruction: plan only the steps still needed, which may depend on kept
  keys to read their output; never repeat a kept key; never plan work a kept
  step already did.

Kept steps' outputs are offered to validation as pre-existing artifacts, so a
new step may require an input a kept step produced (rule 3 already allows
inputs that exist before the plan).

### Validation and merging

- The **combined** graph (kept + new) is validated with the existing
  `validateTaskGraph`: unknown dependencies, cycles, unknown roles. A new key
  that collides with a kept one is renamed with `uniqueKey`, and every
  dependency on it in the new plan follows.
- New steps are materialised with fresh ids and `orderHint` after the last
  kept step. A new step whose dependencies are all finished is READY.
- Kept steps are written back unchanged; `replaceAll` then only removes the
  unstarted rows it is meant to.

### Approval

- **A replan always asks**, whatever the project's autonomy: it changes a
  plan the person already approved. The card is the plan card, with one more
  evidence line, which also leads the plan's handoff in the feed: "Keeps N
  steps already started · replaces M steps not started · adds K steps".
- Reject leaves the mission as it was before the replan was asked for: the
  unstarted steps it would have replaced are restored, and a plan-fit hold
  that led here is still waiting on its card.
- Approve replaces the unstarted steps and the mission returns to EXECUTING.
  It also answers any plan-fit card still open on the mission (a replan asked
  for from the header or the route): the new plan is the answer to "the plan
  no longer fits", and an open card would hold the new steps behind the stop.
- A paused mission goes back to PAUSED when its replan is rejected or cannot
  be planned, so PLANNING and AWAITING_PLAN_APPROVAL may move to PAUSED.

### Where the person asks for it

- **On the plan-fit card**: a fourth option, **Plan the rest again**, with an
  optional note ("Ask Ashby first, then tailor for the Americas"). Answering
  the card with it starts the replan; the card reads decided like the other
  three.
- **On the mission header**, as **Plan the rest again**, when the mission is
  BLOCKED, PAUSED or FAILED and has started steps (where it today offers no
  re-plan, or a re-plan that would destroy them). The existing **Re-plan**
  stays for a mission where nothing has started.
- The liveness Stalled row keeps offering what P9 specified. It reads its own
  list of re-plannable statuses, not the new EXECUTING → PLANNING edge.

### Mission status

- EXECUTING → PLANNING becomes a legal transition, guarded by the still-mission
  rule above (the plan-fit hold keeps a mission EXECUTING).
- While a replan is being written the mission reads PLANNING with "Planning
  the rest: N steps done." Kept steps show as they were.

### Planning record

The planner still has no `Run` row (KNOWN_LIMITATIONS). The replan's events
are recorded like the first plan's, and the MissionPlan document supersedes
the previous one, so the Plan tab shows the current plan and the Timeline the
history.

### Eval trials and authored workflows

- **Eval trials never replan**, as they never hold for plan fit: nobody is
  there to approve it.
- **A mission on an authored workflow** replans through the planner, with the
  workflow offered as reference the way a preset is. Recompiling the same
  file would only produce the plan that no longer fits.

## Out of scope

- Replanning while a step is running (stop it first; P9's Stop and retry
  exists).
- Changing the goal or the Done-when lines as part of a replan. Refine owns
  those, and a replan reads the current ledger.
- Moving a kept step's output to another repository, or redoing a kept step.
  Send it back with a note (rounds) does that.
- Automatic replanning. A model never decides on its own that the plan
  changes; a person asks.

## Acceptance (real app)

On a fresh install with the scripted agent, then once with Claude Code:

1. **R1, replan from a stop.** A step says `stop`; on its card, **Plan the
   rest again** with a note. The plan card lists kept and new steps with
   "Keeps 1 finished step · replaces 2 · adds 2". Approve: the new steps run on
   the kept step's output, the old unstarted steps are gone, the kept step's
   runs and artifacts are unchanged (same ids), and the mission completes.
2. **R2, reject a replan.** Reject the replan card: the original unstarted
   steps are back, still held behind the plan-fit card, which still offers its
   options.
3. **R3, the old route no longer deletes.** `POST /missions/:id/plan` on a
   BLOCKED mission with a SUCCEEDED step: the step, its run and its artifact
   survive with the same ids, and the request becomes a replan of the rest.
4. **R4, a busy mission is refused.** With a step RUNNING, asking for a replan
   is refused with the reason, and nothing changes.
5. **R5, the real runtime.** The R1 flow with Claude Code as planner and
   workers, in the window, with the evidence in the PR.
