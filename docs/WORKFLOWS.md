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
    gate: checks.typecheck != FAIL && checks.test != FAIL

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
