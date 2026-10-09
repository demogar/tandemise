# What a first real run puts in front of you: evidence

A fresh install on Linux (WSLg) with Claude Code 2.1.295, driven in the
desktop window. Each item below is something the first real mission showed
that read as broken or as internals.

| Before | After | Shot |
|---|---|---|
| Title "Add a --top N option to the tally CLI so it prints only the N most frequent w…" | "Add a --top N option to the tally CLI" (the goal's first clause, 60-character budget) | `after-plan-card.png` |
| Plan card: "First gate: implement passes when artifact.ChangeSet.exists && checks.tests == PASS && diff.files_changed > 0" | "First gate: implement passes when it writes a change set and the tests pass" | `before-plan-card.png`, `after-plan-card.png` |
| Every card "by Runtime" (no agent member staffs a role on a fresh install) | "by Claude Code" for a step, "by Planner" for the plan | `after-feed-by-claude-code.png` |
| Header **Start** beside the card's **Approve** while the plan waited; Start only answered "The plan is waiting for your approval" | **Re-plan** and **Cancel**; Start comes back if no plan card is asking | `after-awaiting-approval-header.png` |
| Runtimes discovery: "Fake Runtime vbuilt-in" | "built-in · on PATH" | `after-discovery-added.png` |
| Runtimes discovery: after **Add**, the row still offered **Add** as if nothing happened | **Configured** and **Add another** | `before-discovery.png`, `after-discovery-added.png` |

The gate sentence comes from `describeGate` (`packages/domain/src/gate.ts`).
It phrases only the facts it knows. An `||`, a negation or an unknown fact
leaves the gate as written, so the sentence never hides a condition.
`scratch/first-run-words-check.mjs` checks the phrases and the title rule.

This run was on this branch alone, without the review/QA shell fix (#42).
Its reviewer's commands were refused again, which confirms #42 on `main` a
third time.
