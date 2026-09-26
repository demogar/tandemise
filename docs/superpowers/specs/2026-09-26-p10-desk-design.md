# P10: The owner's desk

Status: design, 2026-09-26. Builds on P9 (liveness, `LivenessService`), P8 (limits, `LimitService`), P7 (the backlog, `describeWip`), P6 (the `StatusReport` artifact type, widened in migration 012) and P5 (the Done-when trace). Stacked on P9.

## Problem

One person runs their own agents. In the morning they open Tandemise and want five answers before anything else: what needs me, what is moving, how much of "done" is actually verified, what it has cost against my limits, and what is stuck.

Today each answer lives on a different screen, and some live nowhere:

- **Home lists, it does not count.** "Needs you now" shows two items and a link; "Active missions" is a list of up to twenty rows. Nothing says "2 of 2 in progress" or "1 stalled" at a glance.
- **Verified "done" is per mission only.** P5's "3 of 5 verified" is on each mission's feed. Across the work in progress there is no number at all.
- **Spend lives in Repositories → Limits.** Home shows a banner only once a limit is at its warning level.
- **The work-in-progress limit is only on the Backlog tab.** Home never says the slots are full and missions are queued behind them.
- **There is no status report.** Telling someone else how things stand means reading five screens and writing it up by hand, or asking a model, which can invent progress that never happened.

## Goal

**Home is the owner's desk.** A row of five cards, each a number with the words that make it mean something, each opening the filtered view behind it:

| Card | Value | Opens |
|---|---|---|
| Needs you | requests waiting on me: cards, my steps, refinements, quiet agents | Inbox |
| Working on | "2 of 2" (in progress of the work-in-progress limit), "3 queued" | Missions, filtered to the missions in progress |
| Criteria verified | "4 of 6" across the missions in progress | the same view, where each row now says "1 of 3 verified" |
| This month | "85%" of the monthly limit, "25.5 / 30 agent min" | Repositories → Limits |
| Stalled | missions nothing moves and nothing asks about (P9) | Inbox, filtered to stalled missions |

Two banners say what the numbers mean for tomorrow: **"Monthly limit at 85% — only urgent and high work will be pulled."** and **"Working on 2 of 2 — 3 queued missions wait for a free slot."**

**A status report no model wrote.** "Status report" on Home renders a `StatusReport` artifact from a fixed Markdown template over stored facts only: each mission's status, criteria verified of total with the keys that are not, its limit, what waits on a person, its last gate failure verbatim, and the backlog in pull order. It is versioned like any artifact and opens in the artifact reader. Rendering it twice from the same database gives the same bytes.

## Not in P10

- Charts over time, trends, burn-down: every number is "now". A history needs stored snapshots (later).
- A natural-language summary, or any model in the report. The report is a template over facts.
- Scheduled reports (P11 "status report" routine kind).
- Reports per mission or per person; exporting or sending a report.

## 1. The desk numbers

`HomeView` gains `metrics` and `banners`, computed by the daemon from rows on every read (`DeskService.metrics`). Nothing is stored.

| Field | Meaning |
|---|---|
| `needsYou` | open cards other than checks (P0: a check waits on nobody), steps parked for a person, refinements with something to decide, silent runs. Anyone's. |
| `active`, `wipLimit`, `queued` | P7's counts: missions in progress (not DRAFT, not PAUSED, not finished), the limit (null when off), queued drafts |
| `criteriaVerified`, `criteriaTotal`, `criteriaMissions` | P5's trace summed over the missions in progress: counted rows that PASS, counted rows, and how many missions have any |
| `month`, `monthUsage[]`, `usage` | P8's monthly limits measured now (`LimitStatusView`) and the month's raw usage |
| `stalled` | `services.liveness.stalled(ws).length` (P9) |

**Needs you and Stalled do not overlap.** A stalled mission needs the person too, and it keeps its row in "Needs you now" (P9). But on the cards each thing is counted once: "Needs you" counts requests, "Stalled" counts stuck missions, so "Needs you 1 · Stalled 1" means two things to look at, not one. The card counts what is *for me* with the same rule the Inbox badge uses, minus stalled rows; `metrics.needsYou` counts for anyone and feeds the report.

**Criteria scope is "in progress".** The same missions "Working on" counts, so the two cards talk about the same work. A paused or finished mission's criteria are not "done being verified", they are not being worked on.

**Banners** (`HomeBannerView { kind, text, href }`), in this order, each shown only when it is true:

- `month_warn`: the project's monthly limit at or over its warning level and under 100%: "Monthly limit at 85% — only urgent and high work will be pulled. This project used 25.5 of 30 agent minutes this month; work stops at 30 agent minutes." On Home it replaces P8's project-level warning banner (same facts, one banner); `limitAlerts` still carries P8's alert for other readers. At 100% P8's "Monthly limit reached" banner stays as it is.
- `wip_full`: a limit is set, in progress ≥ limit, and something is queued: "Working on 2 of 2 — 3 queued missions wait for a free slot. The next ready one is planned as soon as one finishes." Opens the Backlog tab.

