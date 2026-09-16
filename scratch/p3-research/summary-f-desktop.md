# P3 Desktop Surfaces & Acceptance Harness — Research Report

## 1. `NewMission.tsx` — the create form

Path: `apps/desktop/src/renderer/src/screens/NewMission.tsx`

**State fields** (top of `NewMission()`): `goal`, `repositoryId`, `preset` (default `'feature-delivery'`), `workflowInputs`, `autonomy` (default `'balanced'`), `constraints`, `criteria`, `title`, `baseBranch`, `showMore`, `showStaffing`, `staffing`, `createdFor`, plus a `textarea` ref. Local UI state is plain `useState`; there is **no upload/file/link state yet**.

**Create mutation** — `create = useDaemonMutation((daemon, args) => daemon.createMission(args), ['missions'])`. The `submit()` function (guards `ready`, `workspace`, `create.isPending`) calls `create.mutate({...})` with: `workspaceId`, `repositoryId`, `goal` (trimmed), optional `title`, `constraints: splitLines(constraints)`, `successCriteria: splitLines(criteria)`, `autonomy`, `workflowPreset: preset`, `workflowInputs`, `baseBranch`, `planNow: true`, `behalfOf(actors, createdFor)`, and conditional `staffing` (only when non-empty). `onSuccess` navigates to `/missions/${detail.mission.id}`.

**`ready` gate**: `goal.trim().length >= 3 && Boolean(workspace) && missingInput === undefined`. This is the predicate an upload-control would extend if an upload becomes required to submit.

**Where an upload/file+link control goes**: The form body is a `.stack` of `<Field>` components (from `components/primitives.tsx`) inside `.page__inner--narrow`. The logical insertion point is immediately **after the "What outcome do you want?" hero textarea** (the `<Field>` containing the `.textarea--hero`), and **before the Repository/Workflow `.grid grid--2`**. An upload control would need a new `useState` holder, be included in `submit()`'s mutate payload (currently there is no `attachments`/`uploads`/`links` field sent to `createMission`), and likely feed into `ready` if uploads are mandatory. The `<Field>` + `components/primitives.tsx` (`Field`, `Segmented`, `ErrorState`) plus `components/Icon.tsx` and `PageHeader` actions are the existing building blocks.

The "More options" disclosure already hosts `title`/`constraints`/`criteria`/`baseBranch`; a P3 upload control could sit either as a top-level `Field` or inside that disclosure.

## 2. RequestChanges composer & its host

Files:
- `apps/desktop/src/renderer/src/components/RequestChanges.tsx`
- Host wiring in `apps/desktop/src/renderer/src/App.tsx`

Three exports: `RequestChangesButton`, `ComposerHost`, `RequestChangesComposer`.

**`RequestChangesButton`** (`{taskId, taskTitle, missionId, outputs, about, variant, className}`) renders a `<button>` that calls `openComposer({taskId, taskTitle, missionId, outputs, about})`. It is the single entry point used from `HandoffCard` (feed), `ArtifactReader` (reader, via `ReaderRequestChanges`), and `TaskDetail`.

**`ComposerHost`** is mounted **once** in `ProjectShell` (`App.tsx`), at the bottom of the shell alongside `Flash` and `ImpactHost`. It reads `useComposerRequest()` from `lib/notices.ts` and, when non-null, renders `RequestChangesComposer` with `key={request.taskId}` so a new task remounts it. The composer therefore outlives the card that opened it (the card moves between feed sections as the task runs).

**`RequestChangesComposer`** (`{taskId, taskTitle, missionId, outputs, about, onClose}`):
- State: `text` (draft backed by `draftFor`/`saveDraft`), `about`, `recordFor`.
- Mutation: `give = useDaemonMutation((daemon) => daemon.giveFeedback(taskId, { text: text.trim(), ...(about ? { artifactId: about } : {}), ...behalfOf(actors, recordFor) }), ['tasks','missions','approvals','artifacts'], missionId)`.
- `send()` guards `trimmed === '' || tooLong || give.isPending`; on success opens the impact dialog (`openImpact`) when `given.impact.dependents.length > 0`, else `showFlash`, clears the draft, closes.
- Body is a `<div className="composer">` with a `<label className="field">` textarea ("What should change?", `Cmd/Ctrl+Enter` sends), an optional "About" `<select>` (`showAbout` when `outputs.length > 1` or `preset` set), and `<ErrorState>` on error. Footer holds `<RecordingFor>`, Cancel, and the "Request changes" primary button.

