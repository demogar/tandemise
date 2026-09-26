# Evidence: refinement notes are named after their mission

Fix slice, no spec or new suite. The P6 real-app suite was run with
`--skip-claude` on a fresh home (`ACCEPTANCE_LINK=/tmp/tdm-fix CDP_PORT=9362
node scratch/acceptance/p6/run-all.mjs --skip-claude`): **ALL PASS, 6/6**.

F1 gained two checks. After Refine, the window opens `#/artifacts/<id>` and the
Refinement reads `Refinement: <mission title>` in both the Artifacts list and
the reader header. The SQL check confirms the stored title is the mission's
title, not the one the agent wrote. The scripted agent still writes
`Refinement: Scripted work` as its own title and body heading. That heading is
the agent's prose, so it shows below the handoff, and the daemon leaves it as written.

- `REPORT.md`: the full run (F1–F6).
- `F1.json`: F1's checks with what was observed.
- `F1-refinement-note-title.png`: the reader after the fix.

Offline: `node scratch/p6-ready-check.mjs` has 77 checks and all pass. The two new
title checks failed before the fix (`noteTitle` was `Refinement: Scripted work`).
