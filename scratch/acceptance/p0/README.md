# P0 real-app acceptance suite

```
node scratch/acceptance/p0/run-all.mjs [--p1 | --p2] [--skip-claude] [--keep-going] [--only=s02,s03]
```

Each run starts from a fresh install: a new `TANDEMISE_HOME` behind `/tmp/tdm-p0`, the daemon
built from this checkout, and the real desktop window (`electron-vite dev`, CDP on 9333). It then
runs the scenarios below in order. Set `ACCEPTANCE_LINK` and `CDP_PORT` to run beside another suite.
Evidence (per-scenario JSON, screenshots, `REPORT.md`) is written to `evidence/`, which git ignores.

Since 0.4.0 the team is you and your agents. There is no "Add person", and the staffing pickers
offer no people presets. The suite builds that team: you, plus seven agents on the scripted runtime.

| File | IDs | What it proves |
|---|---|---|
| `s01-a1-solo.mjs` | A1 | A whole mission with no configuration. Every task is yours. |
| `s02-team.mjs` | TEAM, A14 | Adds seven agents and sets presets in the Team screen. Editing one role or agent moves nothing else. |
| `s03-team-mission.mjs` | PLAN, A2, A2d, A8, A9a, A3, A7q, A9b, A13 | One mission run by your agents, with every decision made in the window. |
| `s05-midway.mjs` | A12 | Changing staffing mid-mission moves only the tasks that have not reached READY. |
| `s06-real-claude.mjs` | A15 | Your Design agent on real Claude Code. Skipped by `--skip-claude`. |
| `s07-remove-agent.mjs` | A11 | Removing an agent stops work from routing to it, and its history keeps its name. Restoring it brings it back. |
| `s08-reassign-task.mjs` | A18 | A task that has not started is handed to another agent from its Change drawer. A task that already ran refuses. |

## Retired scenarios

Each of these needed a second person on the team. 0.4.0 deleted "Add person" outright, not
behind `FEATURE_FLAGS.agentsOnly`, so the window can't create a second person. The daemon rules
still exist, and the offline `staffing-check` still covers them.

| ID | Was in | Retired because |
|---|---|---|
| A4 | s03 | A teammate's agent is approved by that teammate. There are no teammates, so it's covered by A2d (your agent's work is yours to approve). |
| A6 | s03 | "Recording for" someone else's decision needs someone else. A2d asserts that your own decisions don't offer it. |
| A7 | s03 | A pool of people claiming a step. The pool preset is hidden. A7q proves QA runs on the agent staffed first instead. |
| A5 | s04 | A lead's sign-off on delegated work needs a lead with a person reporting to them. |
| A10 | s04 | An unanswered request climbing the reporting tree needs someone above the addressee. You are the top. |
| A16 | s04b | A one-person pool escalating to the owners needs a pool of people. |
| A17 | s08 | A person's own work reviewed and signed off by their lead needs a person other than you. |
