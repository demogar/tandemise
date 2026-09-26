# The Inbox: nothing waits silently

The Inbox is everything waiting on you: plan approvals, questions from agents,
steps for a person, drafts to refine, limit cards. Two kinds of row make sure
nothing gets stuck without you hearing about it: **Stalled** missions and
**Quiet** agents.

![The Inbox with a stalled mission, a card, a quiet agent, a limit card and a refinement](../../apps/desktop/screenshots/27-inbox-stalled-quiet.png)

## What does "Stalled" mean?

A mission is stalled when nothing will move it and nothing is asking you about
it. Tandemise checks every mission against one rule, from its rows, every time
you look:

| The mission is… | Inbox |
|---|---|
| **moving**: a run, a planner, a refinement or the backlog pull will move it | nothing |
| **waiting on you** and something already asks you (a card, a step, a refinement) | that item |
| **parked** by your choice: paused, kept paused at a limit, a draft you did not queue | nothing |
| **finished** | nothing |
| **stalled**: none of the above | one **Stalled** row |

So a stalled row never sits next to another item for the same mission, and a
mission you paused on purpose never nags you.

Typical causes: a step you chose to **Leave blocked**, a rejected plan, a step
no runtime can run, a step cancelled mid-run, or a queued draft that is not
ready and has nothing left to decide.

## How do I unstick a stalled mission?

The row reads "Stalled: <mission>", says why ("'release' is blocked: A human
declined to retry this task.") and offers exactly one action, the first that
applies:

1. **Retry <step>**: retry the first step that is blocked, failed or cancelled.
2. **Re-plan**: nothing has started yet (for example after a rejected plan).
3. **Refine**: a queued draft that is not ready.
4. **Cancel mission**: nothing else can move it. You are asked to confirm.

The row disappears as soon as the mission can move again. There is nothing to
clear.

## What is a "Quiet" agent?

Every event an agent writes (a message, a tool call, a file) is timestamped.
When a running step has written nothing for a while:

- **Quiet** (after 10 minutes by default): the step's drawer reads "Last
  activity 12 min ago" with a **Quiet** badge, and the timeline gets one note.
  No Inbox row yet.
- **Silent** (after 30 minutes, or half the step's wall-time budget if that is
  sooner): the Inbox shows "Quiet for 16 min: <step>" with the mission, and two
  buttons:
  - **Stop and retry**: stops the run and puts the step back in the queue for a new attempt.
  - **Keep waiting**: hides the row for another silent interval. Any new event
    from the agent clears it for good.

Tandemise never stops a quiet run on its own; the step's wall-time budget stays
the only automatic stop. A quiet run's mission is moving, so it never also gets
a Stalled row.

To change when a run counts as quiet, start the daemon with
`TANDEMISE_QUIET_MS` (milliseconds, default `600000`).

## How do I see only the stuck missions?

Home's **Stalled** card opens `Inbox → stalled` ("Showing stalled missions
only"). **Show everything** goes back to the full Inbox.

## Where else do these show up?

Home's **Needs you now** lists the same rows. Home's cards count them
separately: **Needs you** counts requests (cards, steps, refinements, quiet
agents), **Stalled** counts stuck missions (see
[The desk](desk-and-status-report.md)).
