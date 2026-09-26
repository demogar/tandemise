# Workflows

A workflow is your process, written down. It lives in your repository, at
`.tandemise/workflows/<name>.yaml`, and it compiles to exactly the plan
Tandemise would otherwise ask a model to propose — so it inherits the dependency
graph, the gates, the approvals and the scheduler unchanged.

`docs/examples/build-feature.yaml` is a complete one: issue → plan → design →
build → review → PR → CI → merge → deploy → production check → release notes.

## Why a file

Because a process belongs next to the code it describes. It is versioned with
that code, it arrives on a new machine with a clone, a change to it shows up in
a diff, and a branch can carry a different one while you are trying something.
None of that is true of a row in a local database.

## The three kinds of step

```yaml
steps:
  # 1. An agent. The default; needs a role.
  - key: build
    role: development
    objective: Implement the plan for issue #{{ issue }}.
    isolation: worktree
    gate: checks.typecheck != FAIL && checks.tests != FAIL

  # 2. A person. Parked until you come back with something.
  - key: design
    executor: human
    dependsOn: [build]
    objective: Make the design in Figma. Paste the URL.
    outputs: [DesignBrief]

  # 3. A wait. Watches something outside this machine.
  - key: ci
    executor: wait
    dependsOn: [build]
    waitFor: gh pr checks --watch --fail-fast
    everyMs: 30000
    timeoutMs: 1800000
```

A **human** step keeps manual work inside the dependency graph, so the tasks
that need it wait rather than fail — and what you paste is written as the
artifact the step declared, which means the next task reads a design you made in
Figma exactly as it would read one a model wrote.

A **wait** step holds no model and no worker slot. The obvious alternative — an
agent polling in a loop — re-sends its whole context on every poll, so a
ten-minute CI wait is billed as a ten-minute conversation.

## Worktrees

You do not ask for one. A step's isolation comes from the step if it says so,
otherwise from its **role** — `development`, `review` and `qa` all declare
`worktree`, so a code step gets its own checkout and branch without the workflow
mentioning it. Only if neither says anything does a step run in place.

That order exists because forgetting `isolation: worktree` on a `development`
step would point an agent at your real working tree, which is the one thing
Tandemise exists to prevent.

Each worktree is cut per task, branched from the mission's base — except a
reviewer or tester, which is branched from the upstream task's change branch so
it sees the actual diff rather than the description of it. `node_modules` is
cloned copy-on-write where the filesystem supports it, so provisioning is fast.

## Inputs

```yaml
inputs:
  - name: issue
    description: GitHub issue number
    required: true
```

Referenced as `{{ issue }}` in any `objective` or `waitFor`. That is the whole
templating language: a workflow that needs conditionals is a program, and the
DAG is where branching belongs.

## When something is wrong

Mistakes are caught when the workflow is read, naming the step and the problem —
a typo in `dependsOn`, an agent step with no role, a `{{ placeholder }}` you
never declared, a `waitFor` on a step that is not a wait. A file that will not
parse is listed with its error rather than skipped, because a workflow that
silently vanishes sends you looking anywhere except at the file you just broke.

## Precedence

Your file wins over a built-in preset of the same name. The built-ins stay
underneath as a starting position, not a ceiling.

## Gate facts

A `gate` is an expression over measured facts, for example
`artifact.QAReport.exists && qa.criteria_failed == 0`. A fact that is not
measured compares false against everything, so a gate never passes because a
measurement was missing: the step fails with "Not met: … is not measured".

This is the complete vocabulary (`GATE_FACT_VOCABULARY` in
`packages/evaluation/src/facts.ts`). The **Measured in** column says where the
daemon supplies each fact. Only facts marked *step gate* can be used in a
workflow file: the others are read by the daemon's own rules (the readiness
check before planning, the backlog pull) or published for the desk and the
status report, and are not measured when a step's gate is checked.

### Checks, artifacts, review and task

| Fact | Type | Meaning | Measured in |
|---|---|---|---|
| `checks.install`, `checks.typecheck`, `checks.lint`, `checks.tests`, `checks.build` | PASS / FAIL / SKIP | the repository's configured commands; SKIP when none is configured | step gate |
| `checks.<name>` | PASS / FAIL / SKIP | any additional repository check, under its configured name | step gate |
| `artifact.<Type>.exists` | boolean | a non-superseded artifact of that type exists for the mission | step gate |
| `artifact.<Type>.count` | number | how many artifacts of that type the mission has | step gate |
| `review.verdict` | `"pass"` / `"needs_changes"` / `"fail"` | the independent reviewer's verdict | step gate |
| `review.blocking_findings` | number | reviewer findings with severity `blocking` | step gate |
| `review.major_findings` | number | reviewer findings with severity `major` | step gate |
| `approval.plan`, `approval.release_candidate`, `approval.<kind>` | PENDING / APPROVED / REJECTED / EXPIRED / CANCELLED | status of that approval on the mission; a pending one wins | step gate |
| `task.attempt` | number | which attempt this is; 0 before the first run | step gate |
| `task.role` | text | the role the step is staffed under | step gate |
| `task.risk` | text | the step's highest risk class: `read` … `release` | step gate |
| `task.risk_level` | number | `task.risk` as 0 (read) to 5 (release) | step gate |
| `diff.files_changed` | number | files the step's own ChangeSet says it changed | step gate, when it wrote a ChangeSet |
| `security.required_checks` | PASS / FAIL / SKIP | aggregate of the security-required checks | in the vocabulary; not measured today |
| `git.clean` | boolean | the working tree has no uncommitted changes | in the vocabulary; not measured today |

