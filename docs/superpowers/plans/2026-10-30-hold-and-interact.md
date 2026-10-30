# Hold and Interact Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A person can hold an agent task, work in the real Claude Code terminal inside Tandemise on the same session, then continue the autonomous run without losing context.

**Architecture:** A new HELD task status and a `task_holds` record. On Hold, the daemon stops the headless run so it ends RESUMABLE, then spawns the runtime's interactive invocation (`claude --resume …`) under a PTY owned by a new `@tandemise/terminal` package. The PTY streams over a WebSocket to an xterm.js panel. On Continue, the executor resumes the captured session headlessly on the pinned profile without spending an attempt, then runs the usual commit → harvest → checks → gate → score → judge pipeline.

**Tech Stack:** TypeScript, Node 22, better-sqlite3, `node-pty@1.1.0`, `ws`, React 18, `@xterm/xterm@6.0.0` + `@xterm/addon-fit@0.11.0`, Electron 44.

**Spec:** `docs/superpowers/specs/2026-10-30-hold-and-interact-design.md` (read it first; this plan argues from it).

## Global Constraints

- Layer rules hold (`npm run check:boundaries`):
  - application depends on a domain **port** (`InteractiveSessionsPort`), never on `node-pty`;
  - `@tandemise/terminal` is layer 4;
  - the renderer imports `@tandemise/*` as types only.
- Persist the transition before the side effect: `recorder.deferred(() => unitOfWork.transaction(...))`, then aborts, wakes and PTY actions after the commit.
- Migrations are append-only. Widen `mission_tasks.status` by editing `sqlite_master` in place exactly like `006_task_park_statuses.ts`, and never rebuild the table.
- Eval trial missions (`isTrialMission`) are never holdable.
- Unmeasured values are `null`, never 0. A terminal's token spend is unmeasured.
- UI copy: says "you", uses plain verbs, never shows raw enums or tool names. Colours come only from `palette.css`/`theme.css`, with no `var()` fallbacks; BEM classes; state in `data-*`.
- Refusals are `TandemiseError('CONFLICT', <sentence>)`, and the UI shows the daemon's own words.
- If `node-pty` fails to load, the daemon still starts and Hold is offered as unavailable with a reason.
- Repo artifacts are in English. PR titles are Conventional Commits with a lowercase subject. Run `npm run ci` before each PR.

## Review Focus

1. **Hold racing the run's own end.** The stream finishes in the same tick as the Hold. The task must end HELD with a RESUMABLE (or SUCCEEDED → refused) run, never CANCELLED or READY. Pinned by an engine test in Task 5.
2. **Continue after the terminal exited on its own** (`/exit`), or after a daemon restart. Continue must still resume `sessionAfter`, falling back to `sessionBefore` when no hook file was written. Pinned in Task 6.
3. **Two clients attached.** Both get the scrollback on attach, and one detaching doesn't end the PTY. Pinned in Task 4.
4. **A note left while held.** It rides with the continuation pass and isn't lost or delivered twice. Pinned in Task 5.
5. **Mission state while the only live task is held.** The mission stays EXECUTING, never BLOCKED. Pinned in Task 5.

---

### Task 1: Domain, the HELD status, holds, refusals and "Now"

**Files:**
- Modify: `packages/domain/src/entities/task.ts`. Add `'HELD'` to `TASK_STATUSES` after `AWAITING_APPROVAL`, to `ACTIVE_TASK_STATUSES` and to `PARKED_TASK_STATUSES`.
- Create: `packages/domain/src/entities/hold.ts`
- Modify: `packages/domain/src/event.ts`. Add the two events to the union and to the semantic list at :137.
- Modify: `packages/domain/src/capability.ts`. Add `'interactive_resume'` to `RUNTIME_CAPABILITIES`.
- Create: `packages/domain/src/ports/interactive-sessions.ts`
- Modify: the domain index exports.
- Test: `scratch/hold-check.mjs`, created here with its "pure" section, and added to `OFFLINE_CHECKS` in `scripts/run-checks.mjs`.

