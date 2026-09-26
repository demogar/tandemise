# P8: Hard limits on spend and time

Status: design, 2026-09-26. Builds on P7 (the backlog pull, `BacklogService`). Stacked on P7.

## Problem

A person running their own agents has no ceiling. A mission that keeps retrying, a review loop that does not converge, or a month of busy work spends agent time, tokens and (where the runtime charges) money until someone notices.

- Nothing measures a mission against a budget. `usage_records` has held every run's usage since 001, but nothing reads it for a decision; the Metrics tab only shows it.
- Agent time is not even recorded: `wall_time_ms` is never written, and a run that reports no usage writes no row at all.
- Nothing stops work. The only stop is a person pressing Pause, which lets running tasks finish, or Cancel, which throws the mission away.
- Nothing says "you are close". The first sign of overspend is the bill or the clock.

## Goal

Each mission, and the project per calendar month, has a ceiling on agent minutes, tokens or reported US dollars. The daemon measures usage from what runs recorded and decides:

- **Below the warning level** (80% by default): nothing happens.
- **At or over the warning level**: the mission's timeline says so with the numbers, Home shows a banner, and a project over its monthly warning level pulls only urgent and high missions from the backlog.
- **At or over 100%**: work stops. The mission is paused with the reason "Limit reached: 15 of 12 agent minutes", work in flight is stopped, and one card asks the person: **Raise limit and resume** (to a number they give) or **Keep paused**.

Every decision is a rule over measured numbers. Nothing an agent says moves a limit.

## Not in P8

- Invoices, provider billing, scraping a provider's quota page.
- Per-agent, per-role or per-model budgets.
- A planning run's time (planning has no Run row, `docs/KNOWN_LIMITATIONS.md`), so planning and refinement are not counted.

## 1. What is measured

Usage comes from `usage_records`, one row per finished run:

| Metric | From | Not reported |
|---|---|---|
| `agent_minutes` | `wall_time_ms`: the runtime's own duration when it reports one (Claude Code's `duration_ms`, a generic CLI's `wallTimeMs`/`duration_ms`), otherwise the run's duration by the daemon's clock | never: every run is timed |
| `tokens` | input + output tokens | no run reported tokens |
| `usd` | `cost_usd` where the runtime reported it | no run reported a cost |

"Not reported" is never 0. A USD limit on a runtime that reports no cost (a subscription runtime) is **unmeasured**: it never stops work, the Metrics tab says "Cost: not reported", and the timeline says once: "USD limit cannot be measured for this runtime: it does not report cost, so this limit never stops work. Set an agent minutes or tokens limit to cap this mission."

To make agent time always measured, the executor now records a usage row for every finished run with `wallTimeMs` set (reported, or measured). The `usage` agent event gains an optional `wallTimeMs`.

## 2. Limits and scopes

A limit is `{ metric, amount, warnPercent = 80 }`, at most one per metric per scope.

- **Mission**: `missions.limits` (its own list), or when NULL the project's `default_mission_limits`. The window is the mission's whole life.
- **Project per month**: `workspaces.monthly_limits`. The window is the local calendar month read from the injected Clock (roadmap decision 12), never the system clock: a check sets the clock to the last millisecond of a month and sees the window turn.

A level per limit: `ok` (< warn), `soft` (≥ warn), `hard` (≥ 100%), `unmeasured`.

## 3. The rules

The hard stop is a daemon rule enforced at two points.

1. **Admission.** `SchedulerService#dispatchFor` asks `LimitService.admit(mission)` once per mission per pass, before the first agent run it would start. A mission or project with any limit at 100% starts nothing; the stop below is applied if it was not already. `TaskExecutor.execute` asks the same question before it takes leases, so an attempt reached any other way is refused too (it returns `deferred`, never a run).
2. **After usage.** Right after `recordUsage`, the executor calls `LimitService.afterUsage(mission, run)`: soft levels warn, hard levels stop, an unmeasured USD limit is said once.

**Warn** (once per scope, metric, window and limit amount): a `soft` incident and a timeline note on the mission whose run crossed it: "Limit warning: 10 of 12 agent minutes used (83%). Work stops at 12 agent minutes." / "Monthly limit warning: this project used 51 of 60 agent minutes this month (85%). Only urgent and high missions are pulled from the backlog; work stops at 60 agent minutes."

**Stop** (a `hard` incident):

