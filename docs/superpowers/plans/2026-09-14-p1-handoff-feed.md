# P1: Handoff contract and mission feed — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every output in Tandemise reads in about 20 seconds. A validated handoff block (headline, ≤3 points, needs, changed, links) sits on every artifact. Per-type length budgets are enforced with one tighten pass. The reader shows the handoff and hides the front matter and appendix. Mission lists hide superseded versions, and missions open on a Feed of short cards.

**Architecture:**
- The handoff schema, the budgets and the word counting are pure functions in `@tandemise/artifacts`.
- Persistence stores `handoff`, `word_count` and `over_budget`.
- The engine records the headline as the summary and runs a tighten pass that doesn't count as an attempt.
- The desktop gains a Feed tab and rewrites the reader and list rows.

**Tech stack:** as P0. TypeScript ESM, zod, better-sqlite3, React 19. Checks are `scratch/*.mjs` node scripts run against `dist/`.

**Spec:** `docs/superpowers/specs/2026-09-14-p1-handoff-feed-design.md`. Read it first.

## Global Constraints

- Node 22; `npm run build`; CI = `npm run ci`, which must pass.
- Layering is enforced by `npm run check:boundaries`. `@tandemise/artifacts` may import only domain, shared and zod.
- Released migrations are immutable. Append `009` only.
- Title ≤ 60 chars.
- `handoff.headline`: required, ≤ 90 chars.
- `handoff.points`: 0–3 items, each ≤ 140 chars.
- `handoff.needs`: optional, ≤ 140 chars.
- `handoff.changed`: optional, ≤ 3 items, each `{what ≤ 140, feedback?}`.
- `handoff.links`: optional, ≤ 5 items, each `{label ≤ 40, url http(s), kind: workspace|preview|pr|doc|other, default other}`.
- Word budgets (main body before `## Appendix`):

  | Budget | Types |
  |---|---|
  | 300 | ReleaseCandidate, DecisionRecord, MissionPlan |
  | 400 | ProblemBrief, QAPlan, Evidence |
  | 500 | DesignBrief, ReviewReport, QAReport, ChangeSet |
  | 600 | ProductSpec, FinanceReport |
  | 800 | ArchitecturePlan, ImplementationPlan |