**Interfaces:**
- Produces:
  - `TaskHoldId` (branded id, prefix `hld`).
  - `TaskHold`:
    ```ts
    { id, taskId, missionId, heldBy: MemberId, fromStatus: TaskStatus,
      runtimeProfileId, sessionBefore: string|null, sessionAfter: string|null,
      ptyPid: number|null, startedAt, endedAt: Timestamp|null, endedBy: MemberId|null,
      ending: 'continued'|'released'|null, consumedAt: Timestamp|null,
      diffStat: { files: number; insertions: number; deletions: number } | null, dir: string }
    ```
  - `HOLDABLE_TASK_STATUSES = ['READY','RUNNING','AWAITING_INPUT','AWAITING_APPROVAL']`
  - `holdRefusal(input: { task; mission; trial: boolean; liveRun: boolean; outputUnderReview: boolean; runtimeHasInteractive: boolean; openHold: TaskHold|null; holderName: string|null }): string | null`
  - `describeHoldEnd(hold: TaskHold): string`
  - `nowLine(event: AgentEvent | null): string`
  - events:
    ```ts
    { type: 'task.held'; holdId; fromStatus; heldBy; sessionBefore }
    { type: 'task.hold_ended'; holdId; ending; endedBy; sessionAfter; durationMs; diffStat }
    ```
  - `InteractiveInvocation`: `{ file: string; args: string[]; env: Record<string,string>; cwd: string; sessionFile: string }`
  - `InteractiveSessionsPort`:
    ```ts
    { available(): { ok: true } | { ok: false; reason: string };
      open(holdId: TaskHoldId, inv: InteractiveInvocation): { pid: number };
      isOpen(holdId): boolean;
      end(holdId, graceMs?: number): Promise<void>;
      onExit(cb: (holdId, code: number|null) => void): () => void }
    ```
    The byte stream lives in the terminal package (Task 4), outside the port.

- [ ] **Step 1:** Write the pure section of `scratch/hold-check.mjs`, in the same shape as `scratch/replan-check.mjs`, with `check()` and `section()`. Its assertions:
  - `D.TASK_STATUSES.includes('HELD')`, `D.ACTIVE_TASK_STATUSES.includes('HELD')`, `D.isTaskParked('HELD')`.
  - `holdRefusal` returns exactly these strings:

    | Input | Refusal |
    |---|---|
    | SUCCEEDED task | `"This step is done; request changes instead."` |
    | non-agent executor | `"'<title>' is a person's step; there is no agent to hold."` |
    | trial | `"Eval trials can't be held."` |
    | RUNNING with `liveRun:false` (stream ended, still checking) | `"It's checking its work. You can hold it once that's done."` |
    | `runtimeHasInteractive:false` | `"Only Claude Code steps can be held for now."` |
    | open hold by Ana | `"Held by Ana since <HH:MM>."` |
    | AWAITING_APPROVAL with `outputUnderReview:false` (start approval) | `"Approve the start first, then you can hold it."` |
    | holdable cases | `null` |

  - `nowLine`:

    | Event | Line |
    |---|---|
    | `null` | `'Starting…'` |
    | tool event `Edit` on `src/app/page.tsx` | `'Editing src/app/page.tsx'` |
    | `Bash` `npm test` | `'Running npm test'` |
    | `Read` | `'Reading <path>'` |
    | assistant text longer than 80 chars | 79 chars + `'…'` |

    A raw tool name like `mcp__tandemise__x` never appears; it reads `'Using a Tandemise tool'`.

  - The new events are in the semantic list.
- [ ] **Step 2:** `npm run build && node scratch/hold-check.mjs`. Expected: FAIL, because `HELD` is missing.
- [ ] **Step 3:** Implement the status additions, `hold.ts` (types, `holdRefusal`, `describeHoldEnd`, `nowLine`), the events, the capability and the port. `nowLine` reads the canonical event fields used by `packages/runtime-claude/src/event-mapper.ts`; match its `tool_call` shape.
- [ ] **Step 4:** Rerun. Expected: the pure section passes. Run `npm run check:boundaries` and expect it to pass.
- [ ] **Step 5:** Commit: `feat: a held task status, hold record and refusals in the domain`.

