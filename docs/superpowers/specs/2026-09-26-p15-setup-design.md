# P15: Your setup as code, and gates that can pass

Status: design, 2026-09-26. Builds on P7 (WIP limit), P8 (limits), P11 (routines) and P12 (role models, `review.independent`). Base: `main` after P12. No migration.

## Problem

Two separate problems, one slice.

**Setup lives in one database on one machine.** Roles, their models, the WIP limit, the project's limits and the routines are rows in `~/.tandemise/tandemise.db`. A new laptop, a second checkout, or a friend who wants the same setup means clicking all of it in again, from memory. Workflows already live in the repository (`.tandemise/workflows/*.yaml`), but nothing else does, and even those were not committable in practice: planning, refinement and every in-place step write `.tandemise/.gitignore` containing `*` and add `.tandemise/` to `.git/info/exclude`, so git ignores every new file under `.tandemise/`.

**Some gates can never pass, and nothing says so when they are written.** A gate is checked only after a step has run. A gate that reads a fact the daemon never measures inside a step fails as "not measured" on every attempt, and the person finds out an hour later on an intervention card. Measured on `main`:

- `security.required_checks` and `git.clean` are in the vocabulary and in the docs, but no code supplies them.
- `checks.<name>` promises "any additional repository check", but a repository can only configure install, typecheck, lint, test and build.
- Eleven facts (`mission.stalled`, `mission.agent_minutes`, `workspace.active_missions`, `ready.*`, …) are published for the whole mission or project by the readiness, backlog, limit and liveness services. None is measured when a step's gate is read.
- A misspelling (`checks.test`) is accepted, and `checks.test != FAIL` then passes forever because an unmeasured fact is never equal to FAIL.
- PR #14 fixed the presets so each gate names its own output, but a workflow file or a planner can still write a gate on a step with outputs that never checks that the step wrote anything (the shipped `docs/examples/build-feature.yaml` does exactly that on `build`).

## Goal

**Setup as code.** In Project settings I press **Export**, choose one of the project's repositories, and Tandemise writes my setup into `.tandemise/` there: `tandemise.yaml`, `roles/<id>.md`, `workflows/*.yaml`, `routines.yaml`. The files are the same bytes every time I export the same setup, contain no secrets and no timestamps, and are committable. On another machine (or after editing the files) I press **Import**, pick the folder, and see a preview: each item is Add, Change, Remove or Same, and for each I choose **Keep mine** or **Take theirs**. Nothing changes until I press **Apply**, and Apply changes everything or nothing. Imported routines arrive **off**, marked "Imported — review and turn on": an import never starts work.

**Honest gates.** One validator reads every gate the moment it is written: in a workflow file (when it is loaded), in a planner's plan, when a plan is materialized, and in an import. It rejects, with a reason a person can act on:

- (a) a gate on a step with declared outputs that names none of its own `artifact.<Type>.exists`;
- (b) a fact the daemon does not know (with "did you mean" for near misses);
- (c) a fact that exists but is not measured inside a step gate, with its scope in the reason: "The gate on 'release' reads mission.stalled, which is only known for the whole mission, not inside a step."

Every fact in the vocabulary carries its **scope** (`step`, `mission` or `workspace`). The validator, the planner prompt and the facts table in `docs/WORKFLOWS.md` are all generated from that one list.

## Not in P15

- Skills (`skills.lock`): P13 is not merged. The export writes no `skills.lock` and the importer ignores one; P13 adds it (see Rulings).
- Staffing, people, agents, runtime profiles, integrations and their secrets: machine- and person-specific. A role's runtime is written by name for the reader, and compared, but not applied (see Rulings).
- Exporting built-in workflow presets (they ship with the app) and the per-runtime concurrency ceilings (keyed by local profile ids).
- A merge editor. The choice is per item: mine or theirs.
- Watching the folder for changes; importing is always an explicit action.
- Re-judging missions already planned: plans accepted before P15 keep running under the rules they were accepted with.

## 1. Gate facts with a scope (FIX-FACTS)

The vocabulary moves from `@tandemise/evaluation` to `@tandemise/domain` (`gate-facts.ts`), because plan and workflow validation live in domain and must read it. `@tandemise/evaluation` re-exports it unchanged, so nothing that imports it breaks.

