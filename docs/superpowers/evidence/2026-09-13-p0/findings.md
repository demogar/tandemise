# P0 acceptance: findings from the real app

| # | Scenario | What I saw | Severity | Status |
|---|---|---|---|---|
| F1 | A1 | Status reason reads "Waiting for Demostenes Garcia G.." (double period when the name ends with ".") | Minor | fixed |
| F2 | A1 | Solo owner, zero config: their own human step shows "Up for grabs · You can claim it" and a Claim button. Before P0 it said "Yours". A solo person should not have to claim their own work | Important (solo UX regression) | fixed |
| F3 | A1 | A person's completed step (docs → Evidence) is stored as `application/octet-stream`, so the Artifacts reader says it "cannot be shown inline". The text the person typed can't be read in the app | Important | fixed |
| F4 | A1 | The blocked banner shows a raw runtime id ("rt_01m2e9wb0ac0njj73p1b: missing capabilities: mcp") instead of the runtime's name | Minor (pre-existing) | fixed |
| H1 | A1 | Harness: the scripted profile lacked `mcp`, which the release step's github.pr.create needs. Fixed in setup.mjs | harness | fixed |
| F5 | A1 | Generic CLI adapter ignores the profile-level `capabilities` override (the API documents it as overriding the adapter) and only reads `settings.capabilities` | Minor (pre-existing, outside P0) | fixed |
| F6 | STAFF | Picking "Anyone from a group" preselects You and Maria (unrelated to QA) rather than people whose roles include QA (Bo). A click right after changing the preset was also lost once | Minor | fixed |
| F7 | A7 | "Claim for" (and "Done by") list every person (You, Maria) instead of only the pool (Ana, Bo). Picking someone outside the pool leads to a server CONFLICT | Important (UX) | fixed |
| F8 | A10 | An escalated row reads "For Ana Ruiz, Maria Lopez and 1 more" where "1 more" is you; it should name you | Minor | fixed |
| F9 | A15 | When an agent asks a question (ask_human), the `approval.requested` event is recorded with no actor. Every other event in the run carries the agent. The asker should be the actor | Minor | fixed |
| F10 | A11 | Remove confirmation reads "Their 1 agent stop taking work…" (should be "Their agent stops…" / "Their 2 agents stop…") | Minor | fixed |
| F11 | A16 run | A task staffed to an agent that became inactive (owner removed) silently fell back to ALL enabled runtimes (here the real Claude Code profile). It spent real usage and asked an unexpected question instead of stopping and asking the responsible person | Important | fixed |
| F12 | final run A3 | After I1, a person's own step whose role has "responsible approves" asks that same person to approve their own work (author = only reviewer). Self-approval adds no oversight and is noise | Important (UX) | fixed |
| F13 | final run A17 | The top-of-team owner cannot save their own member drawer: every member reports "reporting lines form a cycle", so oversight can't be set | Important | fixed |
| F14 | final run A17 | Choosing "Custom" in the staffing drawer snaps back to the matching preset (e.g. "A person does it"), so you can't reach the full editor to add a review to a preset-shaped staffing | Important (UX) | fixed |
| F15 | final run A17 | The lead sign-off card after a skipped self-review says "Bo Chen approved 'spec'"; Bo did the work and approved nothing | Minor (wording, misattribution) | fixed |
