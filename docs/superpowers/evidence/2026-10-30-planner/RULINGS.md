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