- The Appendix may be up to 2× the budget. Fenced code and tables are excluded from word counts.
- The tighten pass runs once per round, doesn't count against `maxAttempts`, and continues the session when the runtime has `session_resume` and the run has a session. It is never a failure.
- Artifacts authored by a person get a derived handoff (first sentence of their text, ≤ 90 chars on a word boundary, `points: []`) and are never budget-checked.
- Zero-config solo behaviour stays intact apart from the new UI. All P0 checks (`scratch/staffing-check.mjs`) keep passing.
- Desktop uses design-system tokens only (`npm run check:design`).
- Comments explain *why*, in full sentences.
- Commit messages follow Conventional Commits, with the trailer `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.

---

## File map

| File | Responsibility |
|---|---|
| `packages/artifacts/src/handoff.ts` (create) | handoff zod schema, `deriveHandoff(text)`, types |
| `packages/artifacts/src/budget.ts` (create) | `WORD_BUDGETS`, `measureBody(body) → {mainWords, appendixWords, codeLines}`, `budgetFor(type)`, `isOverBudget` |
| `packages/artifacts/src/schemas.ts` (modify) | handoff + title cap on every schema; minimal schemas for Evidence, MissionPlan, FinanceReport |
| `packages/artifacts/src/templates.ts` (modify) | handoff skeleton + budget line + fill rules |
| `packages/artifacts/src/parse.ts` (modify) | schemaless path removed for those three types |
| `packages/domain/src/entities/artifact.ts` (modify) | `ArtifactHandoff` type; `handoff`, `wordCount`, `overBudget` on the manifest |
| `packages/persistence/src/migrations/009_artifact_handoff.ts` (create) | columns + FTS |
| `packages/persistence/src/repositories/artifact-repository.ts` (modify) | map columns; FTS includes handoff text |
| `packages/application/src/engine/harvester.ts` (modify) | summary = headline; store handoff/measurements; report over-budget types |
| `packages/application/src/engine/task-executor.ts` (modify) | tighten pass |
| `packages/application/src/services/mission-service.ts` (modify) | derived handoff for person completions |
| `packages/application/src/services/planning-service.ts` (modify) | MissionPlan artifact gets a handoff |
| `packages/context/src/compiler.ts` (modify) | budget/tighten notes |
| `packages/domain/src/event.ts` (modify) | `artifact.over_budget`, `artifact.tighten_requested` |
| `packages/api-contract/src/views.ts` (modify) | handoff fields on artifact views; `MissionFeedView` |
| `packages/application/src/services/projection-service.ts` (modify) | `missionFeed(missionId, caller)` |
| `apps/daemon/src/routes.ts` (modify) | `GET /v1/missions/:id/feed` |
| `apps/desktop/src/renderer/src/screens/artifacts/ArtifactReader.tsx` (modify) | strip front matter, handoff header, collapsed appendix, details disclosure |
| `apps/desktop/src/renderer/src/screens/artifacts/ArtifactRows.tsx`, `screens/Artifacts.tsx`, `screens/mission/ArtifactsPane.tsx` (modify) | headline rows; superseded hidden + toggle |
| `apps/desktop/src/renderer/src/screens/mission/FeedPane.tsx` (create), `MissionDetail.tsx` (modify) | Feed tab (default) |
| `apps/desktop/src/renderer/src/components/HandoffCard.tsx` (create) | card used by the feed |
| `scratch/handoff-check.mjs` (create) | offline check |

---

### Task 1: Handoff schema, budgets, templates (pure)

**Files:**
- Create: `packages/artifacts/src/handoff.ts`, `packages/artifacts/src/budget.ts`
- Modify: `packages/artifacts/src/schemas.ts`, `templates.ts`, `parse.ts`, `index.ts`
- Modify: `packages/domain/src/entities/artifact.ts` (types only)
- Create: `scratch/handoff-check.mjs`
- Modify: `scripts/run-checks.mjs` (add `handoff-check`)

**Interfaces produced:**

```ts
// domain/entities/artifact.ts
export const HANDOFF_LINK_KINDS = ['workspace', 'preview', 'pr', 'doc', 'other'] as const;
export type HandoffLinkKind = (typeof HANDOFF_LINK_KINDS)[number];
export interface ArtifactHandoff {
  readonly headline: string;
  readonly points: readonly string[];
  readonly needs: string | null;
  readonly changed: readonly { readonly what: string; readonly feedback: string | null }[];
  readonly links: readonly { readonly label: string; readonly url: string; readonly kind: HandoffLinkKind }[];
}
// ArtifactManifest gains (optional, so existing builders compile):
//   handoff?: ArtifactHandoff | null; wordCount?: number | null; overBudget?: boolean;

// artifacts/handoff.ts
export const HANDOFF_LIMITS = { title: 60, headline: 90, point: 140, points: 3, needs: 140, changedWhat: 140, changed: 3, linkLabel: 40, links: 5 } as const;
export const handoffSchema: z.ZodType<ArtifactHandoff>;   // input accepts missing optionals; output normalised (needs null, arrays [])
export function deriveHandoff(text: string): ArtifactHandoff;  // first sentence, word-boundary cut at 90 with '…'

