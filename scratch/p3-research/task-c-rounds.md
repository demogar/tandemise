You are a research subagent working in /Users/you/projects/tandemise. Do NOT modify any files. Use only read/grep/find/ls/bash.

Goal: produce a concise summary of the P2 feedback/rounds design and implementation, focusing on what P3 ("outside contributions" — uploads and external hand-backs) builds on.

Investigate:
1. Read docs/superpowers/specs/2026-09-14-p2-feedback-rounds-design.md fully. Summarize its decisions relevant to external contributions: rounds, feedback items, human-authored rounds, a person completing a task, wake rules, parking/resuming.
2. In packages/application, find how feedback items and rounds are modeled and stored (grep "feedback", "round", "run_inputs", "citation"). Summarize feedback item fields/statuses and how a round starts.
3. How a person completes a human task: grep "completeTask" in packages/application/src (mission-service.ts or similar). Summarize what a person-authored contribution records (author, handoff, artifacts).
4. How "park" / "continue elsewhere" is handled today: grep "AWAITING_EXTERNAL", "park", "external", "resume", "session" in packages/application and packages/runtime-*. Summarize any existing external-work parking.
5. Evidence/snapshot: how run_inputs and Evidence capture consumed versions (grep "run_inputs", "Evidence", "snapshot").

Write your findings to stdout as Markdown with citations, under ~1500 words. End with an "Implications for P3" section.
