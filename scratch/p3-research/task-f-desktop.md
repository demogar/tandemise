You are a research subagent in /Users/you/projects/tandemise. Do NOT modify files. Use read/grep/find/ls/bash only.

Goal: report the EXACT desktop UI surfaces and the real-app acceptance harness, needed to write an implementation plan for P3 (uploads + external hand-backs).

Investigate and report with exact component/function names and file paths:
1. apps/desktop/src/renderer/src/screens/NewMission.tsx — the form structure (fields, create mutation, submit) and where an upload/file+link control would be added before submission.
2. apps/desktop/src/renderer/src/components/RequestChanges.tsx (and any composer host in App.tsx) — where feedback is entered and where attachments would attach.
3. apps/desktop/src/renderer/src/components/HandoffCard.tsx and screens/mission/FeedPane.tsx — the card structure and its action buttons, where "Continue elsewhere" / "Hand back" actions would go.
4. Link rendering: components/HandoffCard.tsx and screens/artifacts/ArtifactReader.tsx — how handoff `links` are rendered (the http(s) filter and openExternal call), so `kind: 'workspace'` rendering can change.
5. screens/mission/PlanPane.tsx — how plan tasks/rows render, where a "covered by your upload" skipped row would appear.
6. scratch/acceptance/p0 — run-all.mjs, setup.mjs, scripted-agent.mjs, and the shared lib helpers: how the harness drives Electron over CDP, how scenarios assert DOM state, and how the scripted agent writes artifacts (so a P3 controller can extend it).

Write findings to stdout as Markdown with file-path citations, under ~1800 words.
