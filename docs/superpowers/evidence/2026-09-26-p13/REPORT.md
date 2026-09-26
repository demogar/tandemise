# P13 acceptance report

Run: 2026-09-26T21:39:28.841Z · build 17329a6 · fresh install at /var/folders/dh/glpvvh110393gdzjc_v2x1sr0000gn/T/tdm-p13-run-muiws2pb
Result: **ALL PASS** (4/4 scenarios)

| Scenario | Result | Checks |
|---|---|---|
| N1 — Import skills from your Claude skills folder and from a folder, after a preview | PASS | 13/13 |
| N2 — A role pins a skill; the run gets it in its worktree, recorded by version and hash, never committed | PASS | 16/16 |
| N3 — An edited source shows "Update available"; updating and moving the role are explicit; old runs keep their hash | PASS | 16/16 |
| N4 — A pinned skill that is missing refuses the run with its name; re-import and Retry finish it | PASS | 10/10 |

## N1 — Import skills from your Claude skills folder and from a folder, after a preview

- ✅ Skills (sidebar) starts empty and says what to do — `"Skills\nSkills you already use, pinned to the roles that need them. Every run gets exactly the version it was pinned to.\nImport skills\nNo skills yet\n\nImport the skills you already use - from ~/.claude/skills, a fold`
- ✅ the dialog looks in the fixture folder, not the real home — `"Import skills\n\nA skill is a folder with a SKILL.md. You see its files before it is imported, nothing in it is run, and each import is kept as a numbered version your roles pin.\n\nYour Claude skills\nA folder\nA git r`
- ✅ it lists house-style, shared-notes and tdd — `"Found: house-style|Found: shared-notes|Found: tdd"`
- ✅ shared-notes is refused: "hosts links outside the skill folder" — `"Import skills\n\nA skill is a folder with a SKILL.md. You see its files before it is imported, nothing in it is run, and each import is kept as a numbered version your roles pin.\n\nYour Claude skills\nA folder\nA git r`
- ✅ and its box cannot be ticked — `true`
- ✅ the preview says "New skill" and lists SKILL.md and reference.md — `"tdd\nbad50479a67c\n2 files · 248 B\n\nWrite the failing test first, then the code.\n\nFrom /tmp/tdm-p13/claude-skills/tdd\n\nNew skill\n\nFiles\nSKILL.md (189 B)\nreference.md (59 B)\nSKILL.md\nTest first\nWrite a test `
- ✅ and shows the SKILL.md itself — `"tdd\nbad50479a67c\n2 files · 248 B\n\nWrite the failing test first, then the code.\n\nFrom /tmp/tdm-p13/claude-skills/tdd\n\nNew skill\n\nFiles\nSKILL.md (189 B)\nreference.md (59 B)\nSKILL.md\nTest first\nWrite a test `
- ✅ "Imported tdd v1. Imported house-style v1." — `"Imported tdd v1. Imported house-style v1."`
- ✅ A folder: the preview named lint-rules as a new skill — `"lint-rules\na8d6b6cfe985\n1 file · 119 B\n\nThe lint rules we keep.\n\nFrom /tmp/tdm-p13/more-skills/lint-rules\n\nNew skill\n\nFiles\nSKILL.md (119 B)\nSKILL.md\nLint rules\n\nNo unused imports. No commented-out code."`
- ✅ the Library lists house-style, lint-rules and tdd, each v1 — `[{"name":"house-style","text":"house-style\nHow our copy reads.\nv1 · 1 file · 138 B"},{"name":"lint-rules","text":"lint-rules\nThe lint rules we keep.\nv1 · 1 file · 119 B"},{"name":"tdd","text":"tdd\nWrite the failing `
- ✅ with their descriptions — `"tdd\nWrite the failing test first, then the code.\nv1 · 2 files · 248 B"`
- ✅ proof (API): three skills, one version each, hashes recorded — `[["house-style","b204e7f41a08"],["lint-rules","a8d6b6cfe985"],["tdd","bad50479a67c"]]`
- ✅ proof (SQL): content stored once per hash under the home
- screenshot: `N1-preview.png`
- screenshot: `N1-library.png`

## N2 — A role pins a skill; the run gets it in its worktree, recorded by version and hash, never committed

