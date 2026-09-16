You are a research subagent in /Users/you/projects/tandemise. Do NOT modify files. Use read/grep/find/ls/bash only.

Goal: report the EXACT API/contract/persistence shapes and wiring needed to write an implementation plan for P3 (uploads + external hand-backs + snapshots).

Investigate and report, with exact interface names, function signatures, and file paths:
1. packages/api-contract/src/requests.ts — list the request interfaces + zod schemas (createMissionRequest, CompleteTaskRequest, AddMemberRequest, etc.). Show how a new field (`uploads`) on an existing request, or a new request type (a hand-back request), would be added, citing the existing patterns.
2. packages/api-contract/src/views.ts — the artifact/mission/task view shapes; note where handoff, links, superseded, round, attachments already appear.
3. apps/daemon/src/routes.ts — how routes are registered (the pattern for POST /v1/workspaces/:id/missions etc.), and the existing mission/task/artifact/feedback routes. Show where a hand-back or upload route would slot in.
4. apps/desktop/src/renderer/src/lib/daemon.ts — the DaemonClient request helpers (#get/#request) and one example method (e.g. completeTask, createMission, giveFeedback). Show how to add a client method.
5. packages/persistence — artifact-repository.ts (how an artifact is created with sourceRefs/ExternalRef and supersedes; the exact method signatures), migrations/index.ts (how migrations are appended), and confirm whether feedback.attachments and the stored plan JSON already accommodate P3 without a new table.

Write findings to stdout as Markdown with file-path + line citations where possible, under ~1800 words.