### Task 2: Persistence, migration 022 and the hold repository

**Files:**
- Create: `packages/persistence/src/migrations/022_task_holds.ts`
- Modify: `packages/persistence/src/migrations/index.ts`
- Create: `packages/persistence/src/repositories/task-hold-repository.ts`. Follow the file pattern of the nearest repository, e.g. the plan-proposal repository from migration 021.
- Modify: the persistence tokens and module. Add `TASK_HOLD_REPOSITORY`, and make sure `aliasPorts` binds it by export name, adding it to `PERSISTENCE_PORT_TOKENS`.
- Modify: `packages/domain/src/ports/`. Add `TaskHoldRepositoryPort`.
- Test: the "persistence" section of `scratch/hold-check.mjs`.

**Interfaces:**
- Produces `TaskHoldRepositoryPort`, which is synchronous like the other repositories:
  ```ts
  { create(h: TaskHold): void; get(id): TaskHold|undefined; openFor(taskId): TaskHold|undefined;
    pendingContinuation(taskId): TaskHold|undefined; // ended, ending='continued', consumedAt null
    update(id, patch: Partial<TaskHold>): void; listByMission(missionId): TaskHold[] }
  ```
  - `openFor` returns the hold with `endedAt IS NULL`.
  - A partial unique index `ON task_holds(task_id) WHERE ended_at IS NULL` enforces one open hold per task.

- [ ] **Step 1:** Write the persistence section. It opens a fresh DB with `persistenceModule({ path })` and asserts four things:
  1. A task row can be written with status `HELD`, with no `SQLITE_CONSTRAINT_CHECK`.
  2. `sqlite_master` for `mission_tasks` contains `'HELD'`.
  3. A second open hold for the same task throws.
  4. `pendingContinuation` returns the ended `continued` hold, and returns nothing once `consumedAt` is set.
- [ ] **Step 2:** Run it and expect FAIL.
- [ ] **Step 3:** Write migration 022. In its `transform`:
  - Replace `` `'AWAITING_APPROVAL','BLOCKED'` `` with `` `'AWAITING_APPROVAL','HELD','BLOCKED'` `` in `mission_tasks`.
  - Use 006's unsafe-mode, `writable_schema`, post-condition assert and `schema_version` bump, verbatim in structure.
  - Then execute the `CREATE TABLE task_holds (...)` from the field list in Interfaces, with JSON text for `diff_stat`, foreign keys to `mission_tasks(id)` and `missions(id)` `ON DELETE CASCADE`, and the partial unique index.
- [ ] **Step 4:** Rerun and expect PASS.
- [ ] **Step 5:** Commit: `feat: store task holds and allow the held status`.

### Task 3: Runtime, interactive invocations for Claude and the fake runtime

**Files:**
- Modify: `packages/runtimes-core/src/adapter.ts`. Add optional `interactive?(sessionRef: string | null, request: RunRequest, opts: { sessionFile: string; initialPrompt: string | null }): InteractiveInvocation` to `AgentRuntimeAdapter`.
- Modify: `packages/runtimes-core/src/manager.ts`. Add `interactive(profile, sessionRef, request, opts)`. It throws `TandemiseError('CONFLICT', 'Only Claude Code steps can be held for now.')` when the adapter lacks the method.
- Modify: `packages/runtime-claude/src/cli-args.ts`. Add `buildInteractiveInvocation(request, sessionRef, opts)`, sharing a helper with `buildInvocation` so the flags can't drift apart.
- Modify: `packages/runtime-claude/src/adapter.ts`. Implement `interactive`, and add `'interactive_resume'` to its capabilities.
- Modify: `packages/runtime-generic/src/fake.ts`. Implement `interactive` and declare `interactive_resume`.
- Test: `scratch/hold-check.mjs`, "runtime" section.