## 2. The status report

### Facts

`DeskService.reportFacts(workspaceId)` reads rows only, through the services that already own each fact:

- the project's name; the clock's instant (`asOf`) and month;
- `metrics` (§1);
- per mission that is not DRAFT and not finished, in backlog order (`compareBacklog`: priority, rank, created, id):
  - status and status reason;
  - its liveness kind and, when stalled, the reason and the one action (P9 `classify`);
  - the trace (P5): verified of counted, failed keys, not-verified keys, user keys not covered by the spec, each in ledger order;
  - its limits (P8 `missionView`): each bar and percent; "No limit set" otherwise;
  - open decisions: pending cards other than checks (their titles), steps waiting on a person;
  - the last gate failure: the newest `gate.evaluated` event with `passed: false`, its step key and its `detail` exactly as stored (what the timeline and the card show).
- the backlog (P7 `view`): queued drafts in pull order with position, priority, readiness label and any "Held: …", then drafts not queued.

### Rendering

`renderStatusReport(facts)` in `@tandemise/domain` is a **pure function**: no clock, no I/O, no randomness, no locale-dependent formatting, no iteration over unordered maps. The front matter carries the title, the handoff and `asOf`. **The body never contains the time**, so two reports with nothing changed in between compare line for line as identical; the reader shows the time from the artifact's own record.

```
---
type: StatusReport
schemaVersion: 1
title: "Status report: <project>"
asOf: "<ISO instant from the Clock>"
handoff:
  headline: "1 needs you · working on 2 of 2 · 4 of 6 criteria verified · 1 stalled"
  points: [up to three: stalled missions first, then the month warning, then open decisions]
---

# Status report: <project>

## At a glance
- Needs you: 1
- Working on: 2 of 2 · 0 queued
- Criteria verified: 4 of 6, across 2 missions in progress
- This month (2026-09): 25.5 / 30 agent min (85%)
- Stalled: 1

## Missions
### <title>
- Status: Blocked. <status reason>
- Stalled: <reason> Next: Retry release.        | Waiting on you | Moving | Parked
- Criteria: 1 of 3 verified; AC2, AC3 not verified.
- Limit: 15 / 30 agent min (50%).
- Waiting on you: "release exhausted its retries".
- Last gate failure (release): Not met: qa.criteria_unverified is 2, needs 0

## Backlog
1. <title> · High · Ready to plan
- Not queued: <title> · Normal · Answer 1 question to plan

## How this report was made
Rendered by Tandemise from stored facts: mission and step rows, the Done-when ledger and the newest QA report, usage records, open cards and the event log. No model wrote it. The same facts always render the same report.
```

Every empty case has its own plain sentence ("No missions in progress.", "The backlog is empty.", "No monthly limit set: 12 agent minutes used this month.").

### Storing it

`POST /v1/workspaces/:id/status-report` renders the report, checks it against the `StatusReport` schema (a report that does not parse is a bug, and is refused, not stored), writes it through the artifact store and returns `{ artifactId, version }`. Each report supersedes the previous one, so reports form one version line (v1, v2, …) and the reader's "Compare with v1" shows what changed.

