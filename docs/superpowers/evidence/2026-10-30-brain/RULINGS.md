# Brain (#51): rulings made while building

Calls made by the builder where the plan was ambiguous, wrong, or depended on
parallel work. Each one is decided by the spec
(`docs/superpowers/specs/2026-10-30-brain-design.md`).

- Ruling: eval cost compares the scorecard's mean, not the median (accepted by the controller; P3b reports only a mean).
- Ruling: migration 022 (hold-and-interact, #50) is not on `main` yet, and `assertOrdered` refuses a gap. This branch carries #50's `022_task_holds.ts` byte for byte (blob `d2e8b82`, from `feat/hold-and-interact`) so 023 stays contiguous. When #50 lands, the same file merges cleanly; nothing in the brain depends on the `task_holds` table.
- Ruling (Task 5): a project-level note ("Updated the factory from the brain (n changes).") cannot be recorded as an event, because every event needs a mission. It goes to the daemon log and the Brain section's problems/refresh instead.
- Ruling (Task 6): the conflict sentence names no teammate: `BrainRepoPort` has no log/author query and the plan's port is binding, so it reads "Your change to <file> conflicts with one already in the brain. Opened <pr> to sort it out."
- Ruling (Task 6): write-through renders only roles, routines, skills.lock, issues.yaml and tandemise.yaml (with the brain's own knowledge fields). Workflows, tracker, intake and mcps are never written from rows, so a code-repo workflow or a missing local integration can't overwrite the brain.
- Ruling (Task 4): the adapters were written before the git section of the check, so that section was not seen failing first. Every later task shows RED before its implementation.