**Interfaces:**
- Consumes: `InteractiveInvocation` (Task 1).
- Produces:
  - **Claude's invocation:**
    - Same flags as `buildInvocation`, except no `-p`, no `--output-format`, no `--verbose`.
    - `--resume <sessionRef>` when non-null; `initialPrompt` as the trailing positional when `sessionRef` is null.
    - Plus `--settings <json>`, whose `hooks.SessionStart` runs `node -e` with a script that reads the hook's stdin JSON and writes `session_id` to `opts.sessionFile`.
    - Env: the same `buildRuntimeEnv` result plus `TERM=xterm-256color`. Cwd: the worktree.
  - **The fake's invocation:** `process.execPath -e <script>`. The script:
    1. writes `fake-session-<n>` to `sessionFile`;
    2. prints `Fake session <ref|new>`;
    3. echoes each input line as `> <line>`;
    4. on the line `write <name>`, creates `<cwd>/<name>`;
    5. on `/exit`, exits 0.

- [ ] **Step 1:** Write the runtime section. It builds a `RunRequest` the way existing runtime checks do (see `scratch/runtime-check.mjs` for the shape). Assertions:
  - The Claude interactive args contain no `-p` and no `stream-json`.
  - They contain `--resume sess_1`, plus `--permission-mode`, `--mcp-config` and `--strict-mcp-config` with the same values `buildInvocation` produces for the same request.
  - `--settings` parses as JSON with a SessionStart hook that mentions the session file path.
  - The env carries `CLAUDE_CONFIG_DIR` when the profile sets `configDir`.
  - With a null `sessionRef`, the last arg is the initial prompt.
  - The fake's invocation is runnable: spawn it with `child_process.spawn` and plain pipes. Write `hello\nwrite a.txt\n/exit\n`. Expect stdout to contain `> hello`, `a.txt` to exist, and the session file to contain `fake-session-`.
- [ ] **Step 2:** Run it and expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run it and expect PASS. Also run `node scripts/run-checks.mjs runtime-check` to show the headless args didn't change.
- [ ] **Step 5:** Commit: `feat: interactive invocations for claude code and the fake runtime`.

### Task 4: The `@tandemise/terminal` package, a PTY host

**Files:**
- Create: `packages/terminal/{package.json,tsconfig.json,src/index.ts,src/pty-host.ts,src/scrollback.ts,src/module.ts}`. Copy the package skeleton of `packages/execution-local`, but don't use `scripts/scaffold.mjs`, which overwrites every package.json.
- Modify: `scripts/packages.mjs`, to add `terminal` at layer 4; `tsconfig.build.json` references; the root workspaces if they are listed.
- Dependency: `node-pty@1.1.0` (MIT). Confirm `npm run check:licenses` passes.
- Test: `scratch/terminal-check.mjs` (new), added to `OFFLINE_CHECKS`.

**Interfaces:**
- Consumes: `InteractiveSessionsPort`, `InteractiveInvocation` (Task 1).
- Produces:
  - `class PtyHost implements InteractiveSessionsPort`, plus:
    - `attach(holdId, sink: { data(chunk: Buffer): void; exit(code: number|null): void }): () => void`. On attach it first replays the scrollback.
    - `write(holdId, data: string | Buffer): void`
    - `resize(holdId, cols: number, rows: number): void`
  - `Scrollback`: a byte ring capped at 1 MiB.
  - `end(holdId, graceMs = 3000)`: writes `/exit\r`, waits, then SIGTERM, then after `graceMs` SIGKILL.
  - `available()`: loads `node-pty` lazily inside a try. If it fails, returns `{ ok:false, reason:"The terminal component didn't load on this machine (<error>)." }`.
  - `TERMINAL_HOST` token, plus `terminalModule` binding the domain token `INTERACTIVE_SESSIONS` to `PtyHost`.

- [ ] **Step 1:** Write `terminal-check.mjs`. It opens the fake invocation from Task 3 (or an inline `node -e` echo) under `PtyHost`, then asserts:
  - Data arrives at an attached sink.
  - A second sink attached after output receives the replayed scrollback first.
  - Detaching one sink keeps the PTY open (`isOpen === true`).
  - `write('write b.txt\r')` creates the file.
  - `resize(100, 30)` doesn't throw.
  - `end()` resolves and `onExit` fires with that hold id.
  - Scrollback never exceeds 1 MiB after writing 2 MiB.
