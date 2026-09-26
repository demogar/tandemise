# P11: Routines that queue standing work on a schedule

Status: design, 2026-09-26. Builds on P5 (Done-when ledger), P6 (readiness gate), P7 (backlog and pull), P8 (hard limits) and P10 (status report). Stacked on P10.

## Problem

Some work is not a request, it is a habit: bump the dependencies every week, look at the failing checks every night, write a status report every Friday. Today the person has to remember each one and type it in again, with the same Done-when lines, the same priority and the same limits every time. When they forget, the backlog stops flowing; when they are busy, the same request goes in twice.

## Goal

I describe a piece of standing work once, as a **routine**: what to do, what "done" means, how urgent it is, what it may spend, and when it repeats. On schedule, Tandemise adds a mission to my backlog that is ready to plan, with those criteria and limits. It never plans or runs anything itself: the backlog's work-in-progress limit, the readiness gate and the spending limits decide, exactly as for a mission I typed.

- A routine is **ready by construction**: it cannot be saved without at least one Done-when line, so every mission it creates passes the readiness gate.
- A routine creates at most **one mission at a time**. While the last one is unfinished, a scheduled run is skipped and says so.
- **Missed runs** while Tandemise was not running produce one catch-up run at most; the rest are skipped and noted.
- A routine **never fires past the project's monthly limit**: at the hard stop the run is skipped and noted.
- A **status report** routine writes the P10 status report instead of a mission.
- Schedules are **simple presets**: every day at a time, every week on a day at a time, or every N hours. No cron.

## Not in P11

- Free-form cron, time zones other than the daemon's own, end dates, "skip holidays".
- Routines that run an agent directly or bypass the backlog (never: the backlog is the only way in).
- A history screen beyond the last few runs of each routine.
- Editing a created mission from its routine afterwards (a created mission is an ordinary mission).

## 1. Concepts

### A routine