Each `FactDefinition` gains:

| Field | Meaning |
|---|---|
| `scope` | `step`: measured when a step's gate is read (`GateService.factsFor`). `mission`: measured for the whole mission by a daemon rule or service, never inside a step. `workspace`: measured for the whole project. |
| `measuredIn` | where the daemon supplies it, in words, for the docs table |
| `requires` | optional step condition for a step fact: `independentOf` (only `review.independent`), `worktree` (only `git.clean`), `ChangeSet` output (only `diff.files_changed`) |

The audit, fact by fact (every fact now has one of three answers):

| Fact | Measured where | Scope | Decision |
|---|---|---|---|
| `checks.install/typecheck/lint/tests/build` | `CheckService` + `GateService.factsFor` | step | keep |
| `checks.<name>` | nowhere: repositories configure only the five above | — | **removed**. No mechanism exists to configure another check; the pattern let `checks.test` and `checks.a11y` through as "valid" facts that are never measured |
| `artifact.<Type>.exists/count` | `factsFor` | step | keep; `<Type>` must be a real artifact type |
| `review.verdict/blocking_findings/major_findings` | `factsFor` | step | keep |
| `review.independent` | `factsFor`, only with `independentOf` (P12) | step, requires `independentOf` | keep |
| `qa.*`, `criteria.*` | `factsFor` | step | keep |
| `approval.plan/release_candidate/<kind>` | `factsFor` | step | keep; `<kind>` must be a real approval kind |
| `task.attempt/role/risk/risk_level` | `factsFor` | step | keep |
| `diff.files_changed` | `factsFor`, from the step's own ChangeSet | step, requires a ChangeSet output | keep |
| `git.clean` | nowhere | step, requires a worktree | **now measured**: after the checks, in a worktree step whose gate reads it, `git status --porcelain` in the worktree; recorded as a check result named `git.clean` (PASS when empty, FAIL listing the files) so it shows with the checks, follows the "newest result wins" rule, and is read by `factsFor` like any check. A step without its own worktree cannot be measured (it would read your checkout), so the validator refuses it there |
| `security.required_checks` | nowhere | — | **removed**, with `withSecurityChecks`. There is no way to mark a check "security-required"; the only reader was the dormant `ready_to_ship` named gate, which loses that conjunct. A real security check can come back as a configured check when repositories can declare one |
| `ready.*` | readiness service | mission | scoped |
| `mission.priority` | backlog | mission | scoped |
| `workspace.active_missions/max_active_missions` | backlog pull | workspace | scoped |
| `mission.agent_minutes/tokens/spend_usd/limit_percent` | limit service | mission | scoped |
| `workspace.month_limit_percent` | limit service | workspace | scoped |
| `mission.stalled` | liveness service | mission | scoped |
| `run.silent_minutes` | liveness service (a live run) | mission | scoped: a step's gate is read after its run ended, so there is never a live run to measure |

## 2. The validator

`lintGate(expression, subject) → GateProblem[]` in `@tandemise/domain` (`gate-lint.ts`), pure. `subject` is `{ stepKey, outputs, independentOf, isolation? }`. Rules, in order, each a named `code` and one sentence:

| Code | When | Words |
|---|---|---|
| `syntax` | the expression does not parse | "The gate on 'build' cannot be read: <parser error>." |
| `unknown_fact` | not in the vocabulary (after `<Type>`/`<kind>` patterns) | "The gate on 'build' reads checks.test, which Tandemise never measures. Did you mean checks.tests?" |
| `not_step_scope` | scope `mission` / `workspace` | "The gate on 'release' reads mission.stalled, which is only known for the whole mission, not inside a step." / "… only known for the whole project, not inside a step." |
| `needs_independent_of` | `review.independent` without `independentOf` | "The gate on 'review' reads review.independent, which is only measured on a step with independentOf." |
| `needs_worktree` | `git.clean` and the step's isolation is known and not `worktree` | "The gate on 'notes' reads git.clean, which is only measured on a step that works in its own worktree." |
| `needs_changeset` | `diff.files_changed` without a ChangeSet output | "The gate on 'plan' reads diff.files_changed, which is only measured from the step's own ChangeSet, and 'plan' does not produce one." |
| `own_output` | outputs declared, and none of `artifact.<Output>.exists` is read | "The gate on 'build' never checks that the step wrote its output: add artifact.ChangeSet.exists, so a run that writes nothing cannot pass." (all outputs listed with "or") |