- [ ] **Step 2:** Run it and expect FAIL.
- [ ] **Step 3:** Implement. Spawn with `name: 'xterm-256color'`, the invocation's `cwd`, `env`, `cols: 120`, `rows: 32`.
- [ ] **Step 4:** Run it and expect PASS. Then run `npm run check:boundaries && npm run check:licenses`.
- [ ] **Step 5:** Commit: `feat: a pty host for interactive agent sessions`.

### Task 5: Engine changes for stopping into a hold and continuing from one

**Files:**
- Create: `packages/application/src/support/held.ts`, holding `class TaskHeld extends Error` and `isTaskHeld(signal)`, mirroring `support/shutdown.ts`.
- Modify: `packages/application/src/engine/scheduler.ts`. Change `cancelTask(taskId, reason?: Error)` to abort with `reason`.
- Modify: `packages/application/src/engine/task-executor.ts`:
  - **Run status** (:802-807): `interrupted || resumeUntouched || isTaskHeld(signal)` → RESUMABLE/INTERRUPTED.
  - **`#stopped`** (:1584): if the task's current row is HELD, return `{ kind:'settled', status:'HELD', reason: current.statusReason }`, for both the interrupted and cancelled outcomes.
  - **Dispatch** (`#runRouted` / `#drive` input): when `holds.pendingContinuation(task.id)` exists:
    - pin routing to `hold.runtimeProfileId`;
    - `continueSession = hold.sessionAfter ?? hold.sessionBefore`;
    - spend no attempt;
    - use the prompt `CONTINUATION_PROMPT` for `ending:'continued'`, or the normal compiled prompt for `'released'`;
    - append queued notes the way `#deliverQueued` formats them;
    - set `consumedAt` once the run row is created.
  - **`#resumableRun`** (:2289): also require `run.runtimeProfileId === profile.id`.
- Modify: `packages/application/src/tools/ask-human.ts:115-120`. Write AWAITING_INPUT only when the current status is RUNNING.
- Modify: `packages/application/src/engine/recovery.ts`. HELD tasks are left untouched: no requeue and no cancel. An open hold whose `ptyPid` is dead gets `ptyPid = null`.
- Modify: `packages/application/src/support/feedback-rules.ts`. Add an explicit `HELD` case to `feedbackEffectFor`, which queues the note.
- Test: `scratch/hold-check.mjs`, "engine" section. Use an `engineHarness` copied from `replan-check.mjs`, adding `TASK_HOLD_REPOSITORY`, with the fake runtime's `resume: 'ok'`.

**Interfaces:**
- Consumes: `TaskHoldRepositoryPort` (Task 2).
- Produces:
  - `TaskHeld` and `isTaskHeld`.
  - `CONTINUATION_PROMPT`, exported from `task-executor.ts`. The text is exactly: `"A person held this task and worked with you directly in this session. Their changes are in the worktree. Continue the task from where things stand now and finish it."`
  - `scheduler.cancelTask(taskId: TaskId, reason?: Error): void`

- [ ] **Step 1:** Write the engine tests. Each sets state directly through the repositories, as `replan-check` does, so this task doesn't depend on Task 6:
  1. A RUNNING fake task.
     - Write HELD, then call `cancelTask(id, new TaskHeld())`.
     - The run ends `RESUMABLE` with its `externalSessionId`, and the task stays `HELD`, not READY or CANCELLED.
     - The mission stays `EXECUTING` across several `scheduler.tick()` calls (Review Focus 5).
  2. The stream ends in the same tick as the hold (Review Focus 1). Give the fake a 0 ms delay, abort right after `execute` resolves its first event. The task is HELD or the pass settled normally, never READY or CANCELLED.
  3. Pending continuation.
     - Create an ended `continued` hold with `sessionAfter:'s2'` on profile B, while profile A is also enabled, then set the task READY.
     - The next run resumes `s2` on profile B.
     - The task's `attempts` is unchanged, and the hold's `consumedAt` is set.
     - The run's prompt starts with `CONTINUATION_PROMPT`.
  4. A note added while HELD is `queued`. After the continuation it is delivered once: its status is `delivered`, and the prompt contains it exactly once (Review Focus 4).
  5. `#resumableRun` with a RESUMABLE run on profile A, routed to profile B, does not resume.
  6. `ask_human` while HELD leaves the status HELD.
  7. Recovery over a HELD task leaves it HELD.
