You are a research subagent in /Users/you/projects/tandemise. Do NOT modify files. Use read/grep/find/ls/bash only.

Goal: report EXACT engine/service entry points needed to write an implementation plan for P3 (uploads + external hand-backs + snapshots).

Investigate and report with exact function names, signatures, and file paths:
1. Planning: packages/application/src/services/planning-service.ts and packages/application/src/planning/{prompt.ts,parse.ts,materialize.ts}, plus packages/domain/src/plan.ts. How planning is triggered and validated/materialized; where `preexistingArtifacts` is used in validateMissionPlan; how the planner prompt is built (so an intake + "skipped" instruction would be added); how the plan shape is defined/parsed.
2. packages/application/src/services/mission-service.ts — the full `completeTask` flow (guards, actor resolution, artifact writes, supersedes, onPersonCompleted, reviews.onRoundPassed, final status) so a hand-back can generalize it. Also how `createMission` works and where uploads would be injected before planning.
3. packages/application/src/engine/scheduler.ts — `#startWait`, the AWAITING_EXTERNAL re-adoption logic, and how a parked non-`wait` task would be handled/re-adopted.
4. packages/application/src/engine/{harvester.ts,task-executor.ts} — how agent outputs are harvested and written (artifact store write, artifacts.create with supersedes/attribution), the exact function that writes a harvested artifact, and where an "intake task" output flows.
5. packages/application/src/engine/feedback-rounds.ts and services/feedback-service.ts — record/beginRound/openRound/onPersonCompleted/onRoundLanded signatures and what they do, so a hand-back can be modeled as a human-authored round.
6. packages/application/src/support/identity.ts — how authorId/recordedBy/onBehalfOf/actorFor are resolved.

Write findings to stdout as Markdown with file-path citations, under ~1800 words.
