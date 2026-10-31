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
- Ruling: the measured re-profile runs when the ship step starts (before
  integrating or pushing), from `git diff --name-only base...<code branch>`, rather
  than from `Scheduler#settled`. Promotion would otherwise race the async diff and
  start the ship step before the added steps exist; at ship start every code
  step has run, and the added steps still run before the pull request.
  `Scheduler` is not touched for this.
- Ruling: "Make it quick" files a plan card through the replan proposal
  machinery (replacing the unstarted review/verify/spec steps and the ship step
  with a ship step after the remaining code). The card carries a `Lane: quick`
  evidence line; approving it calls `PlannerService.laneApproved` (one optional
  hook in ApprovalService), which sets `laneRequest` and records
  `lightenedByPerson`, so it survives a restart.
- Ruling (Task 8): Plan careful with no Done-when line doesn't refuse; the mission
  stays a draft with a feed note and the UI points to "Get it ready" (spec §4: as
  today). Plan quick / Plan careful are plain header buttons. The measured
  "It touched …" sentence is asserted on the Timeline/events, since the Feed tab
  shows cards only. A lane the measured change raised reads "… lane now: the
  change turned out riskier than planned …", never "a plan you approve".
- Ruling (Task 9): #50's hold service isn't on this base, so `OutcomeRecorder.held`
  exists but nothing calls it yet; wiring it is part of integrating with #50.
  Outcome events carry the profile's highest `sensitivity` (an optional field
  beyond the spec's op) because the routing bucket needs it and area names
  alone don't say it. `p3-evals-check` built a mission repository on a
  database migrated only to 020; it now migrates the rest first, since the
  repository reads the current schema (the new `lane_request` column).
- Ruling (Task 10): routing and plan-time approvals run inside the factory's
  shaping pass (after modules and skills, before validation), so the careful
  lane's tailored plan is routed too. A class's `independentOf` from
  `routing.yaml` also adds `review.independent` to that step's gate, as a
  workflow's `independentOf` does. The "continued hold doesn't escalate" check
  waits for #50's hold service. Routing stats look back 180 days.
- Ruling (Task 11): PM10 drives "people stepped in" with request-changes rounds
  (holds are #50's), under a project planner.yaml with the desktop-ui area and
  `holdApproval.minTasks: 3`. The fold counts each task once in `steppedIn`, however
  many rounds it had. Task 11 was committed after Task 12 because it was
  delegated and Task 12 is independent of it.
- Ruling (Task 11): "Write the defaults" writes only the files the project lacks,
  never over a project file, into the default repository. Routing lists only
  classes with a ladder, plus any other model measured ("role model"); the
  starting rung shown is computed at medium risk so it never shows a probe.
  Rule problems show the daemon's message, not the YAML path. The fold counts a
  task once (its first result) in both `steppedIn` and the routing buckets, so a
  round's rerun is not another task.
- Ruling (Task 13): the ship step watches GitHub itself: each scheduler pass
  (every `shipPollMs`, default 30 s, `TANDEMISE_SHIP_POLL_MS` in the daemon) re-adopts
  a ship step waiting on CI, GitHub or a person, so the same path covers a
  restart. A decision already made for the current head is never made again.
  The "Review and merge" card uses the approve option labelled Merge and the
  reject option labelled "I'll merge it in GitHub", so the existing approval
  semantics hold; ApprovalService hands a ship card to the ship step after the
  commit instead of resuming the task. `process.person_commits` counts commits
  past the head Tandemise last pushed (agents commit with any identity, so
  author email can't tell them apart). `history.*` facts are filled from the
  fold here rather than in Task 18. Task 13's checks were written after the
  ship-step code, so there was no red run for them.
- Ruling (Task 14): PM2 asserts "would have merged: score 1 of 2", not the
  spec's "0 of 2": under the shipped policy a quick-lane change has no independent
  review, which scores 1 (`review.independent != PASS`). The fake gh gains
  `defaultChecks` per repository so an acceptance run can make CI green on every
  commit. The PM2 and PM5 scenarios were written after the code they test, so
  there was no red run for them.
- Ruling (Task 16): a head that moves between decision and merge is a commit
  Tandemise didn't push, so the new decision on that sha asks (`process.person_commits`)
  rather than merging. The spec's PM8 only requires that the decision be voided and
  remade on the new sha. The squash trailers carry the decision's own score (1/2 for
  a quick change with no review), not the spec example's 0/2.
- Ruling (Task 17): a revert mission's only step is the ship step, shipping a
  `revert/<sha>` branch the daemon made with `git revert` (`workflowInputs.shipBranch`,
  daemon-set, along with `revertOfAuto`). The fake gh's merge now makes a real squash
  commit on a local bare origin so a revert has something to undo. The
  "Main is failing" card sits on the original ship step: Revert on it reverts
  through the same path, and Leave it does nothing. Main-watch, revert and clean are
  checked with `MergeWatch.sweep(nowMs)` for the 8-day case. PM3, PM4, PM8 and
  PM9 run after PM10 in the suite, so PM10's file origins hold. The revert-and-watch
  checks were written after the code, so there was no red run for them.
- Ruling (Task 18): proposals are committed on `tandemise/promote/<id>` through a
  throwaway git worktree (hash-object plus update-index), and never through
  `FactoryConfigSourcePort.write`. The only callers of `write` are the merge policy
  service and Write the defaults, and the check asserts that against the built
  code. A proposal's history comes from the PRs on its branch
  (`PullRequestPort.listByHead`, "Evidence: N outcomes" in the body), so no new table
  is needed. The sweep runs from the scheduler's pass, once a day.