// artifacts/budget.ts
export const WORD_BUDGETS: Readonly<Record<ArtifactType, number>>;  // values from Global Constraints
export interface BodyMeasure { readonly mainWords: number; readonly appendixWords: number; readonly codeLines: number; readonly hasAppendix: boolean }
export function measureBody(markdown: string): BodyMeasure;
export function budgetFor(type: ArtifactType): number;
export function overBudget(type: ArtifactType, m: BodyMeasure): boolean;  // mainWords > budget || appendixWords > 2*budget
export function splitAppendix(markdown: string): { main: string; appendix: string | null };
```

**Requirements:**
- Every schema in `ARTIFACT_SCHEMAS` gains `handoff: handoffSchema` (required) and `title: z.string().trim().min(1).max(60)`.
- Evidence, MissionPlan and FinanceReport gain schemas with only `type`, `schemaVersion`, `title` and `handoff`. `hasSchema()` becomes true for all types.
- **Keep one exception:** binary Evidence written by agents (non-text media, via the blob path) is not parsed. Check how `parseArtifact` is called for Evidence blobs in the harvester, and keep that path untouched.
- **`measureBody`:**
  - Main body is the text before the first line matching `/^##\s+Appendix\b/i`.
  - Words are whitespace-separated tokens containing a letter or digit.
  - Fenced code blocks (``` or ~~~) and table lines (`|…|` rows and separator rows) are excluded from words; code and table lines are counted in `codeLines`.
  - Markdown heading markers and list bullets are not words.
- **Templates:** every template shows the handoff block right after `title`, with inline limit comments, for example `headline: <the outcome in one sentence, at most 90 characters>`, and the line `Main body: at most <b> words. Put supporting detail under "## Appendix" (up to <2b> words).` right after the closing fence. `HOW_TO_FILL` gains the three lines from spec §3.

**Check (`scratch/handoff-check.mjs`, section "pure"):** assertions for:
- every type accepting a valid handoff;
- a missing headline (issue path `handoff.headline`);
- a headline of 91 chars;
- 4 points;
- a point of 141 chars;
- an `ftp://` link;
- 6 links;
- a 61-char title;
- `needs` absent normalising to null;
- `deriveHandoff`: a multi-sentence input returns the first sentence; a 200-char single sentence is cut at a word boundary ≤ 90 with '…'; an empty or whitespace input gives the headline "(no text)";
- `measureBody`: a body with code fence + table + `## Appendix` gives exact counts;
- `overBudget` true/false at the edges (budget, budget+1, appendix 2b+1);
- every rendered template containing `handoff:`, `headline:` and `Main body: at most`;
- `WORD_BUDGETS` matching the table exactly for all 14 types.

- [ ] Step 1: write the failing check section
- [ ] Step 2: run `npm run build && node scratch/handoff-check.mjs` and see it fail
- [ ] Step 3: implement
- [ ] Step 4: re-run the check; run `node scripts/run-checks.mjs`. Existing checks that write artifacts without a handoff (artifact-lineage-check, feedback-loop-check, application fixtures, the P0 acceptance scripted agent) will now fail validation. **Update those fixtures to include a valid handoff.** `scratch/acceptance/p0/scripted-agent.mjs` is owned by the controller; do not touch it; it is updated in Task 6. List every fixture you changed.
- [ ] Step 5: commit `feat(artifacts): handoff contract, length budgets and templates`

### Task 2: Persistence, migration 009

**Files:**
- Create: `packages/persistence/src/migrations/009_artifact_handoff.ts`
- Modify: `migrations/index.ts`, `repositories/artifact-repository.ts`, domain repository port if needed

**Requirements:**
- `ALTER TABLE artifacts ADD COLUMN handoff TEXT` (JSON, null for legacy rows)
- `ADD COLUMN word_count INTEGER`
- `ADD COLUMN over_budget INTEGER NOT NULL DEFAULT 0`
- **FTS:** the artifacts FTS currently indexes title and summary. Also index handoff text (headline, points and needs, joined). Follow how `001_initial.ts` defines `artifacts_fts` and its triggers. Recreate the triggers so inserts and updates include a `handoff_text` column. If the FTS table can't take a new column, rebuild it: create a new FTS table, repopulate it from the artifacts, swap the triggers. Do this transactionally, following existing migration patterns.
- The repository maps `handoff` (`parseJson`), `wordCount` and `overBudget`.
- **Search:** it matches the handoff text too.

**Check (section "persistence"):**
- A database migrated to 8 and holding a P0-style artifact row migrates to 9: the row has handoff null, over_budget 0, and is still searchable by title.
- A round trip of an artifact with handoff, wordCount and overBudget.
- FTS finds an artifact by a word that only appears in `handoff.points`.
- `integrity_check` returns ok.

- [ ] Steps: failing section → implement → `node scratch/handoff-check.mjs && node scripts/run-checks.mjs` → commit `feat(persistence): artifact handoff, word count and over-budget (migration 009)`

### Task 3: Engine — headline summaries, tighten pass, person and plan handoffs

**Files:**
- Modify: `packages/application/src/engine/harvester.ts`, `engine/task-executor.ts`, `services/mission-service.ts`, `services/planning-service.ts`
- Modify: `packages/context/src/compiler.ts`, `packages/domain/src/event.ts`
- Modify: timeline copy in `apps/desktop/src/renderer/src/lib/events.ts`, for the two new events only

**Requirements:**
- **Harvester:**
  - For each parsed artifact, `summary = handoff.headline`, `handoff` stored, `wordCount = measure.mainWords`, `overBudget = overBudget(type, measure)`.
  - `HarvestResult` gains `overBudget: readonly { type; words; budget }[]`.
- **Executor tighten pass**, in `#judge` or right after harvest:
  - Applies when the verdict passed, `harvest.overBudget.length > 0`, and this round has had no tighten pass yet. Track this per task and round in memory, and persist it as an evidence note on the run, or as a flag in `retryFeedback` metadata, so a daemon restart doesn't cause a second tighten pass.
  - Record `artifact.tighten_requested {types}`, then run the task again:
    - with feedback `Tighten <Type>: the main body is <n> words; the budget is <b>. Keep the handoff, move detail under "## Appendix", and cut repetition.` (one line per type);
    - **without** incrementing the counted attempts. If `attempts` is used for the run's attempt number, the tighten run may use the next number, but `maxAttempts` gating must ignore tighten runs;
    - resuming the previous run's session when the runtime has `session_resume` and the run recorded an external session id. Reuse the existing resume machinery used by recovery; if resuming isn't possible, run fresh with the feedback.
  - **After the tighten run:**
    - If it produced valid artifacts, they supersede the first ones through lineage (`supersededBy`). Artifacts still over budget get `overBudget: true` and `artifact.over_budget {type, words, budget}` is recorded.
    - If it failed (runtime error or malformed artifact), keep the first round's artifacts, mark them `overBudget`, add a timeline note, and continue with the review pipeline as a normal passed round.
  - **Only then** the P0 review pipeline runs (`reviews.onRoundPassed`). Reviews must see the final artifacts.
- **Person completion** (`completeTask`): the artifact gets `handoff: deriveHandoff(result)`, `summary` = the headline, `wordCount` = measured, `overBudget: false`.
- **The MissionPlan artifact** (planning-service) gets a handoff:
  - `headline` = the plan's one-line summary, cut to 90 chars;
  - `points` = up to 3 of: `"<n> tasks: <shape>"`, the first gate or approval summary, `"Needs your approval to start"` when plan approval is `ask`;
  - `needs` = `"Approve the plan to start"` when awaiting approval.
- **Compiler notes:** add to the output contract `Main body: at most <b> words for <Type>; detail goes under "## Appendix".` for each output. `renderArtifactTemplate` already carries the handoff skeleton.

**Check (section "engine")**, using the generic fake runtime as `feedback-loop-check.mjs` does, with a `FakeScript` whose write-file content switches on whether the prompt contains "Tighten":
- (a) a first draft within budget: no tighten, summary = headline;
- (b) a first draft over budget and a short second draft: exactly one `artifact.tighten_requested`, the final artifact not over budget, `task.attempts` unchanged versus case (a), the first artifact superseded;
- (c) always over budget: one tighten pass, the artifact accepted with `overBudget: true` and `artifact.over_budget` recorded, the task SUCCEEDED (or AWAITING_APPROVAL when reviews apply);
- (d) a missing handoff: the retry feedback names `handoff.headline`;
- (e) person completion: derived headline, `overBudget` false;
- (f) the MissionPlan artifact has a handoff with a needs line while awaiting approval;
- (g) the tighten pass runs before reviews: with a blocking review staffed, the approval evidence references the tightened artifact id.

- [ ] Steps: failing section → implement → full offline suite → commit `feat(engine): headline summaries, one tighten pass per round, handoffs for people and plans`

### Task 4: API — artifact views and mission feed projection

**Files:**
- Modify: `packages/api-contract/src/views.ts`, `packages/application/src/services/projection-service.ts`, `services.ts`, `apps/daemon/src/routes.ts`, `apps/desktop/src/renderer/src/lib/daemon.ts`

**Interfaces produced:**

```ts
export interface FeedCard {
  readonly taskId: string | null;              // null for the plan card
  readonly key: string;                        // task key or 'plan'
  readonly title: string;
  readonly roleName: string | null;
  readonly status: TaskStatus | 'PLAN';
  readonly statusReason: string | null;
  readonly section: 'needs_you' | 'in_progress' | 'done';
  readonly doneBy: ActorRef | null;
  readonly responsible: ActorRef | null;
  readonly recordedBy: ActorRef | null;        // only when it differs from doneBy
  readonly artifactId: string | null;          // the primary live artifact
  readonly artifactTitle: string | null;
  readonly handoff: ArtifactHandoff | null;    // falls back to {headline: summary, ...empty} for legacy rows
  readonly moreArtifacts: number;
  readonly overBudget: boolean;
  readonly pendingApproval: ApprovalView | null;   // only when addressed to the caller (needs_you)
  readonly humanAction: 'complete' | 'claim' | null; // for AWAITING_HUMAN tasks for the caller
  readonly updatedAt: string;
}
export interface MissionFeedView { readonly missionId: string; readonly needsYou: readonly FeedCard[]; readonly inProgress: readonly FeedCard[]; readonly done: readonly FeedCard[]; readonly doneTotal: number }
```

`ArtifactManifest` views (list and read) already carry `handoff`, `wordCount` and `overBudget` from Task 2. `GET /v1/missions/:id/artifacts` gains `?includeSuperseded=true`; the default hides superseded artifacts. The global search already hides them (P0 empty query).

**Requirements:**
- **`missionFeed(missionId, caller, { doneLimit = 5 })`:**
  - Load the team once, the tasks, the live artifacts, and the pending approvals.
  - The "for me" predicate reuses P0's inbox projection logic (import or extract it; don't duplicate it).
  - Done cards sort by `finishedAt` descending, then are cut to `doneLimit`, with `doneTotal` holding the full count.
  - The plan card appears in `needs_you` while the plan approval is pending for me, and otherwise at the end of done.
