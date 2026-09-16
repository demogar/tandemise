You are an independent code reviewer working in /Users/you/projects/tandemise (a TypeScript monorepo: Electron + React desktop app `apps/desktop`, daemon `apps/daemon`, and domain/application packages).

Your job: do a FULL, critical code review of every uncommitted change in this working tree, exactly as a senior reviewer would before merging. Be independent and skeptical — do not rubber-stamp. You are reviewing code that the main agent wrote; find real problems, not praise.

Scope — everything that is not yet committed:
1. Run `git status` and `git diff` to see modified tracked files.
2. Read every untracked file that would be added:
   - apps/desktop/src/renderer/src/lib/flags.ts (new feature-flag module)
   - docs/superpowers/specs/2026-09-16-p3-outside-contributions-design.md
   - docs/superpowers/plans/2026-09-16-p3-outside-contributions.md
   - scratch/team-ui-check.mjs
   - scratch/p3-baseline-check.mjs
   - scratch/p3-research/* (research notes; review lightly for consistency only)
3. The modified files are:
   - apps/desktop/src/renderer/src/lib/staffing.ts
   - apps/desktop/src/renderer/src/screens/NewMission.tsx
   - apps/desktop/src/renderer/src/screens/team/MemberForm.tsx
   - apps/desktop/src/renderer/src/screens/team/StaffingEditor.tsx
   - apps/desktop/src/renderer/src/screens/team/Team.tsx
   - docs/superpowers/specs/2026-09-13-collaboration-roadmap.md

What the changes claim to do:
- Remove the "+ add person" flows (button + drawer `new-person` target) so the team is "you + your agents"; add an internal feature-flag structure (`lib/flags.ts`).
- Hide the `person` and `pool` staffing presets behind that flag via `STAFFING_PRESET_OPTIONS`, and reword one label.
- Add a P3 design spec + implementation plan for "outside contributions" (uploads, external hand-backs, snapshots).
- Add real-app verification scripts (`team-ui-check.mjs`, `p3-baseline-check.mjs`).

Review checklist — investigate each and report findings with file:line and severity (P0 blocker / P1 should-fix / P2 nit):
A. TypeScript correctness: run `cd apps/desktop && npm run typecheck` and report the result. Also `npx tsc -b tsconfig.build.json` from the repo root if quick. Look for unused imports, dead code, missing types, broken discriminated unions (the `MemberTarget` type changed).
B. Correctness of the feature flag: is `STAFFING_PRESET_OPTIONS` computed once at module load correctly? Any place that still renders the full `STAFFING_PRESETS` (i.e. leaks the removed presets)? Is `flag()` used correctly?
C. Regression risk from removing `new-person`: grep the repo for `new-person`, `createPerson`, `listPeople`, `personId`, `needsName`, `unseated`, `seated` — is anything left dangling? Is the edit flow for a *person* (you) still intact and type-safe?
D. The docs: does the implementation plan's "File map" and "Tasks" match the spec's sections and the actual code file paths cited (spot-check several)? Are there any factual claims in the spec/plan that contradict the code (e.g. migration numbers, function names, field names)?
E. The two scratch check scripts: are they runnable? Do they clean up child processes correctly? Any obvious bugs in the CDP/WebSocket handling?
F. Anything else a careful reviewer would flag (copy, consistency, boundary/layering rules per the repo's `npm run check:boundaries`/`check:design` — run them if quick).

Output: a Markdown report with a one-line verdict at the top (APPROVE / REQUEST CHANGES), then findings grouped by severity, each with file:line and a concrete suggested fix. End with an explicit list of "must fix before merge" items (or "none").