### QA and the Done-when ledger (new in 0.5)

See [Done when](guides/done-when.md). The `criteria.*` counts are always
measured. The `qa.criteria_*` facts are measured whenever the mission has
criteria, even before QA ran ("nothing verified yet" is a measurement).

| Fact | Type | Meaning | Measured in |
|---|---|---|---|
| `criteria.total` | number | live criteria: your Done-when lines plus the current spec's acceptance criteria | step gate |
| `criteria.user_total` | number | your Done-when lines (`U1`, `U2`, …) | step gate |
| `criteria.uncovered_user` | number | your lines that no acceptance criterion of the current spec lists in `covers` | step gate |
| `criteria.unknown_covers` | number | entries in the spec's `covers` lists that name none of your lines | step gate |
| `qa.criteria_verified` | number | counted criteria the newest QA report marked PASS | step gate, with criteria |
| `qa.criteria_failed` | number | counted criteria the newest QA report marked FAIL | step gate, with criteria |
| `qa.criteria_unverified` | number | counted criteria with neither: skipped, never reported, not covered, or written after QA ran | step gate, with criteria |
| `qa.acceptance_criteria_coverage` | number, 0–100 | with criteria: verified ÷ counted × 100 (**changed in 0.5**: it used to divide by the results QA chose to report, so one pass out of five read 100). Without criteria: the share of QA's own results that passed | step gate, after QA |
| `qa.blocking_defects` | number | QA defects that block release | step gate, after QA |
| `qa.verdict` | text | QA's overall verdict | step gate, after QA |

"Counted" criteria are every live spec criterion plus every one of your lines
that nothing in the spec covers.

The built-in presets use them like this:

```
spec:     artifact.ProductSpec.exists && criteria.uncovered_user == 0 && criteria.unknown_covers == 0 && criteria.total >= 1
qa:       artifact.QAReport.exists && review.blocking_findings == 0 && qa.criteria_failed == 0
release:  artifact.ReleaseCandidate.exists && qa.criteria_unverified == 0 && qa.blocking_defects == 0
```

Every preset gate names its step's own output (`artifact.<Type>.exists`), so a
step that wrote nothing cannot pass on facts other steps produced. Do the same in
your own files.

### Daemon rules and published facts (new in 0.5)

These are measured by the daemon for its own decisions or for the desk. They
are listed so you know what exists; writing them in a step's gate makes that
gate fail as "not measured".

| Fact | Type | Meaning | Measured in |
|---|---|---|---|
| `ready.criteria` | number | accepted Done-when criteria of a draft | the readiness check before planning ([Refine](guides/refine.md)) |
| `ready.open_questions` | number | refinement questions not answered yet | the readiness check |
| `ready.proposed_pending` | number | proposed criteria not accepted or rejected yet | the readiness check |
| `workspace.active_missions` | number | missions in progress in the project (not draft, not paused, not finished) | the backlog pull ([Backlog](guides/backlog.md)) |
| `workspace.max_active_missions` | number | the work-in-progress limit; not measured when the limit is off, so nothing is pulled | the backlog pull |
| `mission.priority` | number | 0 urgent, 1 high, 2 normal, 3 low | published; the backlog orders by priority directly |
| `mission.agent_minutes` | number | agent minutes the mission's runs used | published by the limit service ([Limits](guides/limits.md)) |
| `mission.tokens` | number | input + output tokens reported; not measured when none was reported | published by the limit service |
| `mission.spend_usd` | number | US dollars reported; not measured when none was reported, never 0 | published by the limit service |
| `mission.limit_percent` | number | the highest share of a mission limit used; not measured without a limit | published by the limit service |
| `workspace.month_limit_percent` | number | the highest share of a monthly limit used this month; not measured without one | published by the limit service |
| `mission.stalled` | 0 / 1 | 1 when nothing moves the mission and nothing asks you ([Inbox](guides/inbox.md)) | published by the liveness service |
| `run.silent_minutes` | number | minutes since the step's live run last wrote an event; not measured with no live run | published by the liveness service |

The rules themselves, as the daemon evaluates them:

```
ready to plan:  ready.criteria >= 1 && ready.open_questions == 0 && ready.proposed_pending == 0
pull the next:  workspace.active_missions < workspace.max_active_missions
```

The limit stop and the stalled and quiet rows are daemon rules over the same
numbers; no gate you write can loosen them.
