# Plan the rest again: change course without losing what is done

A plan is written before any step runs. Sometimes a step finds that the rest
of it no longer makes sense: intake learns the role is US-only, a spike shows
the library cannot do what the plan assumed. **Plan the rest again** asks the
planner for new steps for what is left. Everything already done stays
exactly as it is, and the new steps build on it.

## Where do I ask for it?

- **On a "Plan no longer fits" card.** When a step says the plan no longer
  fits (see [The Inbox](inbox.md)), its card offers four answers. **Plan the
  rest again** is one of them. Add a note if you know what the rest should do
  ("Ask Ashby whether Panama counts, then tailor for the Americas"). The
  planner reads exactly what you write.
- **On the mission header**, when the mission is paused or blocked partway
  through. **Re-plan** still appears when nothing has started, and still
  replaces the whole plan.

## What does the planner see?

Every step that already started, and for each one:

- what it found: its handoff headline and points;
- its stop, if it said the plan no longer fits;
- the outputs it wrote, by type and id.

It also sees your note. If you left none, it sees the stop sentence. It is
told to plan only what is still needed, and to depend on finished steps when
it builds on their work. A new step that depends on a finished one is handed
that step's output.

## What is kept, and what is replaced?

| Step | What happens |
|---|---|
| Started: it ran, is running a round, is waiting on a person, or finished | **kept** as it is: same id, runs, outputs, notes and scores |
| Never started (pending, ready, or skipped before it ran) | **replaced** by the new steps |
| Something a kept step depends on (an upload's placeholder, say) | **kept** |

No path through planning ever deletes a step that started. This includes
**Re-plan** from the API on a mission that has finished work: it becomes a
replan of the rest.

## Nothing changes until I approve

A replan always asks, whatever the project's autonomy: it changes a plan you
already approved. The card reads, for example, "Keeps 1 step already started
· replaces 2 steps not started · adds 2 steps", and lists the new steps.

- **Approve**: the unstarted steps are replaced and the mission carries on.
- **Reject**: the mission is exactly as it was. If the replan came from a
  "Plan no longer fits" card, that card is open again and still holds the
  steps after the stop.

If the planner cannot plan the rest (no runtime, or no valid plan in two
tries), nothing changes either. The mission goes back to where it was and
says why ("Could not plan the rest: … Nothing changed."). A replan never
falls back to the workflow's preset, because the preset plans the whole
mission and would redo what is done.

## When is it refused?

While a step is still running: "Wait for 'build' to finish, or stop it,
before planning the rest again." A plan written around a step that may still
finish, fail or ask would be written around a moving part. Stop it from its
Quiet row or its drawer, or wait.

An eval trial is never replanned. Nobody is there to approve it.
