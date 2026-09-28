# P3b real-app acceptance suite: evals

```
npm run build
node scratch/acceptance/p3-evals/run-all.mjs [--keep-going] [--only=e1,e2] [--hold]
```

Each run starts from a fresh install: a new `TANDEMISE_HOME` behind `/tmp/tdm-p3b` (a short
symlink, for macOS socket-path limits), the daemon built from this checkout (`p0/setup.mjs`), and
the real desktop window (`electron-vite dev`, its own `--user-data-dir`, CDP on 9338). The
scenarios run in order and drive the window; the daemon's API, its database and `git` in the
project are read as proof. Evidence (per-scenario JSON, screenshots, `REPORT.md`) is written to
`docs/superpowers/evidence/2026-09-27-p3b/` (or `$ACCEPTANCE_EVIDENCE_DIR`). `--hold` leaves the
window and daemon up; the next run stops them.

The model is the scripted agent (`p0/scripted-agent.mjs`); everything else is the product.

| File | ID | What it proves |
|---|---|---|
| `e1-save-case.mjs` | E1 | The suite's setup (runtime on NDJSON with `--model`, a design and a coding agent, the Developer on `good`), then a mission on the `P3b evals` workflow planned and approved in the window. "Save as eval case" on the succeeded build card saves it into a new suite "Runs"; the Suites tab shows the case with its 7-character base commit and its `DesignBrief` input. |
| `e2-models-candidate.mjs` | E2 | With the Developer on `bad`, a run started in the window with the Models candidate `good`, 3 repeats: "n / 6 trials" while it runs, then Gate pass rate Baseline 0% / Candidate 100% / +100 pts. While trials exist (and after), the Missions list (All), the Desk and the Inbox show none, and the API's mission list, Home, Inbox and approvals name none. |
| `e3-setup-candidate.mjs` | E3 | The project's setup, exported and copied to a fixture folder outside the project with the Developer on `good`. Project → "Import from a folder…" previews it ("model: bad → good"); "Try on evals" opens the Runs form on Setup with that folder. Roles and the setup status are unchanged and no `setup.applied` is logged. |
| `e4-spend-cap.mjs` | E4 | A run with a $0.60 cap at $0.25 a run, started in the window, stops: status `stopped_at_cap`, the reason and the window both read "Stopped at your $0.60 cap", and the trials not yet run are cancelled. |
| `e5-from-your-runs.mjs` | E5 | From your runs has a "Developer on good" row from E1's real mission: 1 run, first-attempt pass 100%, median cost $0.25. No "Developer on bad" row, although the trials scored runs on `bad`. |
| `e6-cleanup.mjs` | E6 | After the runs, `git worktree list` shows no trial worktree and `git branch --list 'tandemise/eval-trial*'` shows nothing in the project, although the trials' execution targets were on such branches. |

The scenarios hand state on through `/tmp/tdm-p3b/state.json`, so run them in order.

## The scripted agent's eval knobs

`run-all.mjs` puts both in the daemon's environment; the generic CLI runtime passes it on to every run.

- `SCRIPTED_FAIL_MODEL=bad`: a run started with `--model bad` writes nothing, so the build's gate fails
  (and a trial on `bad` runs twice before it ends `failed`), but it still reports usage.
- `SCRIPTED_COST_USD=0.25`: every run reports a cost of $0.25.

## Why a design → build workflow

`p0/workflows/p3b-evals.yaml` is a design, then a build gated on `artifact.ChangeSet.exists &&
checks.tests == PASS` that reads the design. The saved case's input (a `DesignBrief`) is not of the
type the step writes (a `ChangeSet`), so the gate can tell a trial that wrote nothing from one that
worked (see `docs/guides/evals.md`, "Reading the scorecard").

## Shared code

- `install.mjs`: the fresh install and window launch (also used by `ui-shots.mjs`). The window reads
  the folder a native "Choose…" dialog would pick from `/tmp/tdm-p3b/pick-directory.txt`
  (`TANDEMISE_TEST_PICK_DIRECTORY`).
- `common.mjs`: the measured runtime, the Developer's model, eval-run polling, and the window gestures
  for the Evals screen, whose query lives in `location.search` beside the hash route.
- `ui-shots.mjs`: Task 8's visual pass over every state of the Evals screen (`/tmp/tdm-p3b-ui`).