**Where attachments would attach**: `giveFeedback` currently sends only `text` (+ `artifactId`, `behalfOf`). The daemon contract's `FeedbackAttachment` is a reserved stub — `packages/domain/src/entities/feedback.ts` defines `export type FeedbackAttachment = Readonly<Record<string, unknown>>` with the comment *"Reserved for P3 (uploads, hand-backs); always empty in P2"*, and `FeedbackItem.attachments: readonly FeedbackAttachment[]`. A P3 attachment control would be added inside `RequestChangesComposer`'s `.composer` div (next to the textarea/About select), extend the `giveFeedback` payload with an `attachments` array, and likely surface an attachment picker through the same shell-hosted composer so drafts survive card remounts.

`ComposerRequest` (`lib/notices.ts`) carries `{taskId, taskTitle, missionId, outputs: {id,label}[], about?}` — no attachment field yet; `openComposer`/`useComposerRequest`/`draftFor`/`saveDraft` are the shell-level state primitives.

## 3. HandoffCard & FeedPane — card structure & action buttons

Files:
- `apps/desktop/src/renderer/src/components/HandoffCard.tsx`
- `apps/desktop/src/renderer/src/screens/mission/FeedPane.tsx`

**`HandoffCard`** props: `{card: FeedCard, missionId, waitingFor?, objective?, actors, onFullDoc, onDoIt, onReplan?, replanning?}`. It renders an `<article className="feedcard" data-section={card.section} data-tone={tone} data-feed-card={card.key}>`. Structure, in order:

1. `.feedcard__head` — role name chip, `<h3 className="feedcard__title">`, status `<span className="badge badge--${tone}">`, round badge, over-budget badge, `.feedcard__time`.
2. `.feedcard__byline` — `<Attribution>` + `.feedcard__actions` span. **This is where action buttons live**: the handoff `links` buttons, `+N more docs`, "Full doc", and `RequestChangesButton`.
3. `.feedcard__headline` (optional).
4. `ChangedList` (`.feedcard__changed`).
5. `.feedcard__pending` (pending notes + `StartRoundButton`).
6. `.feedcard__points` list.
7. `.feedcard__needs` — only when `card.section === 'needs_you'`: shows `needs` line with "Re-plan" (`onReplan`) and/or "Claim and do it"/"Do it" (`onDoIt`) buttons, or `InlineDecision` (`<DecisionForm variant="inline">` via `useApprovalDecision`).

**Action-button host for P3**: `card.section === 'needs_you'` block and the `.feedcard__actions` span in the byline are the two candidate spots for "Continue elsewhere" / "Hand back" actions. The `needs` value is derived from `handoff?.needs ?? pendingApproval.approval.title ?? humanAction` text; `card.humanAction` is `'claim' | 'complete'` (the only two values referenced). There is currently **no** "Continue elsewhere"/"Hand back" button — P3 adds a new branch here, likely gated on `card.status === 'AWAITING_EXTERNAL'` or a new `humanAction`.

**`FeedPane`** owns the card list and callbacks. It computes `objectives` map from `detail.tasks`, and a `card()` renderer passing `onFullDoc={setReading}` (opens `ArtifactReader` in a wide `Drawer`), `onDoIt={(target) => setDoing(target.taskId)}` (opens `TaskDetail` drawer), `onReplan` (calls `replan.mutate` via `daemon.missionAction(missionId,'plan')`). `detail` comes from `MissionDetail`; `feed` from `useMissionFeed(missionId, showAllDone ? 'all' : DONE_SHOWN)` with `DONE_SHOWN = 5`. Sections: "Needs you" (`.feed__section#feed-needs-you`), "In progress", "Done" (with Show more/less). A P3 hand-back action would wire a new `onHandBack` prop through `FeedPane`'s `card()` renderer to a new mutation.

