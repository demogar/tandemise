# Brain (#51): rulings made while building

Calls made by the builder where the plan was ambiguous, wrong, or depended on
parallel work. Each one is decided by the spec
(`docs/superpowers/specs/2026-10-30-brain-design.md`).

- Ruling: eval cost compares the scorecard's mean, not the median (accepted by the controller; P3b reports only a mean).
- Ruling: migration 022 (hold-and-interact, #50) is not on `main` yet, and `assertOrdered` refuses a gap. This branch carries #50's `022_task_holds.ts` byte for byte (blob `d2e8b82`, from `feat/hold-and-interact`) so 023 stays contiguous. When #50 lands, the same file merges cleanly; nothing in the brain depends on the `task_holds` table.