- [ ] **Step 2:** Run and expect FAIL.
- [ ] **Step 3:** Implement the changes listed in Files.
- [ ] **Step 4:** Run and expect PASS. Also run the neighbours: `node scripts/run-checks.mjs replan-check p3-contributions-check concurrency-check`. Run p3 in CI or with `git config --global init.defaultBranch main` set locally.
- [ ] **Step 5:** Commit: `feat: the engine stops into a hold and continues from it`.

### Task 6: HoldService, the hold, continue and release flows

**Files:**
- Create: `packages/application/src/services/hold-service.ts`
- Modify: `packages/application/src/services.ts` and `module.ts`. Add `services.holds`, with deps resolved like `MissionService`'s plus `TASK_HOLD_REPOSITORY`, `INTERACTIVE_SESSIONS` (optional) and the MCP gateway factory.
- Modify: `packages/application/src/services/mission-service.ts`. Expose `#assertMayTake` to HoldService through a small shared helper in `support/`. Keep the signature; don't duplicate the rule.
- Test: `scratch/hold-check.mjs`, "service" section. Bind `INTERACTIVE_SESSIONS` to a recording fake: an in-memory class that records `open`/`end` calls and lets the test fire `onExit`.

**Interfaces:**
- Consumes: Tasks 1–5.
- Produces `HoldService`:
  - `hold(taskId, caller): Promise<TaskView>`
  - `continue(taskId, caller): Promise<TaskView>`
  - `release(taskId, caller): Promise<TaskView>`
  - `reopen(taskId, caller): Promise<TaskView>`: respawns the terminal for an open hold whose PTY has exited.
  - `terminalFor(taskId): TaskHoldId | null`
- Hold sequence (spec "Hold, in order"):
  1. **Refusal:** `holdRefusal(...)`.
  2. **Transaction:**
     - create the hold, with `dir = paths.missionDir(m)/holds/<holdId>`;
     - task → HELD, `statusReason = "Held by <name>."`;
     - withdraw any pending `choice` or output approval for the task. For an output under review, call `FeedbackRounds.beginRound` with the round reason `"Held by <name> to change it directly."`;
     - record `task.status` and `task.held`;
     - hold dependents like `parkTask` does.
  3. **After commit:** `scheduler.cancelTask(id, new TaskHeld())`. Wait up to 10 s for no live run row; poll 100 ms.
  4. **Provision:**
     - make sure the target exists, reusing the executor's `#provisionTarget` path through an exported helper;
     - create a gateway with the run's grants minus `human.ask`;
     - reserve one slot on the pinned profile, released in `end`;
     - `runtimeManager.interactive(...)`;
     - `sessions.open`;
     - store `ptyPid`.
  5. **On any failure after the commit:** keep HELD, and set `statusReason` to the daemon's sentence.
- Continue:
  - **Holder only.** Anyone else is refused with `"Only <holder> can continue this hold; you can release it."`.
  - **Read `sessionAfter`** from the hook file. If the file is missing, use the last value or `sessionBefore`.
  - **Compute `diffStat`** with `git diff --shortstat <headAtHoldStart>` in the worktree. Store `headAtHoldStart` in the hold `dir` as `head.txt` at hold time.
  - **Transaction:** end the hold (`continued`), task → READY, record `task.hold_ended`.
  - **After commit:** `sessions.end`, dispose the gateway, release the slot, `scheduler.wake()`.
- Release: same as Continue, with `ending:'released'`. Allowed for anyone `#assertMayTake` accepts.
- On `sessions.onExit` for an open hold: set `ptyPid = null` and invalidate `tasks`. The task stays HELD.

