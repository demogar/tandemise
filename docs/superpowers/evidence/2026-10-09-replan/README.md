# Replan the rest: evidence

Spec: [2026-10-09-replan-the-rest-design.md](../../specs/2026-10-09-replan-the-rest-design.md)

## R1–R4: the real window, scripted agent

`node scratch/acceptance/replan/run-all.mjs --keep-going`. Each run uses a
fresh install, the daemon from this checkout, and the desktop window over CDP.
The scripted planner answers a replan prompt with two new steps
(`SCRIPTED_REPLAN`). Result: **ALL PASS, 24/24 checks**. See `REPORT.md`.
The report names build `cbb3dcc` because the feature was still uncommitted
when it ran. That working tree became `257c32c`.

| | What it proves | Shots |
|---|---|---|
| R1 | "Plan the rest again" on the stop card, with a note. The planner sees "Already done" and the note. The card reads "Keeps 1 step already started · replaces 2 steps not started · adds 2 steps", and nothing changes until it is approved. Then the new steps run on intake's output, intake's runs and outputs keep their ids, and the mission completes. | `R1-*.png` |
| R2 | Reject: the mission is as it was, draft is still held, and the stop card is open again. | `R2-*.png` |
| R3 | A paused mission. `POST /plan` (the old re-plan) becomes a replan of the rest instead of deleting intake. Rejected, it goes back to paused. The header offers **Plan the rest again**, and approving it answers the stop card left open, so the new steps run. | `R3-paused-header-plan-the-rest.png` |
| R4 | A step still running: refused with "Wait for 'intake' to finish, or stop it, before planning the rest again.", and nothing changes. | — |

The first runs of this suite found two bugs, both fixed in this PR:

- **R3, first run.** Rejecting a paused mission's replan left it waiting on a
  decided card. Neither PLANNING nor AWAITING_PLAN_APPROVAL could move to
  PAUSED, and the status write was skipped.
- **R3, second run.** A replan from the header left the stop card open, and
  the hold kept the new steps behind it. Approving a replan now answers any
  open stop card.

## R5: the real runtime

Claude Code 2.1.295 as planner and every worker, every step in the window.
The request was "tally --csv crashes when it exports the word counts" on a
small CLI with no `--csv` (Bug investigation workflow). Investigation and fix
ran. The mission was then paused (`R5-claude-paused-header.png`: **Resume |
Plan the rest again | Cancel**), and **Plan the rest again** was pressed.

- Claude planned the rest in 20 s. "Keeps 2 steps already started · replaces 2
  steps not started · adds 2 steps", review → QA, with objectives naming the
  actual fix ("src/cli.js strips the --csv flag from any argument position…").
  See `R5-claude-new-plan-card.png`.
- Approved in the window. Investigate and fix kept their ids. Review and
  verify ran on the fix's branch, and the mission completed with **7 of 7
  verified** (`R5-claude-complete-7-of-7.png`). No shell call was refused
  (`R5-claude-summary.json`; this run carried #42).

The first R5 attempts aimed at an organic stop, and Claude did not set one.
Faced with "CRLF crashes" (it does not), it planned a regression test. Faced
with "--csv crashes", it found the real crash: the flag was read as a file
name. The stop card is reached by the scripted runs. A real model uses
`stop` rarely, as the handoff instructions ask.