- **Route:** `GET /v1/missions/:id/feed?doneLimit=`.

**Check (section "feed", HTTP):** a seeded mission where:
- the plan approval is pending → in needs_you;
- after approval a task with a pending review for me → needs_you with pendingApproval;
- a task waiting on Ana → in_progress;
- finished tasks → done in the right order with handoff headlines;
- `doneLimit` respected;
- the artifacts list hides superseded by default and shows them with the flag.

- [ ] Steps: failing section → implement → offline suite → commit `feat(api): mission feed projection and superseded-aware artifact lists`

### Task 5: Desktop — reader and lists

**Files:**
- Modify: `ArtifactReader.tsx`, `ArtifactRows.tsx`, `screens/Artifacts.tsx`, `screens/mission/ArtifactsPane.tsx`
- Modify: `screens/approvals/ApprovalCard.tsx` (evidence headline), `screens/Inbox.tsx` and `screens/Home.tsx` (headline under the title when present)

**Requirements** (spec §4.2–4.4):
- **Front matter:** strip a leading `---\n…\n---` block before rendering Markdown. Handle `\r\n`. Never strip a later `---` rule.
- **Reader header:** title → attribution chip → headline (large) → points → needs (highlighted) → links as buttons (open externally through the existing link opener).
- **Body:** main body, then a collapsed `<details>` "Appendix (N words)" when present.
- **Meta:** type chip, date, version `vN` (counted along supersedes), "Over budget" chip when true. Id, size and sha go behind a "Details" disclosure.
- **Lists:** rows show icon · title · headline (one line, ellipsis) · by · time. Superseded rows are hidden by default. A "Show older versions" toggle shows them indented under the successor, with a `vN` label.
- Legacy artifacts without a handoff use the summary as the headline, with no points.
- Tokens only. Verify visually with the harness (`/tmp/tdm-p1a`, CDP 9337) after Task 6 of this plan updates the scripted agent. Until then, seed artifacts with handoffs through `POST` of a mission using the generic fake runtime profile, or write fixture artifacts directly through the daemon API if one exists. Screenshots go to `.superpowers/sdd/<plan>/task-5-shots/`.

