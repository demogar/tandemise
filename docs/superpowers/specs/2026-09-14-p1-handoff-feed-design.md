# P1: Handoff contract and mission feed

Status: design, 2026-09-14. Parent: [collaboration roadmap](2026-09-13-collaboration-roadmap.md). Builds on P0 (`feat/p0-members-responsibility`).

## Problem (measured on real data)

- A real mission produced 31 artifacts totalling about 300 KB of text. A design brief averages 35 KB.
- The "summary" shown everywhere is the first paragraph cut to 300 characters, sometimes a table row.
- Titles are sentences.
- The reader shows the YAML front matter as garbled text (seen in the P0 acceptance screenshots: `type: "ReleaseCandidate" schemaVersion: 1 title: …`).
- Superseded versions stay in lists.
- The mission opens on a DAG, not on "what do you need from me, and what did I get".

## Goal

A person understands any output in about 20 seconds: a headline, up to three points, what is needed from them, what changed, and where the real thing lives. The full document is one click away and is itself short.

## Not in P1

- Giving feedback and starting a new round → P2. P1 cards reuse today's decisions (approve, reject, check).
- `handoff.changed` is accepted and shown, but it is only required from round 2 onward, which P2 introduces.
- Hand-backs, uploads and snapshots → P3. P1 stores and shows `links`, including `kind: workspace`.

## 1. The handoff contract

Every artifact's front matter carries a `handoff` block. It is validated by the artifact's zod schema in `packages/artifacts/src/schemas.ts`.

```yaml
title: Integrations redesign            # ≤ 60 chars
handoff:
  headline: Grouped rows, AAA buttons, Pro badge on locked sources   # required, ≤ 90 chars, one sentence
  points:                                # 0–3 items, each ≤ 140 chars
    - Built in Open Design on the Beveloce system
  needs: Approve to start the build      # optional, ≤ 140 chars; only when a person must act
  changed:                               # optional in P1 (required from round 2 in P2), ≤ 3 items
    - what: CTA buttons now use brand-600
      feedback: fb_…                     # optional in P1
  links:                                 # optional, ≤ 5
    - label: Open preview                # ≤ 40 chars
      url: http://od.example.test/…      # must be http(s)
      kind: workspace | preview | pr | doc | other   # default other
```

### Rules

- The handoff is required for **every** artifact type an agent writes. That includes Evidence, MissionPlan and FinanceReport, which today have no schema: they get a minimal schema whose only required fields are `type`, `title` and `handoff`.
- The title is capped at 60 characters for every type. It is a short name, not a sentence.
- **Artifacts written by a person** (human task completion, in `MissionService.completeTask`) get a derived handoff: `headline` is the first sentence of their text, cut at 90 characters on a word boundary; `points` is `[]`. People are not made to fill in YAML.
- The **manifest summary** becomes `handoff.headline`. The harvester stops cutting the first paragraph.
- A missing or invalid handoff is a malformed artifact. It takes the existing path: the file isn't stored and the issues go into the retry prompt.

### Storage

Migration 009 adds three columns to `artifacts`:
- `handoff` (JSON, nullable for legacy rows)
- `word_count` (integer)
- `over_budget` (integer 0/1)

`ArtifactManifest` gains `handoff`, `wordCount` and `overBudget`. Legacy artifacts, which have no handoff, display their existing summary as the headline.

## 2. Length budgets

Each type has a word budget for the **main body**, meaning everything before a `## Appendix` heading.

| Type | Main body budget (words) |
|---|---|
| ReleaseCandidate, DecisionRecord, MissionPlan | 300 |
| ProblemBrief, QAPlan, Evidence | 400 |
| DesignBrief, ReviewReport, QAReport, ChangeSet | 500 |
| ProductSpec, FinanceReport | 600 |
| ArchitecturePlan, ImplementationPlan | 800 |

- `## Appendix`, when present, may be up to 2× the budget. The UI keeps it collapsed. Downstream agents receive the whole document, as today.
- Word count ignores fenced code blocks and tables. Those are counted by lines toward a separate soft cap of 120 lines, reported but not enforced.
- **Over budget:** the round is not failed. The executor runs **one tighten pass** within the same round.
  - The pass does not count against `maxAttempts`, and it runs once per round.
  - When the runtime supports `session_resume` and the run has a session, the pass continues that session. Otherwise it runs a fresh attempt.
  - The pass's feedback is: `Tighten <Type>: the main body is <n> words; the budget is <b>. Keep the handoff, move detail under "## Appendix", and cut repetition.`
  - If the result is still over budget, it is accepted with `overBudget = true`. The timeline records `artifact.over_budget {type, words, budget}`.
  - Length never blocks a mission.
- Artifacts written by a person are never measured against a budget.

## 3. Templates and instructions

`renderArtifactTemplate` adds to every template:
- the handoff skeleton, placed right after `title`, showing each field with its limit;
- the type's budget, as a line under the fences: `Main body: at most <b> words. Put supporting detail under "## Appendix".`

`HOW_TO_FILL` gains:
- "The handoff is what a busy owner reads first, often the only thing they read. Write the headline as the outcome, not the activity."
- "Put `needs` only when a person must act, and say what they must do."
- "Put a link for every real thing that lives elsewhere (preview, pull request, design file)."

The context compiler's output-contract notes repeat the budget and the tighten rule, one line each.

## 4. What a person sees

