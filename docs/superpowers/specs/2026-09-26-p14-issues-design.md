# P14: GitHub issues in and out

Status: design, 2026-09-26. Builds on P5 (Done-when ledger), P6 (readiness gate), P7 (backlog), P9 (stalled missions) and P11 (the scheduler tick and the test clock). Stacked on P13.

## Problem

The person's backlog already lives somewhere: the GitHub issues contributors file, and the ones they file for themselves. Today each one has to be copied into Tandemise by hand (title, body, the "Done when" list), and when the work ships the person copies the result back: a comment on the issue, a link to the pull request, closing it. Two lists drift apart, and the people who filed the issue never hear what happened.

## Goal

I label an issue `tandemise` on a repository I opted in. Tandemise picks it up on its next check and adds a draft mission with the issue's text as the request. If the issue lists what "done" means, those lines become the mission's Done-when criteria and the draft is queued, ready to plan. If it does not, the draft waits as "Needs refinement" like any other. When the mission finishes, Tandemise comments on the issue with each criterion and whether it was verified, links the pull request, and (only if I asked) closes the issue when every criterion was verified. Nobody copies anything.

- **Opt-in per repository**, off by default. Nothing is read from GitHub until I switch it on.
- **Local first.** Tandemise asks GitHub through the `gh` command-line tool the machine already signed in to, on a timer. No webhook, no server, no token stored by Tandemise.
- **The issue is data.** Its title and body become the request, attributed to its author. Nothing in an issue can change a setting, a label, a limit or which issues are read.
- **Nothing skips a gate.** An issue only ever produces a draft through `MissionService.create`. Planning still waits for the P7 pull or the person's "Plan", which both read the P6 readiness gate.

## Not in P14

- Inbound webhooks, GitHub Apps, a stored GitHub token (the `gh` session is the only credential, as for the GitHub integration).
- Pull requests as a source, or issues from repositories Tandemise does not have a checkout of.
- Two-way editing: changing the mission's goal in Tandemise never edits the issue.
- Syncing labels, assignees, milestones or priority from the issue (priority stays the person's call, in the backlog).
- Following an issue whose label was removed (it keeps its mission; it is simply no longer watched).
- More than 100 open labelled issues per repository per check (the newest 100 are read; noted in the guide).

## 1. Concepts

### Issue settings, per repository

| Setting | Default | Meaning |
|---|---|---|
| Turn labelled issues into missions | off | the switch; nothing is read while it is off |
| GitHub repository | from the checkout's remote (`owner/name`) | where to read issues; editable because the remote may not be `origin` |
| Label | `tandemise` | only open issues with this label are read |
| Check every | 10 minutes (5, 10, 15, 30, 60) | on the scheduler tick, from the injected Clock |
| Workflow | the project's default | the workflow each mission from an issue uses |
| Post progress comments | on | comment when queued, when blocked, when done |
| Close the issue when the mission completes | off | and only when every criterion was verified |

Only the person can change these, in the window or through the API. Two repositories of one project cannot read the same GitHub repository (it would link one issue twice).

### A check

On each scheduler tick, for every repository with issues on whose last check is at least "Check every" ago (or that was never checked), Tandemise runs one check in the background, so a slow network never holds up dispatch. "Check now" runs the same check at once and waits for it.

1. `gh issue list --repo <owner/name> --label <label> --state open --limit 100 --json number,title,body,url,updatedAt,labels,author`.
2. For each issue:
   - **New** (no link for this repository and number): record the link first, then create the draft (below). The link is unique on `(repository, issue number)`, so a second check, a second tick or a restart finds it and creates nothing.
   - **Known, text changed** (title or body differs from what was last read): see *Edited upstream*.
   - **Known, was closed**: it was reopened; a timeline note says so. It is not queued again (the person decides).
3. For each link that was open and is no longer in the list, `gh issue view <n> --json state,…` says why: **closed** (see *Closed upstream*), or still open without the label (the link stops being watched; the mission is untouched).
4. The check's time and any error ("Could not check issues: The GitHub CLI is not authenticated. Run `gh auth login`.") are stored and shown.

### The draft

- **Title**: the issue's title.
- **Goal**: the issue as written, attributed:

  > GitHub issue #12 in example/demo, opened by @sam: https://github.com/example/demo/issues/12
  >
  > The request as the issue's author wrote it:
  >
  > *title*
  >
  > *body*

  The planner and every agent read this as the person's request, which is what it is: the person chose to label it. It is never read as instructions to Tandemise itself; no code path parses it for anything but criteria.
- **Done when**: parsed deterministically from the body (below). Found lines become U1…Un, recorded as coming from the issue.
- **Criteria found** → the draft is **queued** (P7), ready by construction (P6: accepted criteria, no open questions).
- **None found** → the draft is **not queued** and waits as "Needs refinement" in the Backlog. The person refines it, adds criteria and queues it as any other draft.
- Repository, workflow and the acting person: the opted-in repository, the setting's workflow, and the person who switched the setting on (like a routine, it never acts under someone else's name).