- [ ] **Step 1:** Write the service tests:
  - Hold on RUNNING: the order is HELD written → cancel → `open` called with an invocation whose `env`/`cwd` match the worktree. `task.held` is recorded.
  - Hold on AWAITING_INPUT: the `choice` approval is withdrawn and gone from `approvals?status=pending`.
  - Hold on AWAITING_APPROVAL (output): a new round begins, and the round count goes +1.
  - Hold on READY: the target is provisioned and `open` is called with `sessionRef null`.
  - Continue by a non-holder is refused with the exact sentence. By the holder, `end` is called, the task is READY, and `task.hold_ended` has `diffStat` (write a file in the worktree before continuing).
  - Release by another member who may take the task: `ending:'released'`.
  - The PTY exits on its own (fire `onExit`), then Continue works and uses the session-file value (Review Focus 2).
  - The gateway grants exclude `human.ask`.
  - A trial mission is refused.
- [ ] **Step 2:** Run and expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run and expect PASS.
- [ ] **Step 5:** Commit: `feat: hold, continue and release a task`.

### Task 7: Daemon, API and terminal socket

**Files:**
- Modify: `packages/api-contract/src/views.ts`. Add three fields to `TaskView`:
  - `now: string | null`, set only for live agent tasks;
  - `hold: { holdId; heldBy; heldByName; startedAt; terminalOpen: boolean } | null`;
  - `holdable: { ok: true } | { ok: false; reason: string }`.
- Modify: `packages/application/src/services/mission-service.ts` `#taskView`. Fill those fields from the latest run event (`nowLine`), the open hold and `holdRefusal`.
- Modify: `apps/daemon/src/routes.ts`. Add routes next to the park routes:
  - `POST /v1/tasks/:id/hold`
  - `POST /v1/tasks/:id/continue`
  - `POST /v1/tasks/:id/release`
  - `POST /v1/tasks/:id/terminal/reopen`
- Modify: `apps/daemon/src/http/server.ts`. Accept a second upgrade path, `/^\/v1\/tasks\/[^/]+\/terminal$/`, with the same token checks, and pass the path to `onUpgrade`.
- Create: `apps/daemon/src/http/terminal-socket.ts`. A `WebSocketServer({ noServer:true })`:
  - on connection, `holds.terminalFor(taskId)`, then `PtyHost.attach`;
  - binary messages go to `write`;
  - text JSON `{type:'resize',cols,rows}` goes to `resize`;
  - PTY exit sends `{type:'exit',code}` and closes the socket;
  - with no open hold, sends `{type:'error',message}` and closes.
- Modify: `apps/daemon/src/bootstrap.ts`. Compose `terminalModule` and alias `INTERACTIVE_SESSIONS`.
- Test: `scratch/hold-daemon-check.mjs` (new, added to `OFFLINE_CHECKS`). It starts the daemon from `dist` with a fresh `TANDEMISE_HOME` and `TANDEMISE_OFFLINE=1`, as `scratch/desktop-live-check.mjs` does, and registers a fake runtime profile.

- [ ] **Step 1:** Write `hold-daemon-check.mjs`:
  1. Create a mission whose task runs on the fake runtime with a long delay.
  2. `POST hold` returns a TaskView with `status:'HELD'` and `hold.terminalOpen:true`.
  3. Open `ws://…/v1/tasks/<id>/terminal?token=…` and receive `Fake session`.
  4. Send `write c.txt\r`; the file appears in the worktree.
  5. Close the socket, reconnect, and the scrollback repaints with `Fake session`.
  6. `POST continue` makes the task leave HELD and finally SUCCEEDED, with attempts unchanged.
  7. An upgrade without a token gets a 401.
  8. `holdable` for a SUCCEEDED task reads `"This step is done; request changes instead."`.
- [ ] **Step 2:** Run and expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run and expect PASS. Then run `npm run ci`.
- [ ] **Step 5:** Commit: `feat: hold api and terminal socket in the daemon`.

### Task 8: Desktop, the Hold button, terminal panel and "Now"