### 4.1 Mission feed: the new default tab

`MissionDetail` tabs become **Feed** · Plan · Timeline · Artifacts · Checks · Metrics, and the mission opens on Feed. The feed has one card per task that has started, plus the plan approval. It is grouped into sections:

1. **Needs you**: tasks with a pending approval, question or check addressed to me, and AWAITING_HUMAN tasks assigned to or claimable by me. The predicate is P0's inbox "for me".
2. **In progress**: running, waiting on others, or waiting on a runtime.
3. **Done**: newest first. Only the latest 5 are shown; the rest sit behind "Show N more".

A **card** has at most:
- one header line: role · task title · status chip · time;
- one line: "by X · responsible Y" (P0 `ActorChip`), with "recorded by" only when it differs;
- the headline of the task's latest live artifact. With several outputs, the first expected output's headline, plus "+N more";
- up to 3 points;
- the **needs** line, highlighted, with the decision buttons inline when a card for me is pending (the same decide call as the Inbox card);
- links as small buttons ("Open preview ↗");
- a "Full doc" button that opens the reader drawer.

Cards never show raw ids, YAML, tables or more than about 8 lines. Waiting cards show their status reason instead of a headline.

An empty feed ("Nothing has run yet") links to the Plan.

### 4.2 Artifact reader

- **Strip front matter.** The body is rendered without the `---` block.
- **Top:** title, then the "by / responsible" chip, then the headline in large type, points as a list, needs highlighted, and links as buttons.
- **Body:** main body as Markdown. `## Appendix` and everything after it sits in a collapsed "Appendix (N words)" section.
- **Meta row:** type chip, date, version (v1, v2… following the supersedes chain). An "over budget" chip appears only when true. The artifact id, size and sha move behind a "Details" disclosure.

### 4.3 Artifacts lists (mission tab and global screen)

- **Rows:** type icon · title · headline (one line) · by · time.
- **Superseded versions are hidden by default.** A "Show older versions" toggle reveals them, indented under their successor.
- **Global search** keeps the empty-query listing from P0 and searches headline and points too (FTS: add handoff text to the FTS index in migration 009).

### 4.4 Elsewhere

- **Approval card evidence:** artifact rows show title and headline (P0 already shows the title).
- **Inbox and Home rows** for an approval show the artifact headline under the title when there is one.

## 5. Error handling

- An invalid handoff (length, a URL that isn't http(s), more than 3 points) returns path-specific issues to the retry prompt, e.g. `handoff.points: at most 3 points (got 5)`.
- A tighten pass that fails (runtime error, or a malformed artifact): the previous round's valid artifact is kept, marked over budget, and a timeline note is recorded. The task does not fail because of the tighten pass.
- Legacy artifacts without a handoff: the reader and feed fall back to the stored summary. No backfill is needed.

## 6. Testing

### Offline

A new `scratch/handoff-check.mjs`, added to OFFLINE_CHECKS, covers:
- the schema, per type, with a valid handoff and every invalid case;
- title length;
- a derived handoff for person text: first sentence, a 90-character word boundary;
- word counting (code and tables excluded, Appendix split);
- the budget table;
- the tighten pass: an over-budget scripted fake run leads to exactly one tighten attempt, not counted against attempts. A short result is accepted with `overBudget` false; a still-long result is accepted with `overBudget` true plus the event;
- manifest summary = headline;
- migration 009 over a P0 database;
- FTS finding a point;
- the template containing the handoff skeleton and budget line.

All existing checks keep passing.

### Real app

Proven in the real app; the harness is extended as `scratch/acceptance/p1`, reusing the P0 libraries. The scripted agent gains handoffs and a "long first draft" mode: it writes a body over budget on the first pass, then a short one when the prompt contains "Tighten".

| # | Scenario | Must observe in the window |
|---|---|---|
| B1 | Solo mission, zero config | The mission opens on Feed. Every finished card shows a headline, ≤ 3 points, "by … · responsible You", and no YAML or ids |
| B2 | Needs you | The plan approval and a spec review appear under "Needs you" with the needs line and inline Approve. Approving from the card moves it to Done |
| B3 | Full doc | "Full doc" opens the reader: no front matter, headline and points on top, Appendix collapsed with a word count |
| B4 | Tighten | A long first draft leads to one tighten pass in the timeline, then a short artifact, not over budget. The attempts counter is unchanged |
| B5 | Still too long | The agent ignores tightening, so the artifact is accepted with an "over budget" chip and the mission continues |
| B6 | Missing handoff | The agent omits the handoff, so the retry prompt names `handoff.headline` and the next attempt succeeds |
| B7 | Superseded hidden | A retried task shows one row; "Show older versions" shows v1 under v2 |
| B8 | Person's output | A human docs step shows the derived headline from the person's text on its card |
| B9 | Links | A workspace link renders as "Open … ↗" on the card and in the reader |
| B10 | Team context | A team mission's feed shows "Needs you" only for items addressed to me; Ana's pending review appears under In progress as "Waiting for Ana Ruiz" |
| B11 | Real Claude | A design task on Claude Code produces a valid handoff within budget, or passes the tighten pass, and the card reads as a 20-second summary (screenshot reviewed) |
| B12 | Readability audit | For each finished card in B1: at most 8 visible lines, and headline plus points ≤ 510 characters (the contract maximum: a 90-character headline plus three 140-character points). Asserted from the DOM |
