# P13 evidence: skills library

Headline: **4/4 real-app scenarios pass** (N1–N4, 55/55 checks) on a fresh install, built from `feat/p13-skills-library` rebased onto `main` (563f0e6, after #18 merged). Offline: `p13-skills-check` 105/105 (written first and seen failing on the base build: `D.hashSkillFiles is not a function`); `npm run ci` green (37 offline checks).

## How it was run

```bash
npm run build
node scratch/acceptance/p13/run-all.mjs --keep-going          # CDP 9348, home /tmp/tdm-p13
ACCEPTANCE_LINK=/tmp/tdm-p13r0 CDP_PORT=9371 node scratch/acceptance/p0/run-all.mjs [--p1|--p2] --skip-claude --keep-going
ACCEPTANCE_LINK=/tmp/tdm-p13r-p5 CDP_PORT=9372 node scratch/acceptance/p5/run-all.mjs --skip-claude --keep-going   # p6 … p9, p12 likewise
node scratch/acceptance/p10/run-all.mjs --skip-claude --keep-going   # and p11
```

The daemon's skills discovery root is a fixture folder (`TANDEMISE_SKILLS_DISCOVER_DIR=/tmp/tdm-p13/claude-skills`): `tdd` (SKILL.md + reference.md), `house-style`, and `shared-notes`, whose `hosts` file links to `/etc/hosts` (refused). A fourth skill, `lint-rules`, sits in `/tmp/tdm-p13/more-skills/` to import by path. The real `~/.claude/skills` is never read.

Setup shortcut (as P8's and P12's): the scripted agent's runtime profile is PATCHed to `outputFormat: ndjson` and `skillsFolder: true` (it reads `.claude/skills` like Claude Code); N3 switches `skillsFolder` off through the same route to prove the prompt path. `SCRIPTED_ECHO_SKILLS=1` in the daemon's environment makes the scripted agent name the skills it found — in `.claude/skills` and in its prompt — as handoff points the feed shows, and record them with its working folder under `<scratch>/args`. Every setting a person makes is made in the window: imports in the Skills screen's dialog, Update and Delete there, attach / Use v2 / Save role in Team → Roles, New mission, plan approval and the Retry decision in the Inbox. API, SQL, git and the disk are read only as proof.

No real-model scenario: which skills a run gets is decided by the daemon; the scripted agent only shows what it received.

## Scenarios

| # | Scenario | Result |
|---|---|---|
| N1 | Skills → Import skills → Your Claude skills lists the fixture folder; `shared-notes` refused ("hosts links outside the skill folder") and cannot be ticked; Preview of tdd shows "New skill", SKILL.md + reference.md and the SKILL.md; tick two → "Imported tdd v1. Imported house-style v1."; A folder → lint-rules; Library lists all three at v1 | PASS 13/13 |
| N2 | Team → Roles → Developer → Attach tdd (v1) → Save; "P13 skills" workflow (implement pins `house-style@latest`) → drawer "Skills: tdd v1 · bad50479a67c, house-style v1 · b204e7f41a08"; feed "Skills folder: house-style, tdd"; worktree has `.claude/skills/tdd/SKILL.md`; `info/exclude` lists both; no commit has `.claude`; `runs.skills` recorded; Skills says "Used by Developer v1" | PASS 16/16 |
| N3 | Edit tdd's SKILL.md on disk → "Update available" (others not); nothing updated by itself; Update → v2 in Versions; "Developer pins v1 · v2 is available"; Team → Roles offers "Use v2" → Save; N2's drawer still reads tdd v1 · bad50479a67c; runtime without a skills folder → new mission "Skills: tdd v2 · 73c86d77ec4e (in prompt), house-style v1 · … (in prompt)"; feed "Skills in prompt: house-style, tdd"; prompt has "## Skills pinned to this step" with v2's text | PASS 16/16 |
| N4 | "P13 lint": Check lint pins `lint-rules@1` at planning; lint-rules deleted on the Skills screen while Implement runs → Check lint BLOCKED "Skill 'lint-rules' v1 (a8d6b6cfe985) is missing from the skills library. Import it again on the Skills screen, then choose Retry."; no run started; Inbox card "‘Check lint’ needs a skill that is missing" (Retry / Leave blocked); re-import from the folder (same hash); Retry → mission completes, one run with lint-rules v1 | PASS 10/10 |

Content hashes are deterministic, so the same fixture always shows the same short hashes.

## Regression (same build)

| Suite | Result |
|---|---|
| p0 | ALL PASS 14/14 |
| p1 | ALL PASS 14/14 |
| p2 | ALL PASS 11/11 |
| p5 | ALL PASS 5/5 |
| p6 | ALL PASS 6/6 |
| p7 | ALL PASS 5/5 |
| p8 | ALL PASS 5/5 |
| p9 | ALL PASS 4/4 |
| p10 | ALL PASS 3/3 |
| p11 | ALL PASS 4/4 |
| p12 | ALL PASS 4/4 |

One harness flake on the way: a run of the suite on the same build lost its window's page connection at N4's last drawer read (after the mission had completed; "unsettled top-level await" in the scenario process). The next run passed unchanged; REPORT.md is that run.

## Found and fixed while proving it

- The import dialog's button read "Import 0 skills" with nothing ticked; it now says "Tick the skills to import".
- `p12-models-check` spreads a role it read back into `PUT /v1/roles/:id`, which now carries `skills: null`; the request accepts null (clears), like `models`.
- "Retry once more" on an intervention card set the attempt budget to attempts + 1; for a card raised before any attempt (a missing skill) that shrank it to one. It now never lowers the budget.

## Parked

- Planning and refinement runs get no skills (no run record to pin a version on); noted in KNOWN_LIMITATIONS.
- Generic CLI profiles opt in to a skills folder with `skillsFolder: true` in their settings JSON; there is no form field on the Runtimes screen yet.
- Git sources are checked for updates only when Update is clicked (no network on a screen load).