- ✅ Team → Roles → Developer has a Skills section with none attached — `"Skills\n\nEvery run of this role gets these skills at the version shown. A step in a workflow file can add its own.\n\nNo skills attached. Import skills on the Skills screen, then attach them here.\n\nChoose a skill…\nh`
- ✅ after Attach: "tdd v1" — `"Skills\n\nEvery run of this role gets these skills at the version shown. A step in a workflow file can add its own.\n\ntdd v1\nWrite the failing test first, then the code.\nRemove\nChoose a skill…\nhouse-style (v1)\nlin`
- ✅ proof (API): the Developer role pins tdd v1 — `[{"name":"tdd","version":1}]`
- ✅ the mission completes — `"COMPLETE"`
- ✅ implement drawer: "Skills: tdd v1 · bad50479a67c, house-style v1 · b204e7f41a08" — `"Skills: tdd v1 · bad50479a67c, house-style v1 · b204e7f41a08"`
- ✅ its gate read skills.loaded and skills.missing — `"Implement\nRetry with more access\nSucceeded\nDeveloper\nScripted agent\nModel: runtime default\nn2-hello-page-muiwt1s6-implement\nworktree isolation\n\nSkills: tdd v1 · bad50479a67c, house-style v1 · b204e7f41a08\n\nDo`
- ✅ the review step pins none: no Skills line — `""`
- ✅ the agent's handoff (feed) says "Skills folder: house-style, tdd" — `"msn_01m3ftbfmd4hjdves21c\nMissions\np13-skills\nN2 hello page muiwt1s6\nN2 hello page muiwt1s6\nComplete\nFeed\nPlan\n2\nTimeline\nArtifacts\n3\nChecks & Gates\nMetrics\nDone when\n0 of 1 verified\nU1\nThe acceptance sc`
- ✅ proof (agent record): it found house-style and tdd in .claude/skills — `{"folder":["house-style","tdd"],"prompt":[],"cwd":"/tmp/tdm-p13/home/workspaces/ws_01m3fta23r1f0x29apgy/missions/msn_01m3ftbfmd4hjdves21c/worktrees/n2-hello-page-muiwt1s6-implement-kad5pcq9"}`
- ✅ proof (disk): the worktree holds .claude/skills/tdd/SKILL.md and reference.md — `"/tmp/tdm-p13/home/workspaces/ws_01m3fta23r1f0x29apgy/missions/msn_01m3ftbfmd4hjdves21c/worktrees/n2-hello-page-muiwt1s6-implement-kad5pcq9"`
- ✅ proof (git): info/exclude lists /.claude/skills/tdd/ and /.claude/skills/house-style/ — `"# git ls-files --others --exclude-from=.git/info/exclude\n# Lines that start with '#' are comments.\n# For a project mostly in C, the following would be a good set of\n# exclude patterns (uncomment them if you want to u`
- ✅ proof (git): no commit on the branch contains .claude — `"hello.txt\n.gitignore\n.tandemise/workflows/p0.yaml\n.tandemise/workflows/p10-desk.yaml\n.tandemise/workflows/p12-economy.yaml\n.tandemise/workflows/p12-escalate.yaml\n.tandemise/workflows/p12-models.yaml\n.tandemise/wo`
- ✅ proof (disk): the project checkout itself got nothing
- ✅ proof (SQL): runs.skills records name, version, hash and via — `[{"key":"implement","attempt":1,"status":"SUCCEEDED","skills":[{"name":"tdd","version":1,"hash":"bad50479a67cfc3db30d70de265458a47c47e7683e02b76b0cd1f438a0aac94e","via":"folder"},{"name":"house-style","version":1,"hash":`
- ✅ Skills → tdd reads "Used by Developer v1" — `"tdd\nWrite the failing test first, then the code.\nv1 · 2 files · 248 B · Used by Developer v1"`
- ✅ its detail says "Developer pins v1" — `"Used by\nDeveloper pins v1"`
- screenshot: `N2-developer-skills.png`
- screenshot: `N2-developer-saved.png`
- screenshot: `N2-implement-drawer.png`

## N3 — An edited source shows "Update available"; updating and moving the role are explicit; old runs keep their hash

