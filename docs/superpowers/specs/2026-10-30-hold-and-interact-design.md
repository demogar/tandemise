# Hold and interact: take over a running agent in its own terminal, then let it continue

Status: design, 2026-10-30. This is the first sub-project of the software-factory pivot (#56). It is tracked in #50. Background and decisions are in `2026-10-30-tandemise-pivot-notes.md`.

## The problem

The owner stopped using Tandemise and went back to Claude Code. The reasons were:
- the process was rigid;
- it was unclear what the agent was doing;
- when an output was wrong, there was no way to iterate on it.

In Claude Code you keep talking to the agent until the work is right. In Tandemise you can only:

- **Leave a note.** It is queued (`status: queued`) and delivered only after the current pass ends, as a resumed pass (`TaskExecutor#deliverQueued`). Nothing reaches a live run.
- **Request changes after the fact.** This goes through `FeedbackRounds.beginRound` and costs a review round.
- **Continue elsewhere / Take it back / Hand back** (`MissionService.parkTask`/`unparkTask`/`handBack`, spec A4). This cancels the run. Taking it back starts a *fresh* round, because a cancelled run is not RESUMABLE. The agent loses its conversation.

None of these lets a person sit with the agent, in the agent's own session, and iterate.

## Goal

At any point in an agent task, a person presses **Hold**. The autonomous run stops where it is, and the person lands in the **real Claude Code terminal** inside Tandemise. The terminal has the same session (everything the agent read, did and said), the same worktree and the same tools. The person iterates as long as they like. Then they press **Continue**, and the engine resumes the same session headlessly and carries on through its usual pipeline:
1. commit
2. harvest
3. checks
4. gate
5. score
6. judge

Success means the owner can do in Tandemise what they do today in raw Claude Code: correct the agent mid-task and keep going. They never leave the app, and the agent's context is never lost.

## Non-goals (this sub-project)

- **Changing the process from inside the hold** (skip QA, add a step, switch model) through tools in the terminal. The existing plan-fit and replan-the-rest flows stay the way to change the plan. A Tandemise MCP tool for this belongs to #53.
- **Turning corrections into lessons.** That is #51. This sub-project only *records* each hold with enough data for #51 to mine it (see "Record").
- **Holding Codex or generic runtimes.** The first version covers Claude Code. Other adapters declare a capability and get the feature when they implement it.
- **A chat panel or messaging.** The pivot rules out messaging. The interaction surface is the real terminal, because "if they are producing code and are not comfortable with a command line, they are not where they should be".
- **Packaging the app** (#58) and the team server (#54).

## Approaches considered

1. **Daemon-owned PTY, terminal panel in the app** *(chosen)*. On Hold, the daemon stops the headless run so it ends RESUMABLE. It then spawns `claude --resume <session>` under a pseudo-terminal in the task's worktree, with the same flags, environment and a re-provisioned MCP gateway. Bytes stream over a WebSocket to an xterm.js panel in the desktop. On Continue, the daemon ends the PTY and the executor resumes the session headlessly.
   - It meets "everything inside Tandemise".
   - It keeps the boundary rule: the daemon owns state and processes, and the desktop is a control surface. A later web client could reuse the same stream.
   - Cost: a native module (`node-pty`, built for the daemon's Node 22 ABI like `better-sqlite3`) and a terminal component in the renderer.
2. **Open the user's own terminal app** with the resume command, plus a Continue button in Tandemise. This is cheap: no PTY, no xterm. But it leaves the app, depends on the OS terminal (different on Linux, macOS and Windows), and the daemon can't see when the session ends. Rejected as the main path because the owner asked for it "idealmente todo desde el mismo tandemise". It may come back later as a "pop out" option.
3. **Inject messages into the live headless run** (`--input-format stream-json`) behind a chat box. Nothing has to be killed or respawned. Rejected for three reasons:
   - It isn't the real Claude Code: no slash commands, no skills UI, no permission prompts.
   - It amounts to building a messaging surface.
   - The owner explicitly chose the real terminal.

## Decisions

### Where a hold can start

The first version supports agent tasks (not person steps, not wait steps) in these statuses:

| Task status | What Hold does |
|---|---|
| RUNNING | Stops the run so it ends RESUMABLE, then resumes its session interactively. |
| AWAITING_INPUT (agent asked a question via `ask_human`) | Same as RUNNING. The pending `choice` approval is withdrawn, and the person answers in the terminal instead. |
| AWAITING_APPROVAL on the task's *output* (a run exists) | This is "request changes, interactively". The hold **opens a new feedback round** through `FeedbackRounds`, the only reopen path, with the usual version bump and downstream impact. The output under review is set aside the same way request-changes sets it aside, and review-pipeline progress resets as it does for request changes. The interactive session resumes the latest settled session of that profile (`#settledSession`). |
| READY (not started) | Routes the task as a normal start would, and applies every usual start check: approval before start, mission limits, repository leases, missing-skill refusal. A failed check refuses the hold in its own words. If the checks pass, it provisions the worktree and starts a fresh interactive session with the task's compiled prompt. |
| RUNNING, but its stream has ended (commit, harvest, checks, delivery or tighten pass in progress) | **Refused for now:** "It's checking its work. You can hold it once that's done." The UI shows Hold disabled with that reason. Once the pass settles, the task is either AWAITING_APPROVAL (holdable as above) or finished (request changes). |

Every other status keeps its current tools: SUCCEEDED → request changes, FAILED/BLOCKED → retry, and so on. "At any point" means *while the agent owns the work*. Holding a finished task is a feedback round, which already exists.

### The hold record

Add a `task_holds` table (append-only migration). Its fields:

| Field | Meaning |
|---|---|
| `id`, `taskId`, `missionId` | What is held. |
| `heldBy` | The member who started the hold. |
| `fromStatus` | The task status the hold started from. |
| `runtimeProfileId` | The hold's **pinned** runtime profile. |
| `sessionBefore` | The session the hold started from; null for a READY hold. |
| `sessionAfter` | The session captured from the terminal. |
| `ptyPid` | The terminal process. |
| `startedAt`, `endedAt` | When the hold began and ended. |
| `endedBy` | Who ended it. |
| `ending` | `continued` or `released`. |
| `diffStat` | Files and lines changed during the hold. |
| `dir` | `missions/<m>/holds/<holdId>/`, for the hook file and the gateway config. |

At most one open hold (no `endedAt`) per task.

The hold record, not an in-memory `continueSession`, is where the captured session lives. When the executor dispatches a task that has an **ended, unconsumed `continued` hold**, it does four things:
- uses `sessionAfter` as `resumeFrom`;
- pins routing to `runtimeProfileId`;
- spends no attempt;
- marks the hold consumed.

Separately, `#resumableRun` must also check that the profile matches, as `#settledSession` does (`task-executor.ts:2280-2294`). Otherwise a resume can be routed to another Claude config dir, miss its session, and silently start fresh.

Eval trial missions (`isTrialMission`) can never be held. Like every other person-facing path, they must not reach a person.

### Task status: HELD

Add `HELD` to the task status enum, to the parked group (`PARKED_TASK_STATUSES`) and to `ACTIVE_TASK_STATUSES`. Without the last one, `Scheduler#reconcile` (`scheduler.ts:573-582`) would mark a mission BLOCKED when its only live work is held. A held task:
- is never dispatched;
- holds its downstream tasks the way AWAITING_EXTERNAL does.

Widen the `mission_tasks.status` CHECK by editing `sqlite_master` in place, as in migration 006 (`006_task_park_statuses.ts`). Never rebuild the table: a rebuild cascade-deletes under foreign keys.

**Capacity and cost.** A live terminal is a real Claude process, so it occupies one concurrency slot of its pinned profile from the moment it spawns until it ends. Ending means Continue, Release, exit, or a daemon restart. Its token spend is not visible to run-usage accounting, so it is recorded as **unmeasured (null)**, never 0. Mission limits (P8) count only measured spend, as today. AWAITING_EXTERNAL isn't reused because it means "the person took it outside Tandemise", and liveness rule T8b and the Inbox would describe it wrongly.

A task records who holds it (the member) and when the hold began. One person holds a task at a time.

### Hold, in order (persist before the side effect)

1. **Transaction:**
   - set the task to HELD (holder, `heldAt`);
   - withdraw any pending `choice` or output approval for it;
   - record a `task.held` event.
2. **After commit:** if a run is live, abort it with a dedicated reason (`TaskHeld`, alongside `DaemonStopping`). This takes two executor changes, because today neither path gives this result:
   - The run status at `task-executor.ts:802-807` must be RESUMABLE for `TaskHeld` too, keeping `externalSessionId`. Today only `isDaemonStopping` gets RESUMABLE.
   - `#stopped` must leave HELD alone. Today only the cancelled branch respects a status written by someone else (`:1597-1601`); the interrupted branch always settles READY (`:1586-1592`).

   Nothing after the stream runs for that pass: no commit, harvest, checks or gate. The hold's `sessionBefore` is that run's `externalSessionId`.
3. **Wait** until the run row is no longer live (bounded, a few seconds; SIGKILL after the adapter's usual SIGTERM grace).
4. **Provision the interactive session:**
   - Make sure the worktree exists (`ExecutionTarget`).
   - Provision a fresh MCP gateway for the hold, with the run's grants **minus `human.ask`**; the person is already in the session. The run's gateway was disposed when its pass ended. Tool calls whose policy is "ask" still raise their approval as usual, because a hold is not a reason to weaken policy. While a hold is open, those approvals also show as a banner in the terminal panel, so the person sees them without leaving.
   - Separately, `ask_human` must only write AWAITING_INPUT from RUNNING (`tools/ask-human.ts:115-120`). Today it writes from any status.
   - Spawn the PTY (see below).
   - Record the hold's PTY pid on the task.

If any step after the transaction fails, the task stays HELD and the panel shows the failure in the daemon's own words. The person can retry opening the terminal or press Continue; Continue works from the last RESUMABLE session.

### The interactive invocation

The Claude adapter gains `interactive(sessionRef | null, request)`, which returns `{ file, args, env, cwd }`. It does not return an event stream. It reuses `buildInvocation` for parity, with three changes:
- no `-p` and no `--output-format stream-json --verbose`;
- the prompt is passed as the initial message only for a fresh READY hold;
- `--resume <sessionRef>` when there is a session.

Everything else is identical, because a session is only resumable under the same config dir, cwd and tools:
- `--permission-mode` derived from grants;
- `--setting-sources`;
- `--allowed-tools` and `--disallowed-tools`;
- `--add-dir`;
- `--mcp-config <hold gateway> --strict-mcp-config`;
- the profile's own args;
- the filtered runtime env, including `CLAUDE_CONFIG_DIR`;
- the worktree cwd.

The adapter declares the capability `interactive_resume`. Hold is offered only when the task's routed runtime profile has it.

**The session the person ends on.** `--resume` may continue under a new session id. The daemon must capture the id the interactive session actually used, because Continue resumes *that* one, not the original. Mechanism: pass a `SessionStart` hook through `--settings` that writes the session id to a file in the hold's own directory (`missions/<m>/holds/<holdId>/`). A READY hold has no run, so the file can't live under a run directory. The daemon reads that file. The builder should verify against the installed Claude Code version whether resume keeps or replaces the id, and keep the hook either way.

### The terminal

- **Daemon:**
  - `node-pty`, spawned with the invocation above. `TERM=xterm-256color` and `COLORTERM` are already allowed.
  - One PTY per held task.
  - The daemon keeps a bounded scrollback ring (about 1 MB), so a reconnecting client repaints.
- **Transport:** a WebSocket at `GET /v1/tasks/:id/terminal`, authenticated like `/v1/stream`.
  - Binary frames carry PTY output to the client and keystrokes to the PTY.
  - JSON control frames carry `resize` (cols/rows) and `exit` (code).
  - Several clients may attach to the same PTY (two windows). All of them see the output, and any of them can type.
- **Desktop:**
  - An xterm.js panel (with the fit addon) opens from the task: a full-height pane over the mission screen, with the task title, the holder, and the **Continue** and **Close terminal** buttons.
  - Closing the panel does *not* end the hold; the PTY keeps running.
  - The renderer stays a control surface. It talks to the daemon only through this socket and the existing REST client.
- **If the PTY exits on its own** (the person typed `/exit`), the task stays HELD and the panel offers **Continue** or **Open the terminal again**. Reopening resumes the captured session.
- **If the daemon restarts during a hold,** the PTY dies with it and the task stays HELD. Recovery must leave HELD tasks alone: it must not requeue them. Reopening the terminal resumes the last captured session.

### Continue

1. **Transaction:**
   - set the task READY;
   - end the hold record (`ending: continued`, `sessionAfter`, `diffStat`);
   - record a `task.hold_ended` event.
   - Continuing spends **no attempt**, because the person's iteration isn't a failure. The executor recognises the unconsumed hold (see "The hold record"). This applies to every hold kind, including READY and AWAITING_APPROVAL holds, which have no RESUMABLE run.
2. **After commit:**
   - End the PTY: send it `/exit` and EOF, then SIGTERM, then SIGKILL after a grace period.
   - Dispose the hold gateway.
   - `scheduler.wake()`.
3. The executor dispatches the task as a resumed pass on `continueSession`. Its prompt is a short, fixed continuation: "A person held this task and worked with you directly in this session. Their changes are in the worktree. Continue the task from where things stand now and finish it."
4. The task then runs its usual pipeline: commit, harvest, checks, gate, score, judge.

The pass produces the task's normal declared output. A pass that ends without one fails the usual way and can be retried or held again.

A **Release** action is for when someone else needs the task, or the person wants to drop the hold without continuing it. Release ends the PTY and ends the hold (`ending: released`). It returns the task to READY. The next pass still resumes the hold's captured session on its pinned profile, since the context is worth keeping. It sends the task's normal compiled prompt, the same thing a resume sends today, instead of the continuation message.

**Who may act.** Continue and Release follow the existing rule for taking a task: `MissionService.#assertMayTake`. The holder may always act. Anyone else that rule allows may Release, and the event records who did. Only the holder may Continue. The terminal socket uses the daemon's own token, which is fine for a local-first daemon used by one person. Per-member terminal access belongs to the team server (#54).

**Notes left while held.** These are queued, as notes on a running task are. The continuation pass delivers them, appended to the continuation prompt. `feedbackEffectFor` (`support/feedback-rules.ts`) gets an explicit HELD case instead of falling through to "attach".

### Visibility ("what is it doing")

- Each live agent task shows a one-line **"Now"** in plain language. It is built in the daemon from the latest run event: the tool and its target ("Editing src/app/page.tsx", "Running npm test"), or the latest assistant text, cut short.
- It appears on the task card in Plan and Feed, and at the top of TaskDetail.
- Raw tool names never appear. When nothing is known yet, it reads "Starting…".
- The **Hold** button sits in the TaskDetail footer and on the in-progress card, next to "Continue elsewhere".

### Record (for #51)

`task.held` and `task.hold_ended` carry:
- `heldBy`;
- the status the hold started from;
- the session ids before and after;
- the hold's duration;
- the worktree diff stat between hold start and end (files and lines).

The terminal byte stream is **not** stored; the Claude session transcript already lives in Claude's own store. This gives #51 what it needs to find "where people had to step in" without designing learning here.

### API

Following the pattern of `/v1/tasks/:id/park|unpark|hand-back`:
- `POST /v1/tasks/:id/hold`
- `POST /v1/tasks/:id/continue`
- `POST /v1/tasks/:id/release`
- `GET /v1/tasks/:id/terminal` (WebSocket)

Refusals come back in the daemon's own words. Examples:
- "This step is done; request changes instead."
- "Only Claude Code steps can be held for now."
- "Held by Ana since 10:42."

## Constraints

- Everything executes locally, on the person's machine (pivot decision).
- Respect the layer rules (`npm run check:boundaries`).
  - The PTY lives in a layer-3/4 package; `execution-local` or a new `terminal` package are both fine.
  - The application layer depends only on a port (`InteractiveSessions`).
- The daemon must keep working where `node-pty` fails to load. In that case Hold is offered as unavailable, with the reason. The rest of Tandemise is unaffected.
- `node-pty` must work on Linux and macOS for this sub-project; Windows can follow #58.
- Repo artifacts are in English.

## Left to the builder

- The package that hosts the PTY, and the port's exact shape.
- Scrollback size; grace periods for SIGTERM and SIGKILL; xterm.js theme tokens. Use `palette.css`/`theme.css`, with no hard-coded colours.
- Exact copy, following the UI conventions: "you", plain verbs, no raw enums.
- How the "Now" line summarises each tool event.
- Whether the panel is a modal pane or its own route, provided closing it never ends the hold.

## Acceptance (real app)

Proven in the real desktop window (fresh `TANDEMISE_HOME`, daemon from this checkout, `electron-vite dev` over CDP), plus an offline check for the domain and service parts.

A fake `claude` script stands in for the real CLI in CI. It must:
- accept `-p … --output-format stream-json`;
- emit a `session.init` and some events;
- run an interactive mode on a PTY that echoes input and writes a file;
- honour `--resume`.

One scenario also runs the real Claude Code when it is available, as A15 does.

1. **Hold a running task.** The run ends RESUMABLE, the task is HELD, and the terminal panel shows the resumed session. Typed input reaches it (the fake CLI echoes it).
2. **Iterate.** A file written during the hold is in the worktree.
3. **Continue.**
   - The task runs a resumed pass on the captured session id.
   - The attempt count is unchanged.
   - The task's output is harvested and gated as usual.
   - `task.hold_ended` carries the diff stat.
4. **Close the panel mid-hold.** The PTY keeps running, and reopening repaints the scrollback.
5. **Restart the daemon mid-hold.** The task is still HELD, and reopening resumes the captured session.
6. **Hold a task waiting on `ask_human`.** The question card disappears from the Inbox.
7. **Hold a READY task.** A fresh interactive session starts in a provisioned worktree.
8. **"Now".** A running task shows a plain-language "Now" line that changes as events arrive.
9. **Refusals.** Holding these is refused in plain words:
   - a SUCCEEDED task;
   - a task whose stream has ended but is still checking its work;
   - a trial-mission task;
   - a task on a runtime without `interactive_resume`.
10. **Hold an output under review.** A new round opens, and Continue produces a new output version that goes through review again.
11. **Profile pinning.** With two Claude profiles configured, Continue resumes on the hold's profile.
12. `npm run ci` is green.

## Calls made without the owner

The owner gave autonomy within the pivot direction. These calls came out of a builder review of this spec and are open to correction:
- Holding an output under review opens a new feedback round. It does not rewrite the current round.
- A hold whose stream has ended but which is still checking its work is refused until the pass settles. It is not queued.
- A live terminal takes a concurrency slot. Its spend is unmeasured (null).
- The hold gateway drops `human.ask`. "Ask"-policy tools keep raising approvals.
- Only the holder can Continue. Anyone allowed to take the task can Release.
- Release still resumes the captured session, but with the normal prompt.
- `#resumableRun` gains a profile check. This also fixes a silent fresh-start risk outside holds.