Where it runs:

- **Workflow files, on load**: `parseWorkflowDefinition` adds the problems as issues (`steps.<i>.gate`). A broken file is listed with its issues, so New mission shows "This workflow cannot run yet — steps.3.gate: The gate on …" exactly where workflow errors appear today, and planning refuses it.
- **Workflow compile**: `compileWorkflow` runs the rules again with the step's resolved isolation (a role's default), so `git.clean` on a step that inherits `none` is caught.
- **Planner output**: `validateMissionPlan` runs every rule on each task (`executionPolicy.isolation`, `modelPolicy.independentOf`). The problems are plan errors; the planner's retry gets them verbatim (existing behaviour).
- **Materialize**: `materializePlan` refuses a plan with a gate problem (a preset or workflow that gets here broken is a bug, and the offline check audits every preset).
- **Imports**: each imported workflow is parsed by the same function; an item with problems cannot be taken.
- Not on **graph mutations** of a running mission (`validateTaskGraph`): its tasks were accepted under the rules of their day, and re-judging them mid-mission would stop a remediation. The engine's own spliced tasks (`artifact.ChangeSet.exists` on a ChangeSet step) pass the rules, and the check proves it.

The planner prompt lists the step-scoped facts generated from the vocabulary (without `review.independent`, which a planner cannot set up), plus the existing guidance lines.

`docs/WORKFLOWS.md`'s facts table is generated between `<!-- gate-facts:start -->` and `<!-- gate-facts:end -->` by `node scripts/gate-facts-doc.mjs --write`; the offline check fails when the file differs from the generated table.

## 3. Ignore only what is Tandemise's

`.tandemise/.gitignore` (written by the harvester, the planner and refinement) now reads `/out/` and `/.gitignore`, and the git exclude line is `.tandemise/out/`. The harvester replaces an old `.tandemise/` exclude line with the new one. Export repairs both in the chosen repository (an exact old `*` ignore file, an exact old exclude line; nothing else is touched) and then asks git whether any exported file is still ignored; if so it says which rule and how to fix it.

## 4. The files

`tandemise.yaml` (keys sorted, `version: 1`):

```yaml
defaults:
  missionLimits: [{ amount: 30, metric: agent_minutes, warnPercent: 80 }]
limits:
  monthly: [{ amount: 50, metric: usd, warnPercent: 80 }]
project:
  autonomy: { externalWrites: policy, financialActions: deny, localCodeChanges: auto, planApproval: ask, productionRelease: ask }
  knowledge: { codingStandards: "…" }
  maxTotalWorkers: 3
  name: Demo project
secrets: []
version: 1
wipLimit: 2          # or `off`
```

`roles/<id>.md`, one per role the project has (built-ins included, so any role can be edited in the file):

```markdown
---
capabilities: [artifact.write, filesystem.write, repository.read]
consumes: [ImplementationPlan]
economyModel: small-model
escalate: [strong-model]
id: development
isolation: worktree
model: base-model
name: Developer
outputContract: |
  …
produces: [ChangeSet]
runtime: [Claude Code]
summary: …
---
<instructions>
```

Capabilities and artifact lists are sorted (they are sets); `escalate` keeps its order (a ladder). `runtime` lists runtime names only.

`workflows/<id>.yaml`: the project's own workflow files, byte for byte. A workflow already in the chosen repository is left untouched (it is already code); one found in another repository of the project is copied. Presets are not written.

`routines.yaml`: `routines:` sorted by name, each with `goal`, `kind`, `limits`, `name`, `priority`, `schedule`, `successCriteria`, `workflow`. No `enabled`, no run history.

**Secrets.** Every text written (instructions, output contract, knowledge, routine goals and criteria) passes through the daemon's secret patterns. A match is replaced with `${SECRET_1}`, `${SECRET_2}`, … in file order and declared in `tandemise.yaml` `secrets:` (`name`, `file`, `note`). Importing a text with a placeholder imports the placeholder and the preview says so.