## 4. Link rendering (`kind: 'workspace'`)

Files:
- `apps/desktop/src/renderer/src/components/HandoffCard.tsx` (line ~116)
- `apps/desktop/src/renderer/src/screens/artifacts/ArtifactReader.tsx` (line ~89)

**Both filter identically** and ignore `kind` entirely:

```ts
const links = (handoff?.links ?? []).filter((link) => /^https?:\/\//i.test(link.url));
```

`HandoffCard` renders each as `<button className="btn btn--ghost feedcard__link" title={link.url} onClick={() => void window.tandemise.openExternal(link.url)}>{link.label} ↗</button>` inside `.feedcard__actions`. `ArtifactReader` renders the same list as `<button className="btn" ... onClick={() => void window.tandemise.openExternal(link.url)}>{link.label}<Icon name="externalLink"/></button>` inside `<div className="handoff__links">`.

**The `kind` field is defined but not rendered.** Domain: `packages/domain/src/entities/artifact.ts` — `HANDOFF_LINK_KINDS = ['workspace','preview','pr','doc','other']`, `type HandoffLinkKind`, and `ArtifactHandoff.links: readonly {label, url, kind}[]`. The comment *"Where a handoff link points, so a card can say 'open preview' rather than a bare URL"* shows `kind` was meant to change rendering but currently does not.

**P3 change point**: both `const links = …` lines (and the `.map` below each) are where `kind === 'workspace'` would branch to a different renderer/action — e.g. `window.tandemise.resolvePath(...)` / "Open workspace" instead of `openExternal`. Note the `httpUrl` zod constraint (`packages/artifacts/src/handoff.ts`) currently **rejects non-http(s) URLs**, and the UI's `/^https?:\/\//i` filter drops anything else — so a workspace link today would be both invalid at write time and hidden at render time. The scripted agent already emits `kind: 'workspace'` for a `preview`-mentioning objective (`scratch/acceptance/p0/scripted-agent.mjs`, `links: [{ label: 'Open preview', url: 'https://example.com/preview', kind: 'workspace' }]`), currently rendered as a plain external link.

## 5. `PlanPane.tsx` — plan tasks/rows

File: `apps/desktop/src/renderer/src/screens/mission/PlanPane.tsx`