- Mission scope: the mission goes to PAUSED with the reason "Limit reached: 15 of 12 agent minutes". Project scope: every working mission (EXECUTING, REVIEWING, QA, READY_TO_SHIP) goes to PAUSED with "Monthly limit reached: this project used 61 of 60 agent minutes this month", and the incident remembers which ones.
- Work in flight is stopped (roadmap decision 6): every RUNNING task of a paused mission except the one whose finished run was just measured goes back to READY ("Stopped at a limit; it runs again when the mission resumes.") and its run is cancelled. Back to READY rather than CANCELLED, so nothing downstream is blocked.
- One `intervention` card (no new approval kind): "“Hello page” reached its limit: 15 of 12 agent minutes", evidence with the numbers and a suggested raise (double the limit, and always above what was used), options **Raise limit and resume** / **Keep paused**. A project card has no mission.
- One open incident per scope, metric, window, threshold and limit amount: the unique index is the rule. A second crossing of the same limit finds the row. A closed one (kept paused, then resumed some other way) is reopened with a new card.

**Decide** through `POST /v1/approvals/:id/decide`:

- `{ optionId: 'raise_limit', raiseTo }`: refused (400) unless `raiseTo` is above both the old limit and what was used ("Raise it above 15 agent minutes: at 14 agent minutes the work would stop again at once."). Otherwise the limit is replaced (the mission's own list, or the project's monthly list), the old limit's soft incident is closed, and each paused mission nothing else holds goes back to EXECUTING: "Limit raised to 30 agent minutes; resumed."
- `{ optionId: 'keep_paused' }`: the card is answered, the missions stay paused, and their reason says how to go on: "Kept paused at its limit: 15 of 12 agent minutes. Raise the limit to resume."
- **Idempotent**: the incident moves `open → resolved` with a conditional update inside the approval's transaction; a second decision (double click, two windows) finds the card already decided (409) and, even if it reached the rule, the incident already resolved, so it can never resume twice.

**Resume** from the header is refused at a limit (412): "Limit reached: 15 of 12 agent minutes. Raise the limit to resume this mission."

**Changing a limit** (mission PATCH, project PATCH) is the same decision as raising it on the card: an open stop the new limit no longer justifies is dismissed with its card cancelled, and the missions it paused resume; a mission kept paused at a limit resumes once no limit holds it. A limit lowered below what was already used stops the work at once.

### The backlog rule (with P7)

In `BacklogService.#pullFor`, before candidates are chosen: with the project at or over its monthly warning level only urgent and high queued missions are candidates; at the limit, none. A held mission stays queued and its Backlog row says why: "Held: this project is over 80% of its monthly limit (51 of 60 agent minutes). Only urgent and high missions are pulled." Normal and low sort after urgent and high, so the pulled missions' queue positions are unchanged.

### Facts

| Fact | Meaning |
|---|---|
| `mission.agent_minutes` | agent minutes the mission's runs used |
| `mission.tokens` | tokens reported; absent when none reported |
| `mission.spend_usd` | cost reported; absent when none reported, never 0 |
| `mission.limit_percent` | the highest measured share of a mission limit; absent with no limit |
| `workspace.month_limit_percent` | the highest measured share of a monthly limit; absent with no monthly limit |

## 4. Data (migration 014)