**Check:** desktop typecheck and check:design. Add a unit-like assertion to `handoff-check` for the front-matter stripping helper: put it in `@tandemise/artifacts` as `stripFrontMatter(md)` so it can be tested, and have the renderer import it through the existing domain/artifacts renderer allowlist mechanism, or duplicate a tiny pure copy under `lib/`. If you choose the copy, justify it in the report.

- [ ] Steps: implement → typecheck/design → screenshots → commit `feat(desktop): readable artifact reader and version-aware lists`

### Task 6: Desktop — Feed tab and cards; scripted agent handoffs

**Files:**
- Create: `screens/mission/FeedPane.tsx`, `components/HandoffCard.tsx`
- Modify: `MissionDetail.tsx` (Feed first and default: `#/missions/:id` opens Feed, `#/missions/:id/plan` still works)
- Modify: `scratch/acceptance/p0/scripted-agent.mjs`. **This is explicitly handed to this task by the controller.** Add a valid handoff to every artifact it writes, and two modes controlled by env or prompt:
  - `SCRIPTED_LONG=1`: the first draft's main body is 1.5× the type's budget; when the prompt contains "Tighten", write a short body;
  - `SCRIPTED_STUBBORN=1`: always over budget.
  - `SCRIPTED_NO_HANDOFF_ONCE=1`: omit the handoff on the first attempt only, detected by the absence of "handoff.headline" in the prompt's retry feedback.
  - Links: when the task objective contains "preview", add `links: [{label: 'Open preview', url: 'https://example.com/preview', kind: 'workspace'}]`.

