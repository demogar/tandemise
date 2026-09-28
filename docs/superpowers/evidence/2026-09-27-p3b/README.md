# P3b evidence: evals, in the real app

Branch `feat/p3b-evals`, re-run after the final review's fix wave (built from the working tree over
`f575fe9`, so the report says build `f575fe9`). One uninterrupted run of E1–E6 on a fresh install: **all 6
scenarios pass (66/66 checks).** The fix wave added five checks: the form's "This candidate changes
nothing." refusal, the Trials row copy and the candidate heading (E2), and the progress with its cancelled
count and the cap reason on cancelled trials (E4).

## How it was run

```bash
npm run build
node scratch/acceptance/p3-evals/run-all.mjs --keep-going   # fresh /tmp/tdm-p3b, CDP 9338, window 1360x900
```

The suite, the scripted agent's eval knobs and the workflow it adds are described in
`scratch/acceptance/p3-evals/README.md`. The daemon ran with `SCRIPTED_FAIL_MODEL=bad` (a run on the model
`bad` writes nothing, so the build's gate fails) and `SCRIPTED_COST_USD=0.25` (every run reports $0.25).
`REPORT.md` is the run's own report (every check with what was observed); `E<n>.json` holds the same per
scenario; `run-output.txt` is the run's console.

## Scenarios

| # | Scenario (spec B7) | Result | Evidence |
|---|---|---|---|
| E1 | Save as eval case on a succeeded build step, into a new suite: the Evals Suites tab shows the case with its short base SHA and inputs | PASS 14/14 | `E1.json`, `E1-build-card.png`, `E1-save-dialog.png`, `E1-saved.png`, `E1-suites-tab.png` |
| E2 | Role on `bad`, a run with the Models candidate `good`, repeats 3: progress while it runs, then Baseline 0% / Candidate 100% / +100 pts; the Missions list, Desk and Inbox show no trial | PASS 22/22 | `E2.json`, `E2-run-form.png`, `E2-running.png`, `E2-scorecard.png`, `E2-missions-during.png`, `E2-desk-during.png`, `E2-inbox-during.png`, `E2-missions-after.png`, `E2-desk-after.png`, `E2-inbox-after.png` |
| E3 | Setup as code → a fixture folder → Try on evals: the Runs form is prefilled with that folder; the project's roles are unchanged and no setup was applied | PASS 11/11 | `E3.json`, `E3-setup-preview.png`, `E3-runs-form-prefilled.png` |
| E4 | Spend cap $0.60 at $0.25 a run: the run shows "Stopped at your $0.60 cap" | PASS 8/8 | `E4.json`, `E4-run-form.png`, `E4-stopped-at-cap.png` |
| E5 | From your runs: a role × model row with first-attempt pass rate and cost from E1's real mission | PASS 5/5 | `E5.json`, `E5-from-your-runs.png` |
| E6 | After the runs, `git worktree list` and `git branch --list 'tandemise/eval-trial*'` in the project show none | PASS 6/6 | `E6.json` (the `git` output is in its notes and in `REPORT.md`) |

## Notes on what the run shows

- **E1**: the mission was typed and planned in the window, and its plan was approved from the Inbox. The case
  was saved from the build's feed card. Its base (`ba4a4cd`) is a commit in the project, and its one input is
  the design's `DesignBrief`. The workflow (`P3b evals`: design → gated build) is chosen so that the case's
  input type differs from the step's output type. The build's `artifact.ChangeSet.exists` gate can then tell
  the variants apart (see `docs/guides/evals.md`, "Reading the scorecard").
- **E2**: the scorecard says "+100 pts", not "+100%". It shows differences in pass rates as percentage points.
  Baseline: each `bad` trial ran twice ($0.50) and ended `failed`. Candidate: each `good` trial passed first
  time ($0.25). That makes $2.25 in all. The hidden-trial checks ran twice: once while three trial missions
  existed (DRAFT, COMPLETE and FAILED) and once after all six ended. Both times the Missions list's All
  count was 1 (E1's mission).
- **E3**: the setup was exported through the daemon and copied to `/tmp/tdm-p3b/setup-fixture`. The project was
  then put back to its committed files. The preview read "Developer · model: bad → good". After "Try on evals"
  the Developer is still on `bad`, the setup status still shows only the export, and the daemon log has no
  `setup.applied` (it does have `setup.exported`, which is the control).
- **E4**: the run spent $0.75 against the $0.60 cap. The cap is checked between trials, so the trial already
  running when the cap was crossed finished. The two trials that had not started were cancelled.
- **E5**: the summary has exactly one row, Developer on `good` (1 run, 100%, $0.25). The database holds 12 scores
  from trial runs, and none of them count here.
- **E6**: the trials' execution targets were on `tandemise/eval-trial-*` branches and are all `RELEASED`. The
  only worktree left in the project is E1's own build (`tandemise/add-a-hello-banner-to-the-page/…`).

## Observations from the first run, fixed in the final fix wave

- The scorecard's Trials row read "3 completed / 0 blocked / 3 failed" for a side of 3 trials, as if there
  were 6. It now reads "3 ran · 0 passed · 3 failed · 0 blocked" (`E2-scorecard.png`), with "· E errored"
  added when a trial failed with no score.
- A run stopped at its cap showed "4 / 4 trials" in Progress, because cancelled trials counted as done. It
  now reads "2 / 4 trials · 2 cancelled" (`E4-stopped-at-cap.png`), and the cancelled trials carry the
  reason "Stopped at your $0.60 cap".
- The candidate heading now reads "Candidate, against the setup when this run started", which stays true
  for an old run.