**Byte-stable.** No timestamps, ids of rows, absolute paths or machine names are written. Keys are sorted, lists that are sets are sorted, YAML is written with one fixed option set, every file ends with one newline. The **content hash** is the first 12 hex digits of sha256 over `path NUL content NUL` for every file in path order.

## 5. Import

`preview(folder)` reads `<folder>/.tandemise/` (or the folder itself when it is a `.tandemise` folder), parses every file, and diffs against the project item by item. Items:

| Kind | Identity | Compared on |
|---|---|---|
| Project settings | one item | name, autonomy, workers, knowledge |
| Work-in-progress limit | one | the number or off |
| Monthly limits | one | the list |
| Default mission limits | one | the list |
| Role | id | everything in the file except `runtime` (a differing runtime is a note on the row) |
| Workflow | file id | the file's text (line endings normalised) |
| Routine | name | every exported field |

Actions: **Add** (only in the files), **Change** (both, different), **Remove** (only in the project), **Same**. Defaults: Add and Change take theirs, Remove keeps mine. Same has no choice. An item whose file cannot be read, or whose workflow fails the validator, shows its reason and can only be kept.

Remove means: a custom role is deleted, a built-in role is restored to its shipped definition, a routine is deleted, a workflow file is deleted, a limit list becomes empty.

`apply(folder, hash, choices)` re-reads the folder and refuses with 409 "The files changed since the preview. Preview again." when the hash differs. Then, in **one database transaction**, it applies every "take theirs" item through the existing services (workspace update, role upsert/remove, routine create/update/remove). Workflow files are written to the project's default repository (`.tandemise/workflows/<id>.yaml`): staged next to their destination first, renamed into place only after the transaction commits, and discarded when it fails. An imported or changed routine is saved **off** with its last note "Imported — review and turn on"; turning it on clears the note.

The last export (hash, repository name, file count) is kept in the daemon's settings under `setupExports.<workspaceId>`.

## 6. API

In `api-contract/src/setup.ts`:

- `GET /v1/workspaces/:id/setup` → `SetupStatusView { lastExport: { hash, repositoryName, files, at } | null }`
- `POST /v1/workspaces/:id/setup/export { repositoryId }` → `SetupExportView { folder, files: [{ path, bytes }], hash, secrets: [...], warnings: [...] }`
- `POST /v1/workspaces/:id/setup/preview { path }` → `SetupPreviewView { folder, hash, items: [{ id, kind, name, action, detail, problem, notes, choice }], counts }`
- `POST /v1/workspaces/:id/setup/apply { path, hash, choices }` → `SetupApplyView { applied, kept, lines[] }`

## 7. Desktop

Project settings (`/project`) gets a section **Setup as code** (aria-label "Setup as code"), meta "Last exported <hash>" or "Not exported yet":

- **Export**: a repository select (aria-label "Export to repository") and an **Export** button. The result lists the files written (mono) with the content hash, the secret placeholders, and any git warning.
- **Import**: **Import from a folder…** opens the folder picker, then a preview table (Item, Kind, Change, Your choice); each row's choice is a segmented control (aria-label "Choice for <item>": Keep mine / Take theirs). **Apply** (primary) and **Cancel**. After Apply: "Applied N changes. Imported routines are off until you turn them on."

Routine rows with the imported note show it as a badge instead of "Last: …". Workflow problems appear where they do today: New mission's workflow picker and the plan's validation failure.

## Testing

**Offline:** `scratch/p15-setup-check.mjs`, added to OFFLINE_CHECKS, written first and seen failing:

