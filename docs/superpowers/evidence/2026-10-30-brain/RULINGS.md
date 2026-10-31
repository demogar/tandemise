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
- Ruling (Task 8): within one millisecond, an entry's `add` sorts before events about it (then `by`, `id`), so a vote or accept written in the same millisecond as its lesson is never an unknown id. The fold stays a pure function of the event set.
- Ruling (Task 9): ledger events are buffered and committed at most every two minutes, at mission end, at shutdown and before every sync. The lessons list folds the buffered events too, so "Remember this" shows at once without a commit per click.
- Ruling (Task 10): one-commit-per-attempt is proven at `BrainContextSupply.forAttempt` (a retry in the same round reuses the earlier run's sha; a new round pins afresh) plus one real executor run, rather than by making the fake runtime fail and retry mid-pull.
- Ruling (Task 11): the brain tools are always built in, but a project without a brain is not told about them in its contract notes, so "no brain, no brain.propose line" holds.
- Ruling (Task 12): #50's hold record (`head.txt` in the hold's dir) is not on this base, so the hold's evidence is the diff stat plus `git diff HEAD` of the task's working directory. The reflector's and promoter's prompts are kept beside each pass (`<workspace>/brain-passes/<passId>/prompt.md`) so what they saw can be audited.
- Ruling (Task 14): `BrainRepoPort.commit` gained an optional `onto: { branch, from }` (a throwaway worktree), so a promotion branch is committed without moving the checked-out default branch; additive. A small promotion that passes is committed onto the default branch with the trailers (the same content as its branch), rather than a fast-forward, because the ledger may have moved the default branch since. A local accept falls back to the same when a fast-forward isn't possible. Rules without a role scope are drafted on the architect's runtime.
- Ruling (Task 14): eligible lessons are proposed after a person's thumbs-up through the API and after each background sync, never from a check's direct service call, so offline checks stay deterministic.
- Ruling (Task 14): a `brain` eval candidate carries its rules on the stored run, and only candidate trials read them; the baseline trials keep their frozen knowledge.
- Ruling (Task 16): a person's own lessons (Remember this, accept, reject, retire) and the lessons a hold or a request for changes teaches are committed at once, not at the next two-minute batch, so "Agents will see it from the next run" is true. Votes, agent proposals and gate candidates stay batched.