`PlanPane({detail})` groups `detail.tasks` by `TaskView.level` via `groupByLevel` into `columns`, sorted by `orderHint`, and renders a DAG: `.dag` > `.dag__scroll` > `.dag__canvas` containing an `<svg className="dag__edges">` (dependency curves measured from `getBoundingClientRect`) and `.dag__col` columns (`.dag__colhead` shows `Stage {level+1}` + task count). Edges are computed in `measure()` from `cards.current` (a `Map<taskId, HTMLElement>` populated by `TaskCard`'s `register` ref callback).

**`TaskCard`** (`{task, actors, pendingApproval, selected, onSelect, register}`) renders `<button className="taskcard" data-status={task.status} data-selected={selected}>` with: `.taskcard__head` (status dot, `.taskcard__role`, `.badge badge--${tone}` with `taskBadge`/`humanBadge`), `.taskcard__title`, `.taskcard__ids` (`.dim` key), `<TaskPeople>`, `.taskcard__meta` (repository/runtime/target/attempt/elapsed), `.taskcard__checks` (check pills), `.taskcard__gate` (queued/gate/approval states), `.taskcard__note` (stale input / changes requested), and output-artifact count.

**Status tone** comes from `taskTone(task.status)`; the badge label from `taskBadge(task.status)` (`lib/format.ts`) or `humanBadge` for `AWAITING_HUMAN`. **A "covered by your upload" skipped row** would surface as a task with `status === 'SKIPPED'` — `taskBadge`/`taskTone` already handle `'SKIPPED'` (status label `'Skipped'`, and `HandoffCard.STATUS_LABELS.SKIPPED = 'Skipped'`). The natural P3 hook is either (a) a new `task.statusReason`/`gate`/`attention` branch rendered as an extra `.taskcard__note` or `.taskcard__gate` inside `TaskCard`, or (b) a distinct row style. `TaskView` already carries `statusReason`, `gate`, `attention` (`stale_input` | other), `needsAttention`, and `outputArtifacts` — the "covered by upload" message would likely be written into `statusReason` and rendered in a new conditional block in `TaskCard`, mirroring the existing `task.status === 'READY' && task.statusReason?.startsWith('Queued')` gate pattern.

Clicking a card sets `selected` and opens `TaskDetail` (`.taskcard` click → `onSelect` → drawer).

## 6. Acceptance harness (`scratch/acceptance/p0`)

Files: `run-all.mjs`, `setup.mjs`, `scripted-agent.mjs`, `lib/*.mjs`, `suite/*.mjs`.

**`run-all.mjs`** — orchestrator. Flags `--p1|--p2|--skip-claude|--keep-going|--only=c01`. It: kills prior run, makes a short symlink `/tmp/tdm-p0` → a fresh `tdm-p0-run-<ts>` dir (socket-path length limit), wipes `evidence/`, runs `setup.mjs <LINK>` with `SCRIPTED_DELAY_MS`, then spawns the **real** desktop: `npx electron-vite dev -- --remote-debugging-port=9333 --user-data-dir=…/electron --disable-backgrounding-occluded-windows …` with `TANDEMISE_HOME=…/home`. It then runs scenario files in order (a hardcoded list: P0 `s01…s08`, P1 `b01…`, P2 `c01…`), each via `node suite/<file>` with `ACCEPTANCE_SCRATCH=LINK`. Between scenarios with `daemonDelay` it stops/restarts the daemon. After each, it reads `evidence/*.json`; failure stops (unless `--keep-going`). Finally it writes `evidence/REPORT.md` (a Markdown table of `{id, title, ok, checks[]}` plus per-check observed values) and exits non-zero on any failure. **A P3 controller extends this by adding P3 scenario entries to the `scenarios` array (or a new `--p3` branch) and reusing the same `setup`/`LINK`/`evidence` plumbing.**

**`setup.mjs <scratch-dir>`** — builds a throwaway install: creates `home/` (TANDEMISE_HOME), a git project (`project/`) with `.tandemise/workflows/*.yaml` copied from `p0/workflows/`, commits it, starts the daemon from `apps/daemon/dist/main.js` with `SCRIPTED_DELAY_MS` and `SCRIPTED_PROMPT_DIR`, waits for `home/daemon.json` handshake, then via `api()` (Bearer-token HTTP against `info.url`) finds/creates the "Acceptance" workspace and the **"Scripted agent"** runtime profile (adapter `generic-cli`, command `process.execPath`, args `[scripted-agent.mjs]`, `promptVia:'stdin'`, `outputFormat:'text'`, `capabilities` incl. tool_calling/shell/git/filesystem/mcp). Writes `env.json` (`{scratch, home, project, url, token, pid, workspaceId, scriptedProfileId}`).

**`scripted-agent.mjs`** — deterministic stand-in model. Reads the compiled prompt on stdin, extracts `### <Type> → <destination>` output-contract lines, and writes one artifact per output satisfying that type's front-matter schema (`FRONT` map). Knobs (daemon env, or a variable name written into the mission goal): `SCRIPTED_DELAY_MS`, `SCRIPTED_LONG`, `SCRIPTED_STUBBORN`, `SCRIPTED_NO_HANDOFF_ONCE`, `SCRIPTED_SLOW_20S`, `SCRIPTED_OMIT_CITATION_ONCE`, `SCRIPTED_DECLINE`, `SCRIPTED_REVIEW_BLOCKING`, `SCRIPTED_FAIL_UNTIL_NOTE`. **Artifact writing** is the key extension point for a P3 controller: it emits YAML front matter (`yaml()` helper) with `{type, schemaVersion, title (≤60), handoff, …typeFront}` and a Markdown body. Handoff includes `headline`, `points`, optional `links` (`kind:'workspace'` when the objective mentions "preview"), and `changed` (round notes). A P3 "upload/hand-back" scenario would extend this agent (or add a sibling) to emit an upload/workspace link, or to *consume* an uploaded file — the prompt is the contract, and `SCRIPTED_PROMPT_DIR` already saves every prompt for inspection.

**Lib helpers** (`lib/`):

- **`cdp.mjs`** — `connect(port=9333)` finds the page target via `http://127.0.0.1:9333/json`, opens a WebSocket, and returns a `page` with `send`/`evaluate`/`navigate(hash)`/`text(selector)`/`waitForText(needle)`/`click(label,{within,nth})`/`fill(label,value)` (sets React-controlled inputs via the native value setter + `input`/`change` events, locating by label/placeholder/aria-label)/`select(label,optionText)`/`clickIn(rowText,prefix)`/`screenshot(path)`. `fill` and `select` use `Object.getOwnPropertyDescriptor(proto,'value').set.call(...)` + dispatched events — the exact mechanism a P3 file-input control must be driven through (file inputs need `DataTransfer`/`files` set, not the text value setter, so `fill` will need a sibling helper).
- **`api.mjs`** — `loadEnv`, `client(env)` (`get/post/patch/put/del/raw`), `sleep`, `until(fn,{timeoutMs,everyMs,label})`.
- **`ctx.mjs`** — `context()` builds `{env, api, page, ui, me, team, id, until, sleep, tasks, task, approvals, confirmIfAsked, createMission, decideInInbox, approvePlan, dialogText, flash, cardText, sendComposer, requestChangesOnCard, openTaskDrawer, missionAction, staff, feedback, events, prompts, sql, runs, close}`. **This is the shared assertion surface** — `createMission` drives the NewMission form (`fill('What outcome do you want?', …)`, `select('Repository', …)`, `select('Workflow', …)`, `click('Plan mission …')`), `sendComposer`/`requestChangesOnCard` drive the composer, `cardText(key)` reads a feed card by `data-feed-card`. A P3 controller adds helpers here (e.g. `attachFile`, `clickHandBack`), reusing `page.fill`/`page.click`/`until`.
- **`ui.mjs`** — `ui(page)` returns `buttons/clickLast/clickStarting/inbox/openItem/openTask/radio`, all `page.evaluate` DOM queries.
- **`evidence.mjs`** — `Evidence` class collects `checks[{label,ok,observed}]`, `notes`, `shots`; writes `<id>.json` under `evidence/`; `ok` = non-empty checks all pass.
- **`inspect.mjs`** — standalone: prints visible buttons/fields/options for a hash (and optional screenshot) — used to discover selectors.
- **`state.mjs`** — `readState`/`writeState` to `state.json` (scenarios hand mission ids between files, e.g. `s01` writes `a1`).

**Assertion pattern** (see `suite/s01-a1-solo.mjs`): each scenario does `const c = await context(); const ev = new Evidence('A1', …)`, drives the UI via `c.page`/`c.ui`/`c.createMission`, asserts DOM state with `c.page.text(...)` / `c.page.waitForText(...)` / `c.cardText(...)` against `ev.check(label, cond, observed)`, cross-checks ground truth through `c.api`/`c.sql`/`c.runs`, screenshots via `ev.shot(name)` (captured with `c.page.screenshot`), then `c.close(); ev.save()`. CDP `waitForText('Daemon connected')` gates the run.

**Key P3 extension points**: (1) `run-all.mjs` scenario list + `--p3` branch; (2) `scripted-agent.mjs` to emit/consume uploads and workspace links; (3) `ctx.mjs` helpers for attach/hand-back gestures and a `fill`-style helper for `<input type=file>` (via `DataTransfer`); (4) `setup.mjs` unchanged (it already provisions the Scripted-agent runtime with `filesystem` capability).