An artifact belongs to a mission (`artifacts.mission_id` is NOT NULL, since migration 001). A project report belongs to no mission, and rebuilding the artifacts table for it would be a table rebuild for one nullable column. Instead each project gets one **report holder**: a mission row titled "Status reports", workflow `status-reports`, status COMPLETE, created with the first report. `MissionRepository.list` never returns it, so it is in no list, count, backlog, liveness pass, limit or scheduler pass; only a direct read by id (the artifact's own link) sees it. Author: Tandemise (system); responsible: the person who asked.

The reader's version switcher, today only for a task's output, also lists a report's versions: same type, no task, same holder.

## 3. API

| Route | Does |
|---|---|
| `GET /v1/home` | gains `metrics` (`HomeMetricsView`) and `banners[]` |
| `POST /v1/workspaces/:id/status-report` | renders and stores a report; `{ artifactId, version }`; 404 unknown project |
| `GET /v1/missions` (and Home's lists) | `MissionSummary.criteria` `{ verified, counted }` or null |

No new approval kind, no migration, no new fact.

## 4. Desktop

- **Home**: under the header, a `section` aria-label "Desk" with five `Stat` cards, each a link with aria-label (`Needs you`, `Working on`, `Criteria verified`, `This month`, `Stalled`). Banners below them (the existing `.banner--warn`, as P8's). The header gains a **Status report** button (secondary: New mission stays the one primary); it shows "Writing…" while it runs, then opens the report.
- **Inbox** `/inbox/stalled`: only Stalled rows, with a banner "Showing stalled missions only" and "Show everything".
- **Missions** `/missions/backlog` opens on the Backlog tab; `/missions/in-progress` shows the missions in progress as the desk counts them (P7's rule, blocked ones included, which the Active tab leaves to "Needs attention"), with "Show all missions". Mission rows show "1 of 3 verified" when a mission has criteria.
- **Inbox** `/inbox/stalled` leaves out the "Decided" history too: it is the list behind one number.
- **Artifacts** `/artifacts/<id>` opens with that artifact selected in the reader.

## Testing

**Offline:** `scratch/p10-desk-check.mjs`, added to OFFLINE_CHECKS, written first and seen failing. It covers:

- The renderer, pure: fixed facts → the expected headings, criteria line ("1 of 3 verified; AC2, AC3 not verified"), gate text verbatim, backlog order, empty cases; the output parses as a `StatusReport`; the renderer's source reads no clock.
- **Byte-identical from a fixed DB**: an engine over a real SQLite file seeded with missions in every shape (in progress with a partial QA and a failed gate, stalled, waiting on a card, paused, queued and unqueued drafts, usage against a monthly limit), a fixed Clock; `reportFacts` + render twice → identical strings; the database file copied and opened by a second engine → identical string again; a later Clock changes only `asOf`.
- The desk numbers over the same DB match what the seeding implies; the holder mission is in no list, and two reports are v1 and v2 of one line.
- A real daemon: `POST /v1/workspaces/:id/status-report` twice → two artifacts, the second supersedes the first, bodies after the front matter identical; `GET /v1/home` has `metrics` and `banners`.

**Real app** (`scratch/acceptance/p10/`, CDP 9345, home `/tmp/tdm-p10`, workflow "P10 desk", knobs `SCRIPTED_QA_PARTIAL`, `SCRIPTED_SPEC_THREE_ACS`, `SCRIPTED_FAIL_RELEASE`, `SCRIPTED_USAGE_MIN`):

| # | Scenario | Must observe in the window |
|---|---|---|
| K1 | WIP 2; mission A's QA verifies 1 of 3 and its release exhausts its retries (card); mission B's QA verifies 3 of 3, its release exhausts too and is left blocked | cards "Needs you 1", "Working on 2 of 2", "Criteria verified 4 of 6", "Stalled 1"; the Stalled card opens the Inbox showing only "Stalled: B"; the Criteria card opens the missions in progress with "1 of 3 verified" and "3 of 3 verified" |
| K2 | Status report, twice | the reader shows the headings, "AC2, AC3 not verified" and "Not met: qa.criteria_unverified is 2, needs 0" exactly as the Inbox card says it; the second opens as v2, "Compare with v1" reads "0 lines added, 0 lines removed" |
| K3 | A monthly limit of 30 agent minutes with 25.5 used | the banner "Monthly limit at 85% — only urgent and high work will be pulled"; the This month card "85%" with "25.5 / 30 agent min"; the report says the same |

## Rulings

1. **A report holder mission instead of a migration.** Artifacts need a mission; a project report has none. One hidden "Status reports" row per project (never listed) keeps the artifact store, versions, search and the reader unchanged, and needs no table rebuild. If a later slice adds workspace-level artifacts properly, the holder's artifacts move with one UPDATE.
2. **The time is in the front matter, never in the body.** The same facts render the same bytes; a reader comparing two reports sees only what changed in the work, not that a clock moved.
3. **Needs you and Stalled are disjoint on the cards** (§1). "Needs you now" below still lists both, because both need the person.
4. **Criteria are counted over missions in progress**, the same set as "Working on".
5. **The month banner replaces P8's project warning banner on Home** rather than sitting next to it; the numbers are the same. The API keeps both (P8's `limitAlerts` is unchanged), the window shows one. P8's H4 real-app check now reads the new words.
6. **The last gate failure is quoted from the event log** (`gate.evaluated.detail`), not re-evaluated: it is what the person was shown when it failed. A mission whose last gate evaluation passed still reports its last failure, labelled with its step, because the report says what happened, not what should be tried.
7. **A report is refused, not stored, if it does not parse** as a `StatusReport`: the template is ours, so a failure is our bug and must not reach the person as a document.
8. **"In progress" gets its own filtered view.** The Active tab leaves BLOCKED missions to "Needs attention", but the desk counts them as in progress (P7's rule), so the cards open `/missions/in-progress` rather than a tab whose count would disagree with the card.
9. **Text from the rows is printed literally.** Titles, reasons and gate details are escaped for Markdown in the body (a backslash before `\ ` * _ [ ]`), and the reader's Markdown now honours backslash escapes, so a mission called "SCRIPTED_FAIL_RELEASE" is not shown in italics and a gate detail reads exactly as stored. The front matter is never escaped.
10. **No budget warning on reports.** A report is as long as the work it describes; it is written by the daemon, so "Over budget" (a note to an agent) never applies.