| Field | Meaning |
|---|---|
| name | "Weekly dependency updates"; also the start of every mission title it creates |
| kind | `mission` (adds a mission to the backlog) or `status_report` (writes the project's status report) |
| goal | the goal of each mission; `{date}` is replaced with the local date of the run |
| Done when | one line per criterion; become U1…Un of each mission (P5). At least one for a mission routine |
| priority | the mission's backlog priority (P7) |
| limits | the mission's own limits (P8); none means the project's default mission limits apply |
| workflow | the mission's workflow, as on New mission |
| schedule | `daily at HH:MM`, `weekly on <day> at HH:MM`, or `every N hours` (N in 1, 2, 3, 4, 6, 8, 12) |
| enabled | a paused routine never fires and never catches up |
| next run | when it fires next; empty while paused |
| last run | when it last fired, and what happened |

### When it fires

Time comes only from the injected Clock. Next-run times are computed by pure functions in the daemon's local time zone:

- **daily / weekly**: the first local wall-clock time `HH:MM` (on the given weekday) strictly after the previous slot.
- **every N hours**: exactly N hours after the previous slot (elapsed time, so a DST change never makes it 5 or 7 hours).
- **Daylight saving**: a wall-clock time that does not exist on the day clocks go forward (02:30 in a 02:00→03:00 gap) fires at the same distance past the gap (03:30). A time that happens twice on the day clocks go back fires once, at the first occurrence.

On every scheduler tick, before the backlog pull, for each enabled routine whose `next run ≤ now`:

1. Count the **due slots** from `next run` up to now. The next run moves to the first slot after now **before** anything else happens, so a slow run or a second tick can never fire the same slot twice.
2. More than one due slot means Tandemise was not running: all but the last are **skipped and noted** ("Missed 3 runs while Tandemise was not running (Mon 09:00 to Wed 09:00); ran once to catch up."). The last one is the catch-up run.
3. A mission routine with an **unfinished mission** from itself (any status but COMPLETE, FAILED, CANCELLED; a queued draft counts) is skipped: "Skipped: previous run still active". A note says so on that mission's timeline too.
4. A mission routine in a project **at its monthly hard limit** is skipped: "Skipped: Monthly limit reached: this project used 61 of 60 agent minutes this month". (The warning level does not skip: the P8 backlog rule already holds normal work while the month is over its warning level.)
5. Otherwise the run happens: a mission routine creates a DRAFT mission **queued** in the backlog (P7), with the routine's Done-when lines as U1…Un (P5), its priority, its limits (P8) and `routine_id`. A status report routine calls `services.desk.writeStatusReport`.

The decision in steps 2–4 is the pure function `decideRoutineRun(input)`; the service only gathers its inputs and applies its answer.

### What a routine can never do

A routine only ever calls `MissionService.create` with `queued: true` and no `planNow`. It holds no reference to planning, the scheduler's dispatch or the limit admission. So:

- the created mission reaches PLANNING only through the P7 pull, which reads the P6 readiness gate and the WIP gate;
- work in it starts only through the P8 admission, which reads the mission's and the month's limits;
- "Run now" takes the same path as a scheduled run (steps 3–5), so it cannot skip the checks either.

### Run now

**Run now** on a routine runs it once, immediately, through steps 3–5. It does not move the next scheduled run. The answer is the routine, whose last outcome says what happened.

### Pausing and resuming

Turning a routine off clears its next run. Turning it back on schedules the first slot after now: the windows it was off for are not caught up (a paused routine was paused on purpose). Changing its schedule does the same.

## 2. Words

| Where | Text |
|---|---|
| Routine row | "Next: Mon 09:00" (weekday and time within a week, else "Next: Mon 5 Oct 09:00"); "Paused" when off |
| Routine row | schedule "Every Monday at 09:00", "Every day at 02:00", "Every 6 hours" |
| Last outcome | "Created “Weekly dependency updates · Mon 28 Sep”", "Wrote status report v2", "Skipped: previous run still active", "Skipped: Monthly limit reached: this project used 61 of 60 agent minutes this month", "Missed 3 runs while Tandemise was not running …", "Could not run: …" |
| Mission header | "From routine: Weekly dependency updates" |
| Mission timeline | "Created by the routine “Weekly dependency updates” (Mon 09:00 run)." |

## 3. Data (migration 016)

Additive:

```sql
CREATE TABLE routines (
  id, workspace_id → workspaces, name, kind CHECK IN ('mission','status_report'),
  goal, success_criteria JSON, priority CHECK (P7 values), limits JSON NULL, workflow_preset NULL,
  schedule JSON, enabled CHECK (0,1), next_run_at NULL, last_run_at NULL,
  last_outcome NULL CHECK IN ('created','reported','skipped_active','skipped_limit','missed','failed'),
  last_detail NULL, last_mission_id → missions ON DELETE SET NULL, last_artifact_id NULL,
  created_by NULL, created_at, updated_at);
CREATE TABLE routine_runs (id, routine_id → routines ON DELETE CASCADE, trigger CHECK IN ('schedule','manual'),
  scheduled_for NULL, ran_at, outcome (same CHECK), detail, skipped_count, mission_id NULL, artifact_id NULL);
ALTER TABLE missions ADD COLUMN routine_id TEXT REFERENCES routines(id) ON DELETE SET NULL;
```

`routine_runs` is the note for every run, including skipped and missed ones (one row per catch-up with the count), so "skipped and noted" is a row a person can read, not a log line.

## 4. API

| Route | Does |
|---|---|
| `GET /v1/workspaces/:id/routines` | `RoutineView[]` |
| `POST /v1/workspaces/:id/routines` | create; 400 without a Done-when line for a mission routine |
| `PATCH /v1/routines/:id` | any field, `enabled` included |
| `DELETE /v1/routines/:id` | delete (created missions keep existing; their `routine_id` is cleared) |
| `POST /v1/routines/:id/run-now` | run once now → `RoutineView` |
| `POST /v1/test/clock` | `{ advanceMs }` — **only** when the daemon was started with `TANDEMISE_CLOCK_OFFSET_MS` (test knob); 404 otherwise |

`RoutineView = { routine, scheduleLabel, nextRunLabel, lastLabel, activeMissionId, recent: RoutineRunView[] (5 newest) }`. `Mission` gains `routineId`. Every write invalidates `missions` (the Routines tab lives under Missions).

**Test clock.** `TANDEMISE_CLOCK_OFFSET_MS=<ms>` makes the daemon's one Clock read real time plus an offset, and enables `POST /v1/test/clock` to add to it. Everything that reads time (routines, limits' month, liveness) sees the same shifted clock. Without the variable the route does not exist.

## 5. Desktop

