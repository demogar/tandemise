# Rulings made while building the planner and risk-based merge (#53)

Ambiguities and plan defects found while executing
`docs/superpowers/plans/2026-10-30-planner-and-merge.md`, each decided by the
spec (`docs/superpowers/specs/2026-10-30-planner-and-merge-design.md`).

- Ruling: one pull request, not five. The coordinator asked for a single PR
  titled `feat: plan each task's steps, models and gates, and merge by risk`
  for Tasks 1–19, so the plan's per-phase PR openings (Tasks 8, 11, 14, 17, 19)
  become commits on one branch. Task 20 (brain-backed source) is a follow-up
  after #51 merges.
- Ruling: `!x` of an unmeasured `x` is unmeasured, not `true`. The plan's
  `merge.yaml` rule `change.dependencies_changed && !change.lockfile_only` and
  the spec's constraint "unmeasured never satisfies a rule" require it. No
  existing step gate uses `!`, so no gate changes meaning.
- Ruling: `process.revert_of_auto` is added to the ship vocabulary in Task 1,
  because Task 17 names it as a decision fact and the vocabulary is the single
  list of facts.
- Ruling: the migration is 022, the next free number on this branch's base
  (origin/main has 001–021). The plan assumed 026 behind #50/#51/#52/#54;
  the coordinator settled that the number is decided by merge order at
  integration, so whoever merges later renumbers. All of #53's tables are in
  this one migration.
- Ruling: `merge_decisions` also stores `would_merge` and `reasons`, and
  `plan_decisions` stores `lightened_by_person`: the ship card's "what would
  have happened" and the `process.lightened_by_person` fact need them, and
  re-deriving them from `factors` would duplicate decideMerge.
- Ruling: the three repositories live in one file,
  `packages/persistence/src/repositories/planner-repositories.ts`.
- Ruling: in `fix-careful` the code step's key is `implement` (titled "Fix the
  defect"), not `fix`, so modules that insert after `implement` (the security
  review) apply to careful fixes too.
- Ruling: the shipped lanes' review step does not set `independentOf`. With one
  runtime and no models configured, `review.independent` can never be true and
  every standard task would block. Independence comes from `routing.yaml`'s
  `independentOf` (spec §6.1), which writes it into the step's model policy.
- Ruling: `null` is a literal in the gate language (unmeasured), so the shipped
  `requires` line `review.blocking_findings == 0 || review.blocking_findings == null`
  lints and means what it says. `routing.yaml` and `merge.yaml` schemas land
  with the factory source (Task 4) because `loadFactoryConfig` returns them; their
  behaviour is tested in Tasks 10 and 12.
- Ruling: `skipsReadiness` needs the factory files, which are read
  asynchronously, while `#enterPlanning` is synchronous; `plan()` and `begin()`
  call `planner.warm(id)` first (two one-line insertions beyond the plan's four).
- Ruling: the tiebreak runs through a `TIEBREAK_RUNNER` port (bound to a
  runtime-backed runner using the planner role's runtime and economy model),
  so the check can count calls and script replies without a real model.
- Ruling: P14 issue links store no labels, so until #52's tracker item lands
  a mission's title prefix is the only tracker-side signal.
- Ruling: `createMissionRequest` gains `lane` in Task 5 (the plan put it in
  Task 8) because the ceremony check creates a careful mission through it; with
  `auto` and no careful lane, `planNow` no longer demands a Done-when line.
- Ruling: the factory validates a plan's graph, roles, repositories and gates,
  not its capabilities against one runtime, as an authored workflow does;
  grants are enforced when a step runs.
- Ruling: a skill an area or module adds that the library lacks is taken off
  the step and named in the decision's `dropped`, instead of refusing the plan
  (the shipped `security-review` skill would otherwise block every auth task).
- Ruling: `PullRequestPort` is declared whole in Task 6 (open, view, checks,
  protection, comment, reviewers, reviews, merge, updateBranch, repoSettings,
  commits) with its `gh` implementation and the fake `gh` commands, so later
  tasks change only the ship step. Checks are read per commit through the
  check-runs API, so the same call serves a PR head and a merge commit on main.
- Ruling: a mission with no repository, an eval trial, or a plan where no step
  changed code ends the ship step SKIPPED with a sentence; it never fails the
  mission.