### Parsing "Done when"

`parseIssueCriteria(body)` is a pure function:

- A section starts at a heading (`#`…`######`), a bold line (`**Done when**`) or a plain line ending in a colon whose text is **Done when** or **Acceptance criteria** (any case, optional trailing colon). It ends at the next heading or bold heading line.
- Inside a section: markdown checklist items (`- [ ]`, `- [x]`, `* [ ]`) if there are any; otherwise list items (`-`, `*`, `+`, `1.`); otherwise each paragraph as one line.
- An inline `Done when: the page loads offline` is one criterion.
- Lines inside fenced code blocks are ignored. Duplicates are dropped. At most 20 criteria, each cut at the ledger's 2,000-character limit.
- A checklist anywhere else in the issue is not a criterion (a to-do list is not acceptance). A ticked box counts the same as an empty one: ticking it upstream verifies nothing.

### Edited upstream

- **Before planning starts** (the mission is a DRAFT): the title and goal follow the issue. If the parsed criteria changed, the criteria that came from the issue are superseded and the new ones added (criteria the person added or accepted in Tandemise are kept). A note says "Issue #12 was edited upstream; the goal and Done-when lines were updated." If the draft was waiting for criteria and now has some, it is queued; if it was queued and now has none, it is taken off the queue.
- **After planning starts**: nothing about the mission changes. A timeline note says "Issue #12 was edited upstream after planning started; this mission keeps its plan." A running mission is never rewritten.

### Closed upstream

- **A draft**: taken off the queue, with the note "Issue #12 was closed upstream, so this draft was taken off the queue." It is not deleted; the person may still run it.
- **A mission past DRAFT and not finished**: untouched, with the note "Issue #12 was closed upstream; this mission carries on. Cancel it if the work is no longer wanted."
- **A finished mission** (including one Tandemise closed itself): nothing.

### Write-back

After each check, and on every scheduler tick in the background, Tandemise compares what each linked issue should say with what it already said. It only calls `gh` when they differ, so a quiet project makes no calls.

| When | Comment (kind) | Body starts with |
|---|---|---|
| the draft is queued | `queued` | `Queued in Tandemise — 3 criteria.` then the criteria table |
| P9 says the mission is stalled | `blocked` | `Tandemise is stuck on this: <reason>. Next step in Tandemise: <action>.` — at most once per stall |
| the mission is COMPLETE | `completed` | `Done in Tandemise — 3 of 3 criteria verified.` then the table (key, criterion, Verified / Failed / Skipped / Not verified) from the P5 trace, then pull request and branch links from the handoffs, if any |

Each comment carries an HTML marker, `<!-- tandemise:queued -->` (`blocked`, `completed`), and its GitHub comment id is stored per `(link, kind)` with the body last written. So:

- The same body is never written twice. A changed body (the criteria were edited while queued, a second stall) **updates** the one comment of that kind rather than adding a new one.
- If Tandemise stopped after posting but before storing the id, the next pass lists the issue's comments by the signed-in `gh` user, finds the marker and adopts that comment instead of posting again.
- Text copied from the issue into a comment is escaped (table pipes, backticks) and `@mentions` are broken with a zero-width space, so a comment never pings anyone.

**Closing** needs both: the setting is on, and every criterion in the trace is Verified (and there is at least one). Then `gh issue close <n>` once; the time is stored. With a Failed or Not verified criterion, the completion comment says "Left open: 1 criterion was not verified." and the issue stays open.