- **Missions → Routines** tab (after Backlog). Each row (aria-label "Routine: <name>"): name, schedule, "Next: …" or "Paused", last outcome (the created mission's title links to it; a report opens in the reader), an **On/Off** switch (aria-label "Enabled"), **Run now**, **Edit**, **Delete** (confirmed).
- **New routine** dialog: three starter templates as buttons first — **Weekly dependency updates**, **Nightly: fix failing checks**, **Weekly status report** — each filling every field with sensible values; then Name, What it does (Adds a mission / Writes a status report), Goal, Done when (one per line), Repeats (Every day / Every week / Every few hours) with the time, weekday or hours as selects and a time field, Priority, Workflow, and limits for each mission. The footer says what each run does; after saving, the row says when it runs next.
- **Mission header**: "From routine: <name>" as a link to the Routines tab.
- The filtered Missions routes (`/missions/backlog`, `/missions/routines`, …) render one screen; it now follows the route when it changes rather than keeping the first tab (found while proving L1).

## Testing

**Offline:** `scratch/p11-routines-check.mjs`, added to OFFLINE_CHECKS, written first and seen failing. It runs in `TZ=America/New_York` (set before any date is made) and covers:

- **pure schedule**: daily, weekly and every-N-hours next runs; the spring-forward gap (02:30 on 2027-03-14 fires at 03:30 EDT, then 02:30 EDT the next day); the fall-back repeat (01:30 on 2026-11-01 fires once); every 6 hours stays 6 real hours across both changes; labels.
- **decisions** (`decideRoutineRun`): one due slot fires; four due slots → one catch-up and three missed, noted; previous mission active → skipped and noted; hard limit → skipped and noted; a disabled routine is never due.
- **engine with an injected clock** (real SQLite, stub mission creation): a tick before the time does nothing; at the time creates one mission; ticking again does nothing; after 3 days down one catch-up and "Missed 2 runs"; re-entrant ticks never double-fire; disabling clears the next run and re-enabling does not catch up.
- **real daemon** (`startDaemon` with `TANDEMISE_CLOCK_OFFSET_MS`): migration 016 (tables, CHECKs, `missions.routine_id`); creation refused without a Done-when line; advancing the clock creates a DRAFT, queued mission with U1…Un, the routine's priority, limits and `routine_id`; WIP off → it stays a queued draft (never planned by the routine); WIP full → still queued; an open question on it (readiness gate) → the pull skips it until answered; previous active → "Skipped: previous run still active"; the monthly hard limit → skipped, no mission; Run now obeys the same rules; a status report routine writes StatusReport v1 then v2; the test clock route is 404 without the knob; application sources never read `Date.now()`.

**Real app** (`scratch/acceptance/p11/`, CDP 9346, home `/tmp/tdm-p11`, scripted agent, `TANDEMISE_CLOCK_OFFSET_MS=0`):

| # | Scenario | Must observe in the window |
|---|---|---|
| L1 | New routine from "Weekly dependency updates", changed to every day at a time an hour ahead; advance the clock past it | the row reads "Next: …"; after the advance a mission "Weekly dependency updates · …" is in the Backlog as "Queued", its Done-when lists U1–U3, its header says "From routine: Weekly dependency updates" |
| L2 | Advance a day while that mission is still queued | the row reads "Skipped: previous run still active"; still one mission from the routine |
| L3 | Delete that queued draft (a draft has no Cancel); click "Run now"; add the "Weekly status report" routine and click "Run now" | a new mission is created and queued, the schedule is unchanged; the report row reads "Wrote status report v1" and opens the report |
| L4 | Delete the L3 draft; turn the routine off; advance two days | the row reads "Paused"; no new mission; turning it on shows a next run after now and nothing is caught up |

## Rulings

1. **A routine is a DRAFT factory, nothing more.** It creates queued drafts through `MissionService.create`; the pull, the readiness gate, the WIP limit and the limit admission decide the rest. This is what makes "a routine can never bypass the gates" structural rather than a promise.
2. **Coalesce counts a queued draft as active.** A draft waiting in the backlog is the previous run not yet done; adding a second identical one would only pile up.
3. **Catch-up happens once, and then the checks still apply.** The one catch-up run can itself be skipped (previous active, limit); the missed ones are one `routine_runs` row with the count, not one row per slot.
4. **Only the hard limit skips.** Over the warning level a routine still adds its mission; P8's backlog rule holds a normal one until the month turns, and an urgent one is pulled. Skipping earlier would hide work the person asked for.
5. **Status report routines ignore the monthly limit and coalescing.** A report runs no agent and spends nothing; it is written in the same call.
6. **Paused means paused.** Turning a routine back on (or changing its schedule) schedules from now; the windows it was off for are not caught up.
7. **Every N hours is elapsed time**, anchored at the routine's previous slot (first slot N hours after it is turned on), so DST changes never make an interval shorter or longer.
8. **The daemon's local time zone** is the only zone (roadmap decision 12). Labels are rendered by the daemon so the window never re-computes a schedule.
9. **Done-when lines are required for mission routines only.** A status report routine keeps the template's lines as the description of what the report contains; the report is rendered from facts by a fixed template, so there is nothing for an agent to verify.
10. **`routine_runs` is added** beside the roadmap's `routines` table and `missions.routine_id`, so every skip is a record the window can show.
11. **The test clock is an env var plus a route**, both inert unless `TANDEMISE_CLOCK_OFFSET_MS` is set, so the real-app suite advances time without waiting and without a second clock.
12. **The routine runs as the person who created it.** A routine whose creator has left the team fails with "Could not run: …" rather than acting under someone else's name.
13. **Mission titles carry the run's date** ("Weekly dependency updates · Mon 28 Sep"), so two missions from one routine are told apart in the backlog; `{date}` in the goal is replaced with the same local date (YYYY-MM-DD).
14. **A deleted draft stops coalescing.** A queued draft has no Cancel; deleting it (the trash icon on its page) is how a person drops a run they do not want, and the next run proceeds. Taking it off the queue does not: it is still unfinished work from the routine.
