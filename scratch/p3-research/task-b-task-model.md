You are a research subagent working in /Users/you/projects/tandemise. Do NOT modify any files. Use only read/grep/find/ls/bash.

Goal: produce a concise summary of the mission/task domain model, statuses, and planning flow, to feed a design spec about "outside contributions" (uploads and hand-backs).

Investigate:
1. Task status enum(s): grep packages/domain and packages/application for task status values (PENDING, READY, RUNNING, SUCCEEDED, FAILED, BLOCKED, CANCELLED, AWAITING_APPROVAL, AWAITING_HUMAN, AWAITING_INPUT, AWAITING_EXTERNAL, SKIPPED, etc.). List all statuses and their meanings. Specifically report whether "AWAITING_EXTERNAL" exists anywhere.
2. The mission/task/run/round data model: summarize key entities and fields (mission, task, run, round, member, artifact) from packages/domain.
3. Planning: how a plan is produced and materialized (packages/application/src/planning/* — prompt.ts, presets.ts, parse.ts, materialize.ts). Can the planner skip a stage? How are roles/steps declared? How is repository selection handled?
4. How external input reaches a mission/task today: mission creation request fields (goal, constraints, successCriteria, workflowInputs, baseBranch, repositoryId), and whether any "upload" or file attachment exists. Grep for "upload", "attach", "file" in apps/desktop and packages/application.
5. Any existing "intake" or "hand-back" concept: grep for "hand-back", "handback", "external", "park", "intake".

Write your findings to stdout as Markdown with file-path citations, under ~1500 words. End with an "Implications for P3" section.
