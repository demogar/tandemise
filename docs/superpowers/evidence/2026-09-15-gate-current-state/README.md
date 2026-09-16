# A gate reads the current state, never a stale one

Reported from the real app: approval `apr_01m2kjvrw7na56wzafah` on task
`tsk_01m2bqssnqsaefb3rpcf` ("Build the approved design and open the PR"). The
task had burned all 14 of its attempts and sat `BLOCKED` with

```
Not met: checks.tests is "FAIL" != FAIL
```

Its tests failed exactly once, on attempt 1, two days earlier. Attempts 3-14
each ran `npm test` and each passed it in about 105 seconds. Six of those
attempts produced a ChangeSet; the last one opened PR #940 and a reviewer
passed it. Every one of them was judged a failure.

Nothing was wrong with the work. The gate could not see it.

## Cause

`GateService.factsFor` assembled the `checks.*` facts from two layers:

```ts
builder.withChecks(sortByTime(this.evaluations.latestChecks(task.missionId))); // newest per (task, name)
builder.withChecks(sortByTime(this.evaluations.listChecks(task.id)));          // EVERY row, all 14 attempts
```

`GateFactBuilder.withChecks` folds **worst-outcome-wins** (`FAIL > SKIP > PASS`).
It was changed from last-wins to worst-wins in `2f9b255`, to stop one task's
PASS masking another task's FAIL in a mission-level fact. That change was right
for the dimension it was aimed at and wrong for the one it also hit: folding a
task's entire history worst-wins pins a check to FAIL from its first failure
onward, permanently. **The retry loop was unwinnable by construction** - a retry
exists to clear an earlier failure, and no retry could.

Neither change was wrong on its own. The two-layer assembly landed in `c8cd447`
(2026-09-11) when the fold was last-wins, and under last-wins it did exactly
what its comment claimed: a re-run's result replaced the earlier one. `2f9b255`
(2026-09-12) then changed the fold in a different package, and that correct
layering became a permanent poison without a line of it being edited. The
regression window is everything built after 2026-09-12.

The caller's own comment still described the old contract - *"`withChecks` is
last-wins, so order is the whole contract"* - next to a `sortByTime` that a
commutative fold had made dead code. That stale comment is why the conflict
survived review.

Check facts have two dimensions and they need opposite rules:

| Dimension | Example | Rule |
|---|---|---|
| Time - attempts, and later tasks on the same code | attempt 1 FAIL, attempt 14 PASS | **latest wins** |
| Scope - repositories | web green, api red | **worst wins** |

The fix collapses time first, then folds scope: newest measurement per
repository, then worst across repositories.

## What else the same mistake was doing

Looking for the same shape - *a decision folded over history instead of read
off the current state* - turned up two more live faults, both fixed here:

- **A fix task could never clear the failure it was created to fix.** The task
  that failed keeps its FAIL as its own latest measurement forever, because it
  never runs again. Under a mission-wide worst-fold, that pinned `checks.tests`
  to FAIL for every later task too - so the remediation task, the re-review, and
  everything downstream were structurally unable to pass. Nothing in the
  product could have unstuck that mission.
- **The task card and drawer rendered every measurement ever taken.** For this
  task that is 52 rows describing 4 checks, including a red `tests` pill from
  two days and thirteen passing runs earlier. They now show the newest result
  per check; the full history stays on the Checks tab, which is what it is for.

## What a person is left with when a task does exhaust its retries

The gate's failure string is not decoration: it becomes the task's status
reason **and** the retry feedback the next agent is told to act on. This one
told a person and thirteen consecutive Claude Code runs that the tests were
failing while they passed. It now reads as a sentence about a measurement and a
requirement:

```
before   Not met: checks.tests is "FAIL" != FAIL
after    Not met: checks.tests is FAIL, needs anything but FAIL
         Not met: checks.typecheck is FAIL, needs PASS; review.blocking_findings is 2, needs 0
         Not met: qa.acceptance_criteria_coverage is 50, needs >= 80
```

And the intervention card - three options and, until now, nothing to choose
between them on - carries what the gate reads *now*, not what it read when the
attempt failed:

> **What the gate reads now** — Every condition is met as the work stands. One
> more attempt should clear it.

That is the recovery path. A task can exhaust its retries and still be sound,
the code already says so, and the person could not see it.

## Proof

`scratch/gate-facts-check.mjs` (offline, in `npm run ci`) drives the real
`GateService` over a real SQLite database. Every assertion was watched failing
before the fix.

| Scenario | Proven |
|---|---|
| A retry clears the failure it was created to fix | 14 attempts, FAIL on the first and PASS on the rest: the fact reads PASS and the gate clears |
| A fix task clears the failure of the task it remediates | the later measurement on the same repository wins; both tasks clear |
| A check failing right now still blocks | an unfixed FAIL is the newest word and blocks a sibling that never measured it - `2f9b255` holds |
| One repository passing never masks another failing | api red, web green afterwards: the mission fact is FAIL, and clears only when the api is re-measured |
| Naming the mission repository explicitly == leaving it null | both spellings are one scope, so a measurement on one supersedes the other |
| What a person is shown is the current state | 53 results kept, 4 shown, each the newest |
| An exhausted task is diagnosable | the live gate outcome is what the card quotes |

On the real database that produced the report (a copy; read-only, no daemon):

```
stored    : Not met: checks.tests is "FAIL" != FAIL
gate      : artifact.ChangeSet.exists && checks.typecheck != FAIL && checks.lint != FAIL && checks.tests != FAIL

  artifact.ChangeSet.exists  true
  checks.install             PASS
  checks.lint                PASS
  checks.typecheck           SKIP
  checks.tests               PASS

gate passes now : true
reason          : All gate conditions met.

rows the drawer used to render : 52
rows it renders now            : 4
```

### Nothing else moved

On this build, in the real app - fresh `TANDEMISE_HOME`, the daemon from this
checkout, the desktop window driven over CDP:

| Suite | Result |
|---|---|
| P2 feedback and rounds | 11/11 (140 checks) |
| P1 handoff and feed | 14/14 |
| P0 members and responsibility | 19/19 |
| `npm run ci` | green, including the 22 new assertions |

The real-runtime scenarios (C10, B11, A15) were skipped: this change is in gate
fact assembly and touches no runtime. Everything else ran.

## Known and left alone

Three sites fold history the same way but cannot be reached, so they are
recorded rather than changed on speculation:

- `withApprovals` ranks `REJECTED` above `APPROVED` across every approval a
  mission ever had, so one rejection from a superseded round would pin the fact
  for good. No gate a person or the planner can write references an approval
  fact; only `ready_to_ship` does, and it is dormant (below).
- `withSecurityChecks` has no caller, so `security.required_checks` is never
  assembled - which makes the shipped `ready_to_ship` gate unpassable. Its only
  entry point, `GateService.evaluateNamed`, has no caller either: the named
  workspace gates are defined and not yet wired to anything.
- `artifact.<Type>.count` counts superseded versions. The planner is offered
  `artifact.<Type>.exists` only, and no shipped gate uses `.count`.

`review.*` facts are the mission's latest evaluation, so they clear when a
re-review passes - recency-correct, but a task's gate can read a review of a
different task. That is scope, not staleness, and it is left as it is.
