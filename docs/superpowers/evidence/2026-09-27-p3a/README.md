# P3a evidence: handing work in and back, in the real app

Branch `feat/p3-contributions-and-evals`, product build `1fbde2a`. One uninterrupted run of D1–D8 on a fresh
install: **6 of 8 scenarios pass (D2, D3, D4, D6, D7, D8); D1 and D5 fail on two desktop findings** (F1, F2 in
`REPORT.md`). Product code was not changed.

## How it was run

```bash
npm run build
node scratch/acceptance/p3/run-all.mjs --keep-going   # fresh /tmp/tdm-p3, CDP 9337, window 1360x900
```

The suite, the fake `gh` and the scripted-agent modes it adds are described in
`scratch/acceptance/p3/README.md`. `REPORT.md` is the run's own report (every check with what was observed,
then the findings); `D<n>.json` holds the same per scenario; `run-output.txt` is the run's console.

## Scenarios

| # | Scenario (spec A8) | Result | Evidence |
|---|---|---|---|
| D1 | Mission created with an uploaded spec (plan now, with Done-when): intake runs before planning; the Plan tab shows the spec stage covered by the upload and no product task | **FAIL** 11/12: all but the row's words, which read "product (covered by your upload) · covered by your upload" (F1) | `D1.json`, `D1-new-mission-with-upload.png`, `D1-plan-covered-row.png` |
| D2 | Continue elsewhere on a design task: the card shows "Waiting for your work in Figma"; the timeline shows `task.parked_external`; the Desk counts it | PASS 12/12 | `D2.json`, `D2-continue-dialog.png`, `D2-parked-card.png`, `D2-timeline.png`, `D2-timeline-raw.png`, `D2-desk.png`, `D2-inbox.png` |
| D3 | Hand back a GitHub PR link: a human-authored round lands; the Evidence carries `github.pr` + `git.commit`; downstream consumes that commit | PASS 13/13 | `D3.json`, `D3-hand-back-pr-link.png`, `D3-build-round-2-card.png`, `D3-review-after-hand-back.png` |
| D4 | Hand back an unreadable link: a bare link is refused with "Attach an export"; with an export, the export becomes the Evidence | PASS 11/11 | `D4.json`, `D4-bare-link-refused.png`, `D4-link-with-export.png`, `D4-design-round-2-card.png` |
| D5 | Park a finished step whose next step is ready: the next step waits with "Waiting for 'design' from Figma."; after the hand-back it runs on the handed-back version | **FAIL** 12/13: the window offers no "Continue elsewhere" while the next step waits on its start approval (F2); the rest held, parked through the daemon's route | `D5.json`, `D5-finished-design-card.png`, `D5-build-held-drawer.png`, `D5-hand-back-file.png`, `D5-released-after-hand-back.png`, `D5-build-ran-on-hand-back.png` |
| D6 | Workspace link: renders "Open workspace ↗" and resolves to the local path | PASS 9/9 | `D6.json`, `D6-design-card-open-workspace.png`, `D6-build-card-open-workspace.png`, `D6-reader-open-workspace.png` |
| D7 | Attribution: the hand-back card shows "by You" (responsible left out); the reader shows recorded-by | PASS 7/7 | `D7.json`, `D7-card-by-you.png`, `D7-reader-by-you.png`, `D7-hand-back-recording-for.png`, `D7-card-by-dana.png`, `D7-reader-recorded-by.png` |
| D8 | Feedback with a file: the file appears as an input of the next round | PASS 9/9 | `D8.json`, `D8-composer-with-file.png`, `D8-review-next-round.png`, `D8-artifacts-tab.png` |

## Notes on what the run shows

- **D1** is a real plan: the scripted planner (`SCRIPTED_PLAN_SKIP`) answered the planner prompt that listed the
  intake ProductSpec, the daemon validated it ("Planner produced 6 tasks … on attempt 1."), and materialized the
  SKIPPED placeholder. Nothing was staged in SQLite.
- **D3** uses a fake `gh` for one URL; the pull request's head is a real branch and commit in the acceptance
  repository, and the review's worktree was cut from that branch and contains that commit.
- **D6** records the daemon's answer to the window's own resolve request and hands the renderer an empty path,
  so no Finder window opened; both paths (the Evidence blob and the repository's `README.md`) exist on disk.
- **D7** in a solo project the reader shows "by You" only: the recorder is shown when it differs from the author.
  The second half adds a teammate through the daemon (the window has no "Add person" since 0.4.0) and records a
  hand-back for her in the window: the card and reader then read "by Dana Reyes · recorded by You".
- **D8** the window shows the attachment in the composer and in the mission's Artifacts (Evidence
  `hello-colours.md`); that it was an *input* of round 2 is read from the run's `run_inputs` and the prompt.