**Requirements** (spec §4.1):
- Sections: Needs you / In progress / Done (latest 5 + "Show N more").
- The card layout is exactly as in the spec, ≤ 8 visible lines, and never shows ids or YAML.
- Inline decisions on needs_you cards reuse the Inbox decide flow and component logic (extract a shared hook; no duplication), including "Recording for" and the risky-decision confirmation.
- For a human action, show a "Do it" button that opens the existing task drawer.
- "Full doc" opens the reader in a drawer.
- Links as "label ↗".
- Waiting cards show their status reason instead of a headline.
- Empty state links to the Plan.
- Live updates: invalidate on the same stream topics as the mission detail.

**Check:** desktop typecheck and check:design. Visually verify with the harness: `node scratch/acceptance/p0/setup.mjs /tmp/tdm-p1b`, run a p0 workflow mission, screenshot Feed (needs you, in progress, done), a card, the full doc drawer, and a long-mode tighten run's timeline. Read every PNG.

- [ ] Steps: implement → typecheck/design → harness screenshots → commit `feat(desktop): mission feed of short handoff cards`

### Task 7: Real-app acceptance B1–B12 (controller)

The controller runs this in the main session. It extends the suite in `scratch/acceptance/p1/` using the P0 libraries, runs all P0 scenarios plus B1–B12 on a fresh install in one uninterrupted run, fixes findings through dispatched fixes, and commits evidence to `docs/superpowers/evidence/2026-09-14-p1/`.

---

## Self-review

- **Spec coverage:**
  - §1 contract: T1, T2, T3
  - §2 budgets and tighten: T1, T3
  - §3 templates: T1, T3
  - §4.1 feed: T4, T6
  - §4.2 reader: T5
  - §4.3 lists: T4, T5
  - §4.4 elsewhere: T5
  - §5 errors: T1, T3, T5
  - §6 testing: T1–T7
- **Names used consistently:** `ArtifactHandoff`, `handoffSchema`, `deriveHandoff`, `WORD_BUDGETS`, `measureBody`, `overBudget`, `splitAppendix`, `FeedCard`, `MissionFeedView`, `missionFeed`.