- note: edited claude-skills/tdd/SKILL.md on disk (a fourth step)
- note: setup shortcut: the scripted runtime no longer reads .claude/skills (settings.skillsFolder false), so skills go into its prompt
- ✅ the tdd row says "Update available" — `"tdd\nWrite the failing test first, then the code.\nv1 · 2 files · 248 B · Used by Developer v1\nUpdate available"`
- ✅ the other skills do not — `[{"name":"house-style","text":"house-style\nHow our copy reads.\nv1 · 1 file · 138 B"},{"name":"lint-rules","text":"lint-rules\nThe lint rules we keep.\nv1 · 1 file · 119 B"},{"name":"tdd","text":"tdd\nWrite the failing `
- ✅ its Source says the source changed since v1 and roles keep their version — `"Source\n\n/tmp/tdm-p13/claude-skills/tdd\n\nUpdate available The source changed since v1. Update imports it as v2; roles keep their version until you move them.\n\nUpdate\nDelete"`
- ✅ proof (API): still one version (nothing was updated by itself)
- ✅ Versions now lists v2 and v1 — `"Versions\nv2 73c86d77ec4e\n2 files · 284 B · imported Sep 26, 2026, 4:37 PM\nv1 bad50479a67c\n2 files · 248 B · imported Sep 26, 2026, 4:35 PM"`
- ✅ proof (API): v2 has a new hash, v1 keeps its own — `[[2,"73c86d77ec4e"],[1,"bad50479a67c"]]`
- ✅ Used by: "Developer pins v1 · v2 is available" — `"Used by\nDeveloper pins v1 · v2 is available in Team → Roles"`
- ✅ Team → Roles → Developer still pins tdd v1 and offers "Use v2" — `"Skills\n\nEvery run of this role gets these skills at the version shown. A step in a workflow file can add its own.\n\ntdd v1\nWrite the failing test first, then the code.\nUse v2\nRemove\nChoose a skill…\nhouse-style (`
- ✅ after Use v2 and Save: "tdd v2"
- ✅ N2's implement drawer still reads tdd v1 · bad50479a67c — `"Skills: tdd v1 · bad50479a67c, house-style v1 · b204e7f41a08"`
- ✅ the new mission completes — `"COMPLETE"`
- ✅ its implement drawer: "Skills: tdd v2 · 73c86d77ec4e (in prompt), house-style v1 · b204e7f41a08 (in prompt)" — `"Skills: tdd v2 · 73c86d77ec4e (in prompt), house-style v1 · b204e7f41a08 (in prompt)"`
- ✅ the agent's handoff says "Skills in prompt: house-style, tdd" and no folder — `"msn_01m3ftd55vg99mtzdm74\nMissions\np13-skills\nN3 hello page muiwu83a\nN3 hello page muiwu83a\nComplete\nFeed\nPlan\n2\nTimeline\nArtifacts\n3\nChecks & Gates\nMetrics\nDone when\n0 of 1 verified\nU1\nThe acceptance sc`
- ✅ proof (prompt): "## Skills pinned to this step" with the v2 SKILL.md — `"## Skills pinned to this step\n\nThe person pinned these skills to this step. Use them where they apply.\n\n### Skill: tdd (v2)\n\nWrite the failing test first, then the code.\n\n# Test first\n\n1. Write a test that fai`
- ✅ proof (agent record): prompt [house-style, tdd], folder [] — `{"folder":[],"prompt":["house-style","tdd"],"cwd":"/tmp/tdm-p13/home/workspaces/ws_01m3fta23r1f0x29apgy/missions/msn_01m3ftd55vg99mtzdm74/worktrees/n3-hello-page-muiwu83a-implement-118nj7nw"}`
- ✅ proof (SQL): N2's run still records tdd v1 with its old hash
- screenshot: `N3-update-available.png`
- screenshot: `N3-versions.png`
- screenshot: `N3-drawer-v2-in-prompt.png`

## N4 — A pinned skill that is missing refuses the run with its name; re-import and Retry finish it

- ✅ proof (API): Check lint pinned lint-rules v1 when the plan was made — `[{"name":"lint-rules","version":1,"hash":"a8d6b6cfe985dc5acf3cdf8f23060c1e91bb0eddade2f4d33c9f51db5309bd4b","from":"step"}]`
- ✅ lint-rules is gone from the Library
- ✅ Check lint is BLOCKED with the skill named — `"Skill 'lint-rules' v1 (a8d6b6cfe985) is missing from the skills library. Import it again on the Skills screen, then choose Retry."`
- ✅ proof (SQL): no run was started for it — `[{"key":"implement","attempt":1,"status":"SUCCEEDED","skills":[{"name":"tdd","version":2,"hash":"73c86d77ec4e37d25dff2bb9934f1e2e0a026cb17143439b0954d7d973f39256","via":"folder"}]}]`
- ✅ Inbox: "‘Check lint’ needs a skill that is missing" — `"Inbox\nWhat is waiting on a person.\n‘Check lint’ needs a skill that is missing\nFor you·N4 lint muiwv5yq SCRIPTED_SLOW_20S\nIntervention\njust now\nDecided\n3 decisions\nApprove the plan for N4 lint muiwv5yq SCRIPTED_S`
- ✅ the card names lint-rules v1 and says what to do — `"Inbox\nWhat is waiting on a person.\n‘Check lint’ needs a skill that is missing\nFor you·N4 lint muiwv5yq SCRIPTED_SLOW_20S\nIntervention\njust now\nRead only\n‘Check lint’ needs a skill that is missing\nIntervention\na`
- ✅ importing the same folder again: "New skill" with the same hash — `"lint-rules\na8d6b6cfe985\n1 file · 119 B\n\nThe lint rules we keep.\n\nFrom /tmp/tdm-p13/more-skills/lint-rules\n\nNew skill\n\nFiles\nSKILL.md (119 B)\nSKILL.md\nLint rules\n\nNo unused imports. No commented-out code."`
- ✅ after Retry the mission completes — `"COMPLETE"`
- ✅ Check lint's drawer: "Skills: lint-rules v1 · a8d6b6cfe985 (in prompt)" or as a folder — `"Skills: lint-rules v1 · a8d6b6cfe985"`
- ✅ proof (SQL): one run of Check lint, with lint-rules v1 and its hash — `[{"key":"check_lint","attempt":1,"status":"SUCCEEDED","skills":[{"name":"lint-rules","version":1,"hash":"a8d6b6cfe985dc5acf3cdf8f23060c1e91bb0eddade2f4d33c9f51db5309bd4b","via":"folder"}]}]`
- screenshot: `N4-refused-card.png`
- screenshot: `N4-after-retry.png`