**Files:**
- Modify: `apps/desktop/package.json`. Add `@xterm/xterm@6.0.0` and `@xterm/addon-fit@0.11.0`.
- Modify: `apps/desktop/src/renderer/src/lib/daemon.ts`:
  - `holdTask(id)`, `continueTask(id)`, `releaseTask(id)`, `reopenTerminal(id)`;
  - `terminalUrl(id): string`, the base URL plus the token query, as the stream client builds it.
- Create: `apps/desktop/src/renderer/src/components/TerminalPanel.tsx` and `TerminalPanel.css`:
  - a full-height pane;
  - a header with the task title, "Held by You" and the buttons **Continue**, **Release** and **Close terminal**;
  - the xterm body, with fit on resize sending `{type:'resize'}`;
  - "ask"-policy approvals pending for the task shown as a banner;
  - when the PTY has exited, the body says "The session ended." and offers **Open the terminal again**.
- Modify: `apps/desktop/src/renderer/src/screens/mission/TaskDetail.tsx`:
  - a footer **Hold** button when `task.holdable.ok`;
  - otherwise the button is disabled, with `holdable.reason` as its title;
  - when `task.hold`, **Open terminal**, **Continue** and **Release**;
  - the `now` line under the title.
- Modify: `apps/desktop/src/renderer/src/components/HandoffCard.tsx`. Add **Hold** next to "Continue elsewhere" on in-progress cards.
- Modify: the Plan and Feed task cards (`PlanPane.tsx`, `FeedPane.tsx`). Show `task.now` for live tasks.
- Modify: `apps/desktop/src/renderer/src/styles/theme.css`. Add terminal roles (background, foreground, cursor, selection) through `light-dark()` over existing palette tokens, and map them into the xterm theme at runtime with `getComputedStyle`.

- [ ] **Step 1:** Write the real-app harness `scratch/acceptance/hold/run-all.mjs`. Reuse `scratch/acceptance/p0` `setup.mjs` and `lib/`, on its own `CDP_PORT=9341` and `ACCEPTANCE_LINK=/tmp/tdm-hold`. Write scenarios `suite/h01..h11.mjs`, one per spec acceptance item 1–11, using the fake runtime. Each asserts on the DOM text and on the API:
  - h01: Hold shows the panel with "Fake session".
  - h02: typing `write d.txt` + Enter puts the file in the worktree.
  - h03: Continue ends SUCCEEDED with attempts unchanged.
  - h04: close and reopen repaints.
  - h05: restart the daemon, and the task is still HELD and reopenable.
  - h06: the ask_human card leaves the Inbox.
  - h07: hold a READY task.
  - h08: the "Now" line changes.
  - h09: refusal text.
  - h10: holding an output under review opens a new round.
  - h11: two profiles, and the pinning holds.

  h03 also runs the real Claude Code when `claude` is on PATH and `--skip-claude` isn't passed, as A15 does.
- [ ] **Step 2:** Run `node scratch/acceptance/hold/run-all.mjs --keep-going`. Expected: FAIL, because there is no Hold button.
- [ ] **Step 3:** Implement the UI.
- [ ] **Step 4:** Rerun and expect ALL PASS. Run `npm run ci`. Save evidence to `docs/superpowers/evidence/2026-10-30-hold/` (REPORT.md and screenshots).
- [ ] **Step 5:** Commit: `feat: hold a task and work in its terminal from the app`.

### Task 9: Docs and closing out

**Files:**
- Modify: `README.md` and `docs/QUICKSTART.md`. Add a short "Hold and interact" paragraph.
- Modify: `CONTRIBUTING.md`. Mention that `@tandemise/terminal` needs `node-pty` build tools on Linux (g++, make, python3).
- Modify: the AGENTS.md repo shape, if a new package line is warranted.

- [ ] **Step 1:** Update the docs, then run `npm run ci`, which should pass.
- [ ] **Step 2:** Commit: `docs: hold and interact`. Open the PR titled `feat: hold a task and work with its agent in the terminal`, with a body that references #50 and the evidence. Move #50 on the board when it merges.
