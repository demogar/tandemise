# P0 refresh evidence: the real-app suite for the agents-only team

Headline: **the whole P0 suite passes again: 14/14 scenarios, 81/81 checks.** It ran without
`--keep-going` on a fresh install of `main` (940d0c6), with this branch's scenario files. On `main`
the suite passes A1 and then stops at s02 with `no member Bo Chen`. 0.4.0 deleted "Add person",
so every scenario after A1 that needed Maria Lopez, Ana Ruiz or Bo Chen failed the same way.

No product code changed. None of the scenarios exposed a product bug.

## How it was run

```bash
npm run build
node scratch/acceptance/p0/run-all.mjs --skip-claude            # CDP 9333, /tmp/tdm-p0; the evidence run
node scratch/acceptance/p0/run-all.mjs --p1 --skip-claude --keep-going
node scratch/acceptance/p0/run-all.mjs --p2 --skip-claude --keep-going
node scratch/acceptance/p5/run-all.mjs --skip-claude --keep-going   # and p6 through p11
```

`REPORT.md` is the report from the evidence run. `<ID>.json` holds the checks and observed values
for each scenario, and `<ID>-<what>.png` are the window's screenshots. The `regression-*` folders
hold the report and JSON from each of the other suites.

## Decisions

The feature flag `FEATURE_FLAGS.agentsOnly` is a compile-time constant in the renderer. There is no
env var or setting to change it. It only hides the people presets. "Add person" and its drawer were
deleted outright. So option (b), running a scenario with the flag enabled, isn't available for any
scenario. Each one was either (a) rewritten or (c) retired.

| Scenario (file) | Old behaviour | Decision | Now proves |
|---|---|---|---|
| TEAM (s02) | Adds 3 people and 6 agents; sets presets, including a QA pool of people; A14 | (a) rewrite | Adds 7 agents in the window, all owned by you. No "Add person", the tab reads "You & agents", the Owner picker offers only you, the preset picker offers no people presets. Sets the presets. A14: re-ordering QA's agents in its drawer changes no other role, and editing an agent's title changes no staffing. |
| PLAN (s03) | Plan shows the Coding agent with Bo responsible, and the Figma agent with Ana | (a) rewrite | Plan shows the Coding, Design and QA agents, each with "Responsible You". |
| A2 (s03) | AI drafts, you approve | kept | Unchanged. |
| A4 (s03) | Ana's agent's design is Ana's to approve; her lead isn't asked | (c) retire → A2d | Needs a teammate. **A2d** proves the agents-only version: your Design agent's work is addressed to you only, listed "For you" under For me, offers no "Recording for", and is decided by you. |
| A6 (s03) | Record Ana's approval on her behalf | (c) retire | "Recording for" someone else needs someone else. A2d asserts it isn't offered on your own decision. |
| A8, A9a, A3, A9b (s03) | Check later with the impact dialog; the safety net; your own step; the release approval | kept | Unchanged. |
| A7 (s03) | A pool of Ana and Bo; claimed as Bo; "Claim for" / "Done by" | (c) retire → A7q | The pool preset is hidden. **A7q**: QA runs on the agent staffed first (the QA agent), with no one able to claim it, and its QAPlan is by that agent. |
| A13 (s03) | ChangeSet by Bo's Coding agent, Bo responsible | (a) rewrite | ChangeSet by your Coding agent, you responsible. FinanceReport and ReleaseCandidate are unchanged. |
| A5 (s04) | Maria's "Sign off on delegated work": a second card after Ana approves | (c) retire | A lead's sign-off needs a person reporting to a lead. |
| A10 (s04) | An unanswered design approval climbs Ana → Maria → you | (c) retire | Escalation climbs the reporting tree. The only addressee is you, the top of the tree, so there is nowhere to climb. |
| A12 (s05) | Mid-mission, Finance goes to "A person does it" and QA to "AI only" | (a) rewrite | Mid-mission, in the window, Finance gets "AI drafts, responsible approves" and QA is handed to the Architecture agent. Finance was already READY, so it keeps its snapshot: it runs on the Finance agent and still asks no approval, because its safety net is intact. QA was still PENDING, so it follows the change: `wouldBe` names the Architecture agent, and it runs on it. |
| A15 (s06) | Ana's agent on real Claude Code; the question answered as Ana | (a) rewrite, **not run** | Your Design agent on Claude Code. The question and review go to you, and it's put back on the scripted runtime afterwards. `--skip-claude` skips it, as on every run of this suite. |
| A11 (s07) | Remove Ana: her agent goes inactive and design waits for a person | (a) rewrite | Remove the Design agent in its drawer. The confirmation says its past work keeps its name. It's hidden, behind "Show 1 removed member", which shows it as "Removed". Its past DesignBrief still names it. A new mission's design goes to you as a person step, not to the removed agent or to any runtime. **Restore** in its drawer puts design back on it. |
| A16 (s04b) | A pool of one (Bo) nobody answers opens up to the owners | (c) retire | Needs a pool of people. |
| A17 (s08) | Bo's own spec skips his self-review and goes to you for the lead's sign-off | (c) retire | Needs a person other than you. |
| A18 (s08) | docs, waiting for Bo, is handed to Maria from its Change drawer; a task that ran returns 409 | (a) rewrite | qa, which hasn't started, is handed to the Release agent from its Change drawer for that task only. The drawer shows "override", the project staffing is unchanged, and qa runs on the Release agent. spec has already run, so it returns 409 and its drawer has no "Change". |

The retired rules are still in the daemon, and the offline `staffing-check` still covers them in
its pool, escalation-chain, sign-off and inactive-member sections. They aren't reachable from the
window, because the window can't create a second person. The suite README
(`scratch/acceptance/p0/README.md`) lists them with one line each.

## Results

| Scenario | Result |
|---|---|
| A1 — Solo, no configuration | PASS 11/11 |
| TEAM — Build you + your agents and their staffing in the Team screen (with A14) | PASS 16/16 |
| PLAN — Before anything runs, the Plan says who will do each task | PASS 3/3 |
| A2 — AI drafts, you approve | PASS 5/5 |
| A2d — Your agent's design is yours to approve | PASS 5/5 |
| A8 — AI drafts, you check later | PASS 7/7 |
| A9a — Safety net: a low-risk task needs no approval | PASS 2/2 |
| A3 — You do a stage yourself | PASS 2/2 |
| A7q — QA runs on the agent staffed first | PASS 2/2 |
| A9b — Safety net: a task with an external side effect needs an approval | PASS 3/3 |
| A13 — Beyond design: code, finance and release follow the same rules | PASS 3/3 |
| A12 — Staffing change mid-mission | PASS 6/6 |
| A11 — Remove an agent | PASS 8/8 |
| A18 — Hand a task that has not started to another agent | PASS 8/8 |

A shakeout run before the evidence run found one wrong expectation in A2d. It expected
`recordedBy` to be empty on your own decision, but the daemon records you as both the decider and
the recorder. The check now asserts that the decision is on your own behalf.

## Regression (same build)

The other suites ran on the same build to show that nothing else changed:

| Suite | Result |
|---|---|
| p1 | ALL PASS 14/14 |
| p2 | ALL PASS 11/11 |
| p5 | ALL PASS 5/5 |
| p6 | ALL PASS 6/6 |
| p7 | ALL PASS 5/5 |
| p8 | ALL PASS 5/5 |
| p9 | ALL PASS 4/4 |
| p10 | ALL PASS 3/3 |
| p11 | ALL PASS 4/4 |