- vocabulary: every fact has a scope and `measuredIn`; `security.required_checks` and `checks.<name>` are gone; for every **step** fact a real `GateService.factsFor` (SQLite) on a task set up to measure it returns a defined value; `git.clean` is measured PASS on a clean worktree and FAIL after an untracked file, through `CheckService` with a real git worktree;
- `lintGate`: every rule and its exact words; the preset plans and the engine's spliced tasks lint clean; the planner prompt lists no non-step fact; the WORKFLOWS.md table equals the generated one;
- workflow load: a file whose gate reads `mission.stalled` and one missing its output check are listed with those issues; `validateMissionPlan` rejects the same gates; `materializePlan` refuses them;
- export: from a seeded daemon (`startDaemon`), export twice → identical bytes and hash; no `/Users`, no ids, no timestamps; a secret in instructions becomes `${SECRET_1}` and is declared;
- import: an unchanged folder previews all Same; editing a role's model → exactly 1 Change; a new routine → Add, applied disabled with the note; Remove defaults to keep; a changed folder after preview → 409; an apply that fails mid-way (a role id the validator refuses) changes nothing, and no workflow file is written;
- ignore repair: an old `*` ignore file and `.tandemise/` exclude line are rewritten and the exported files are not ignored.

**Real app** (`scratch/acceptance/p15/`, CDP 9350, home `/tmp/tdm-p15`, scripted agent):

| # | Scenario | Must observe in the window |
|---|---|---|
| Q1 | Set a role model in Team → Roles and a monthly limit; Project → Setup as code → Export to the project repository | the file list and "Content hash <h>" in the section; "Last exported <h>"; on disk `tandemise.yaml`, `roles/development.md` with the model, `routines.yaml`, the workflow files; a second export shows the same hash |
| Q2 | Edit `model:` in `roles/development.md` on disk; Import from the repository folder | preview shows exactly one **Change** (Developer) and the rest Same; Apply; Team → Roles shows the new model in the Developer's "Model" field |
| Q3 | Add a routine to `routines.yaml`; Import; Apply | preview shows **Add** for it; Missions → Routines shows it **Off** with "Imported — review and turn on"; no mission was created |
| Q4 | Add workflow files whose gates read `mission.stalled` / miss `artifact.ChangeSet.exists` | New mission → workflow picker shows "This workflow cannot run yet — … only known for the whole mission, not inside a step." and "… never checks that the step wrote its output …" |

## Rulings

1. **All roles are exported, built-ins included.** Editing any role in the file must work; a missing file then means Remove (restore the shipped definition, or delete a custom role), which is why Remove defaults to Keep mine.
2. **A role's `runtime` is informative.** Runtimes and staffing are this machine's (profile ids, people, agents). The names are written so the file says what the role ran on, and a difference is a note on the row, but import never changes staffing; the Team screen does.
3. **Workflows already in the chosen repository are not rewritten.** They are already code; rewriting would drop comments. Other repositories' workflows are copied byte for byte. Import writes workflow files into the project's default repository.
4. **Changed routines are saved off too.** "Nothing starts running because of an import" covers a changed schedule as much as a new routine.
5. **One atomic Apply.** Every database change is one transaction; workflow files are staged and renamed only after it commits. A rename failing after commit (disk full) is reported, and a re-import fixes it: the preview shows the file as a Change.
6. **Skills lock.** P13 is not on `main`. The export writes no `skills.lock`; the importer ignores an unknown file. P13 should add `skills.lock` (id, version, hash per skill, sorted) when a project has skills, and a Skills item kind to the diff.
7. **Facts removed, not faked.** `security.required_checks` and `checks.<name>` are gone rather than measured as SKIP; `git.clean` is measured for real. See §1.
8. **Old plans are not re-judged.** `validateTaskGraph` (runtime graph changes) keeps syntax-only gate checks.
9. **`run.silent_minutes` is mission scope**: a step gate is read after the step's run has ended, so it is never measurable there.
10. **The ignore fix is part of this slice.** Without it the exported files are ignored by git, which defeats the story; it also makes existing `.tandemise/workflows` committable.
11. **`git.clean` is an outcome now (PASS/FAIL/SKIP), not a boolean**, because it is stored as a check result. A bare `git.clean` still works: PASS reads as true.
12. **A test hook for the folder picker.** A native dialog cannot be driven over CDP, so the desktop reads the chosen folder from the file named by `TANDEMISE_TEST_PICK_DIRECTORY` when it is set (acceptance only; unset in a normal launch).
13. **"Last exported" is per machine.** It lives in the daemon's `settings.json` (`setupExports`), not in the database: no migration, and the hash in the repository is the shared truth.