- `missions.limits TEXT` (JSON list; NULL: the project's defaults).
- `workspaces.default_mission_limits TEXT NOT NULL DEFAULT '[]'`, `workspaces.monthly_limits TEXT NOT NULL DEFAULT '[]'`.
- `limit_incidents(id, workspace_id, mission_id NULL, metric CHECK, window_start, window_end NULL, amount_limit CHECK > 0, amount_observed, threshold CHECK('soft','hard'), status CHECK('open','resolved','dismissed'), approval_id NULL, paused_missions JSON, created_at, resolved_at)`.
- `UNIQUE (workspace_id, COALESCE(mission_id,''), metric, window_start, threshold, amount_limit)` as an expression index.
- Index on `usage_records(recorded_at)` for the monthly sum.

All additive.

## 5. API

| Route | Does |
|---|---|
| `PATCH /v1/missions/:id` | gains `{ limits: Limit[] \| null }`; answers with the mission when only limits change. 412 on a finished mission |
| `PATCH /v1/workspaces/:id` | gains `{ defaultMissionLimits, monthlyLimits }` |
| `POST /v1/missions` | gains `limits?` |
| `GET /v1/workspaces/:id/usage?month=2026-09` | `WorkspaceUsageView`: the month's usage, its limits, per-mission usage |
| `POST /v1/approvals/:id/decide` | gains `raiseTo` |

Views: `MissionDetail.limits` (`MissionLimitsView`: source, per-limit status with its bar "15 / 30 agent min" and note, usage, the open card), `HomeView.limitAlerts`, `BacklogItemView.held`.

## 6. Desktop

- **New mission → More options → Limit**: Agent minutes / Tokens / Cost (USD) "for this mission", and Warn at (%). Blank uses the project's defaults.
- **Mission → Metrics → Limit**: one bar per limit ("15 / 30 agent min", amber over the warning level, red at the limit), usage stats (tokens and cost "not reported" when so), **Set a limit** / **Change limit**, **Use the project default**.
- **Mission page, any tab**: when paused at a limit, the reason banner and the limit card inline.
- **Limit card** (Inbox and mission page): "Limit reached" label, the numbers, a **Raise limit to** number field prefilled with the suggestion, **Raise limit and resume** and **Keep paused**. A refused number shows the daemon's sentence.
- **Home**: a banner per mission or project at or over a warning level, with the numbers; it links to the mission's Metrics tab, the Inbox (project at the limit) or Repositories → Limits.
- **Repositories → Limits**: this month's usage, the monthly bar, and two editors: per month for the whole project, and per mission unless a mission sets its own.
- **Backlog**: a held row's subtitle is the "Held: …" sentence.

## Testing

**Offline:** `scratch/p8-limits-check.mjs`, added to OFFLINE_CHECKS, written first and seen failing (against the P7 code: `evaluateLimit is not a function`). It covers the levels (unmeasured is never 0 and never stops), facts (absent when not measured), the month window from an injected clock (last millisecond of September, December into January), that the limit service and the domain never read the system clock, the words; the scheduler with a stub rule (a run is never dispatched in an over-limit mission, called directly); and a real daemon with the scripted agent in NDJSON mode reporting 5 agent minutes a run: migration 014, H1 (warning after run 2, paused after run 3, three runs, card, bar, Home alert, Resume refused), H3 (a raise below usage refused, two concurrent decisions → one 200 and one 409, resumed exactly once, finishes at 25 of 30 with a fresh warning), H2 (keep paused), admission (a lowered limit stops a working mission and no run goes ahead), H5 (unmeasured USD: completes, no incident, note once, tokens measured, cost null), a USD limit on reported cost stops at "$6.00 of $5.00", H4 (held label, high pulled, normal stays queued with a free slot), a project monthly stop (every working mission paused, one project card with no mission in the Inbox, raise resumes), and refusals.

**Real app** (`scratch/acceptance/p8/`, CDP 9343, home `/tmp/tdm-p8`, scripted agent with `SCRIPTED_USAGE_MIN`):

| # | Scenario | Must observe in the window |
|---|---|---|
| H1 | Limit 12 agent minutes, 5 per run | after run 2 the timeline reads "Limit warning: 10 of 12 agent minutes used (83%)…"; after run 3 "Paused", "Limit reached: 15 of 12 agent minutes", the card, "15 / 12 agent min", a Home banner |
| H2 | Keep paused on H1's card | still Paused, "Kept paused at its limit…", incident resolved, no more runs; Resume refused with the reason |
| H3 | Another mission stops at 12; raise to 30 in the Inbox | 14 refused ("Raise it above 15 agent minutes"); 30 → Executing, "15 / 30 agent min"; finishes at "25 / 30 agent min" |
| H4 | Project at ~85% of its monthly limit, WIP 1, Normal and High queued | High pulled; Normal "Held: this project is over 80% of its monthly limit …"; Home monthly warning |
| H5 | USD limit, runtime reports no cost | "not reported / $5.00", "Cost: not reported", timeline "USD limit cannot be measured for this runtime", no incident, mission completes |

## Rulings

1. **Agent minutes are always measured.** The runtime's own duration when it reports one, otherwise the run's duration by the daemon's clock, written as `usage_records.wall_time_ms` for every finished run. Without this the default metric (decision 5) would be "not reported" for most runtimes.
2. **Planning and refinement are not counted.** They have no Run row today; counting them needs that first.
3. **`amount_limit` is part of the incident key**, and the unique index uses `COALESCE(mission_id,'')`: SQLite treats NULLs as distinct, so the roadmap's plain UNIQUE would have allowed any number of open project incidents. Raising a limit and crossing the new one is a new incident, with a new card.
4. **`paused_missions` and `resolved_at`** are added to `limit_incidents`, so a raise resumes exactly the missions its stop paused.
5. **The card is an `intervention` with no task**, options `raise_limit` / `keep_paused`, risk `read` (the badge is hidden for limit cards: raising a limit is a spending decision, not a tool risk). No new approval kind.
6. **Stopped tasks go back to READY**, not CANCELLED, so a resumed mission continues where it stopped and nothing downstream is blocked by the stop.
7. **Resume is refused at a limit** (412 with the reason) instead of resuming and stopping again at the next dispatch.
8. **Changing a limit is a decision too.** A limit changed so it no longer stops the work dismisses the open card and resumes; one lowered below usage stops at once. The card and the editor always agree.
9. **A USD limit that cannot be measured never stops work** and is said once per mission, not per run.
10. **Tokens are input + output.** Cache reads and writes are billed differently by providers and are not what a person budgets.
11. **Project scope pauses every working mission** at its monthly limit, with one card for the project (no mission), which the Inbox shows.
12. **At the monthly limit nothing is pulled**; over the warning level only urgent and high are. A held mission stays queued.