**Stalls**: a link remembers that its mission's current stall was reported. When P9 no longer classifies the mission as stalled, the flag clears; the next stall updates the `blocked` comment once more.

A `gh` failure during write-back is logged and retried no sooner than a minute later; the check's error is shown in the settings.

### What issue text can never do

- The label, the repository, the interval, the switches and the workflow come only from the settings, which only the person writes.
- The poll never reads comments or labels for commands; the comment listing only looks for Tandemise's own markers on comments by the signed-in user.
- Priority, limits, staffing and the readiness gate are untouched by anything in the issue. An issue with a "Done when" list is exactly as ready as a mission the person typed with the same lines.

## 2. Words

| Where | Text |
|---|---|
| Settings row | "Last checked 2 min ago · 3 linked", "Not checked yet · 0 linked", "Off", "Checking…", "Could not check issues: …" |
| Settings hints | "Open issues with this label become draft missions.", "Tandemise comments when it queues the work, when it is stuck, and when it is done.", "Only when every criterion was verified." |
| Mission header | chip "From issue #12" (opens the issue in the browser) |
| Backlog row | chip "#12" before the title (opens the issue) |
| Timeline | "Created from GitHub issue #12 by @sam.", edit, close and reopen notes above |

## 3. Data (migration 019)

Additive:

```sql
CREATE TABLE issue_sync (repository_id PK → repositories CASCADE, workspace_id → workspaces CASCADE,
  enabled 0/1, github_repo NULL, label, poll_minutes, close_on_complete 0/1, post_comments 0/1,
  workflow_preset NULL, enabled_by NULL, last_checked_at NULL, last_error NULL, created_at, updated_at);
CREATE TABLE issue_links (id isl_, workspace_id, repository_id → repositories CASCADE, github_repo, issue_number,
  url, title, body, author, upstream_updated_at, state open|closed|unlabelled, status pending|linked,
  criteria_count, stall_open 0/1, closed_by_us_at NULL, created_at, updated_at, UNIQUE (repository_id, issue_number));
CREATE TABLE issue_comments (link_id → issue_links CASCADE, kind queued|completed|blocked, comment_id, body,
  posted_at, updated_at, PRIMARY KEY (link_id, kind));
ALTER TABLE missions ADD COLUMN issue_link_id TEXT REFERENCES issue_links(id) ON DELETE SET NULL;
```

The link is written before its mission (status `pending`) and the mission carries `issue_link_id`, so a restart between the two finds the mission by its link rather than making a second one. A link whose mission the person deleted stays `linked` with no mission, so the issue does not come back.

## 4. API

| Route | Does |
|---|---|
| `GET /v1/workspaces/:id/issues` | `IssuesOverview { repositories: RepositoryIssuesView[], links: IssueLinkView[] }` |
| `PATCH /v1/repositories/:id/issues` | settings (any field); 400 on a bad label, repository or interval; 409 when another repository of the project reads the same GitHub repository |
| `POST /v1/repositories/:id/issues/check` | check now, wait for it, answer with `RepositoryIssuesView` (412 when off) |

`Mission.issueLinkId`. Every change invalidates `missions` (the Backlog and mission pages show the chips).

**Adapter.** `IssueTrackerPort` (domain) is implemented by `GhIssueTracker` in `@tandemise/integration-github`, over the same command executor and `gh` error words as the GitHub tools. The daemon binds it; the application's default finds nothing.

## 5. Desktop

- **Repositories → Issues** section (its own file, `screens/project/Issues.tsx`), one card per repository: the switch, GitHub repository, Label, Check every, Workflow, Post progress comments, Close the issue when the mission completes, **Save**, **Check now**, and the status line.
- **Mission header**: "From issue #12" chip, opening the issue with `openExternal`.
- **Backlog row**: an "#12" chip before the title, opening the issue.
- **Timeline**: the notes above.

## Testing

**Offline:** `scratch/p14-issues-check.mjs`, added to OFFLINE_CHECKS, written first and seen failing. A fake `gh` (`scratch/fake-gh.mjs`, installed as `gh` first on PATH) serves issues and comments from a JSON file and records every call. It covers:

- **parsing**: checklist under `## Done when`; bullets under `Acceptance criteria:`; `**Done when**` bold heading; inline `Done when: …`; ticked boxes; code fences ignored; a checklist with no heading is not criteria; duplicates; no section → none.
- **comments**: marker, escaping, no mentions, table words.
- **engine** (real SQLite, injected clock, the real `GhIssueTracker` over the fake `gh`): settings validation; a check creates a queued draft with U1…Un for a checklist issue and an unqueued one for an issue without criteria; a **second check creates nothing** (dedupe); the interval is honoured by the tick; edit before planning updates goal and criteria; edit after planning only notes; the queued comment is posted once and updated (not re-posted) when criteria change; **a restart (new container on the same database) posts nothing again**; a comment posted but not recorded is adopted by its marker; completion with every criterion verified posts the table and closes; **with one failed criterion it comments but never closes**; closing off never closes; a stall comments once per stall; **an issue closed upstream takes its draft off the queue** with a note, and leaves a running mission alone apart from a note; issue text never changes a setting.
- **daemon**: migration 019 columns, the three routes, `gh` found on the daemon's PATH.

**Real app** (`scratch/acceptance/p14/`, CDP 9349, home `/tmp/tdm-p14`, scripted agent, fake `gh` first on the daemon's PATH, the project's checkout given a GitHub remote):

| # | Scenario | Must observe in the window |
|---|---|---|
| O1 | Turn issues on for the repository in Repositories → Issues (workflow "P10 desk"); a labelled issue #11 has a `## Done when` checklist; Check now | the status reads "Last checked … · 1 linked"; the Backlog shows the draft with an "#11" chip, "Ready", "Queued"; its Done when lists U1–U3; its header reads "From issue #11"; the fake `gh` recorded the "Queued in Tandemise — 3 criteria" comment |
| O2 | A labelled issue #12 with no criteria; Check now | its draft shows "Needs refinement" and "Not queued"; no comment was posted on #12 |
| O3 | Turn on "Close the issue when the mission completes"; plan #11's draft, approve, let it complete | the mission completes; the fake `gh` recorded one completion comment with the criteria table (U1–U3 Verified) and one `issue close 11` |
| O4 | Check now again; then a new labelled issue #13 with criteria is checked in and closed upstream; Check now | no new mission after the repeat check; #13's draft is taken off the queue ("Not queued") and its timeline says "Issue #13 was closed upstream, so this draft was taken off the queue." |

## Rulings

1. **Settings live in their own table**, keyed by repository, rather than new columns on `repositories`, so a repository without the feature has no row and the P15 setup export can ignore them until it chooses to carry them.
2. **The GitHub repository is a setting**, prefilled from the checkout's remote. A remote that is not `origin`, or a fork, would otherwise be read wrong, and the acceptance project gets a remote without a real GitHub.
3. **An issue's draft uses a workflow from the settings** (default: the project's own), because a mission from an issue should be planned the way this repository's work is planned; the acceptance run uses it to get a deterministic workflow.
4. **Only issues read by the check are ever acted on.** Label removal stops watching; it does not cancel or dequeue anything.
5. **A reopened issue is noted, not re-queued.** The person already decided once; the note tells them.
6. **Edits rewrite only what came from the issue.** Criteria the person added or accepted in Tandemise survive an upstream edit; issue-born criteria are superseded (kept on record), so keys continue (U4…) rather than being reused.
7. **Comments are state, not events.** What each issue should say is derived from the mission's current state each pass and compared with the stored body; this is what makes write-back idempotent across restarts and crashes, and why a quiet project makes no `gh` calls.
8. **Adoption by marker only trusts the signed-in user's comments**, so a contributor pasting a marker into their own comment cannot get Tandemise to edit it.
9. **"Every criterion verified" means every row of the P5 trace is Verified** (user and spec criteria), with at least one row. Anything else leaves the issue open and says why.
10. **Checks run in the background of the tick** so a slow or hanging `gh` never delays dispatch; "Check now" waits for its own check.
11. **The acting person is whoever switched the setting on**, as with routines; if they left the team, the check fails with a message rather than acting under another name.
12. **No new approval kinds, no new gate facts.** Issue sync is outside the gate language: it creates drafts and writes comments; everything that decides progress is unchanged.
