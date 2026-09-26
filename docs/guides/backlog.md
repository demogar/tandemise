# Keep a backlog and limit work in progress

You probably have more requests than agents. Put them in a ranked backlog, say
how many missions Tandemise works on at once, and it plans the next ready one
in your order whenever a slot frees up.

![The Backlog tab: work on at most 3, two queued missions, one held by the monthly limit](../../apps/desktop/screenshots/24-backlog.png)

## How do I add something to the backlog?

On **New mission**, press **Add to backlog** instead of the primary button. The
mission is created as a draft and queued, but not planned. Set its **Priority**
under **More options** (Urgent, High, Normal or Low).

Every draft appears on **Missions → Backlog**. A draft is only picked up when it
is **queued**: **Add to queue** and **Remove from queue** on each row. A draft
you have not queued is yours to finish.

## How do I set the work-in-progress limit?

At the top of **Missions → Backlog**, choose **Work on at most**: Off, 1, 2, 3
or 5. The headline says where you stand, for example "Working on 3 of 3 ·
3 queued".

- **Off** (the default): nothing is picked up. Queued missions wait until you
  plan them yourself or set a limit.
- **A number**: whenever fewer missions than that are in progress, Tandemise
  plans the first queued draft that is ready, in backlog order. Its timeline
  reads, for example, "Pulled from the backlog (2 of 3)": with it, 2 missions
  are in progress against a limit of 3.

A mission is **in progress** when it has started and is not finished: planning,
waiting on its plan approval, executing, in review or QA, or blocked. Drafts and
paused missions do not count.

## Which mission is picked next?

The first queued draft in backlog order that is ready to plan (it has an
accepted Done-when line and nothing left to decide; see [Refine](refine.md)).
A queued draft that is not ready is skipped, not removed: it is picked once it
is ready and first in line. A draft being refined right now is skipped too.

The backlog order is priority first (Urgent, High, Normal, Low), then your
rank, then age. The same rows always give the same order, so the same state
always gives the same pick. Worker slots follow the same order: when agents are
busy, an urgent mission gets the next free one.

## How do I reorder it?

- **Move up** / **Move down** on a row, or select a row with `j` / `k` and press
  `⌥↑` / `⌥↓`. `↵` opens the selected mission.
- Change the **Priority** select on the row.

Priority comes first in the order, so moving a Low mission above a Normal one
makes it Normal. The window says so ("Now Normal priority, above …").

## Why is a queued mission not being picked?

The row says why:

- **Needs refinement** with what is missing: decide its proposals or answer its
  questions.
- **Held: this project is over 80% of its monthly limit …**: over the monthly
  warning level only Urgent and High missions are picked; at the limit, none
  (see [Limits](limits.md)).
- The headline shows every slot is full: it is picked when one finishes.

A queued draft that is not ready and has nothing left to decide will never be
picked on its own, so it also appears in the Inbox as **Stalled** with
**Refine** as the action (see [Inbox](inbox.md)).

## What if I cancel a mission that was just picked?

Cancelling a mission while it is being planned stops the planner. A plan that
finishes after the cancel is discarded, with a note on the timeline, and no
plan approval is raised.
