# P0 acceptance: proven in the real app

**Final build `c573415`: 20/20 scenarios, 102 checks, one uninterrupted run.** The run started from a fresh install and used the real desktop window and daemon. A15 ran on the real Claude Code runtime. The full run log is in [REPORT.md](REPORT.md).

## How it was run

`scratch/acceptance/p0/run-all.mjs` does the whole run:

- It creates a throwaway `TANDEMISE_HOME` and a git project with the `p0` workflow (spec, design, architecture, build, docs, finance, qa, release). Everything runs behind a short `/tmp` symlink because macOS limits socket paths.
- It starts the daemon from this branch's build and launches Electron with its own user-data-dir, driven over CDP.
- The model is replaced by `scripted-agent.mjs`, which writes schema-valid artifacts, so every run is deterministic. The exception is A15, which runs on real Claude Code.
- Every decision is made **in the window**: approve, record for, claim, done by, staffing presets, drawers. The API is used only to read state as proof, and for three setup shortcuts: escalation windows shorter than the UI's one-hour minimum, the Claude profile, and concurrency.

Re-run it with `node scratch/acceptance/p0/run-all.mjs` (add `--skip-claude` to skip the real Claude scenario).

## Scenarios

| # | What a person does | Proven |
|---|---|---|
| A1 | Solo, no setup: a mission end to end | The app looks as it did before P0. Your own step is simply yours; everything shows "Responsible You". Your text is readable. |
| TEAM | Builds a team in the Team screen: a lead, a designer, an engineer, and agents owned by people | Owners, reporting lines, runtimes, presets. Editing one role never changes another (A14). |
| PLAN | Opens a mission before anything runs | The plan already says who will do each task and who answers for it. |
| A2 | AI drafts, you approve | Addressed to you, under For me. Evidence shows the title, not an id. Approving releases the work. |
| A3 | Does a stage themself | The step is assigned to you, attributed to you, and nobody asks you to approve your own work. |
| A4 | Designer's agent does design | Ana is asked and her lead is not. It sits under Everyone as "For Ana Ruiz", not under your For me. |
| A5 | Lead signs off | Once Ana approves, a "Lead sign-off" card goes to Maria. Design waits for both. |
| A6 | Records Ana's decision | The record reads "by Ana Ruiz · recorded by You". |
| A7 | Pool of two | "Claim for" lists only Ana and Bo. Claiming as Bo makes him responsible, and his work is recorded on his behalf. |
| A8 | AI drafts, you check later | Nothing waits. "Needs changes" flags the task and does not stop work already started. |
| A9 | Safety net | A low-risk task passes with the skip on the timeline. An external side effect needs approval, and a release-class decision asks for confirmation. |
| A10 | Nobody answers | Ana → Maria after about a minute → you. The Inbox says "Escalated to you". |
| A11 | Removes a person | Their agent is inactive but kept, and their past decisions keep their name. New work waits for a person instead of running on any runtime. |
| A12 | Changes staffing mid-mission | A task already READY keeps its staffing. A task not yet READY picks up the change. |
| A13 | Code, finance, release | The same rules apply beyond design: ChangeSet by Bo's agent, Bo responsible. |
| A15 | Designer's agent on real Claude Code | Claude's question and review go to Ana only. Every run event carries Ana's agent. |
| A16 | Pool of one, nobody responds | Escalates to the owner, who takes it over from the Inbox. |
| A17 | A person's own work with review | Bo isn't asked to approve his own spec. You sign off as his lead, and the card says "Bo Chen did 'spec' themselves". |
| A18 | Hands a waiting task to someone else | "Change" moves docs from Bo to Maria. A task that already ran refuses the change. |

## What only the real app caught

The 355 offline checks passed throughout. The real window found the bugs listed in [findings.md](findings.md), all fixed on this branch, including:

- the owner couldn't save their own member drawer;
- "Custom" snapped back to the preset, so reviews couldn't be added;
- people were asked to approve their own work;
- work whose agent went inactive silently ran on every runtime, including real Claude;
- a solo user had to claim their own step;
- a person's text was unreadable;
- "Claim for" listed people who couldn't claim;
- a sign-off card claimed someone had approved something they only did.
