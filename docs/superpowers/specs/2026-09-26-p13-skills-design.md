# P13: Skills library — bring your own skills, pinned per run

Status: design, 2026-09-26. Builds on P12 (model routing: role fields in Team → Roles, workflow step fields, per-run records). Base: `feat/p12-model-routing` (#18).

## Problem

A person who uses Claude Code already has skills: folders with a `SKILL.md` that teach an agent how they like tests written, how their house style reads, how a release is cut. Tandemise workers cannot use any of them. Claude Code workers run with `--setting-sources project,local`, so the person's own `~/.claude/skills` never reach them (on purpose: those folders change without notice and carry things no role asked for). The only way to give an agent a skill today is to commit it into the repository, where it changes for every run the moment someone edits it, and where nothing records which version a finished run used.

## Goal

I import the skills I already have, attach them to the roles (or workflow steps) that need them, and every run gets exactly the version it was pinned to — recorded, reproducible, and never changed by an edit I did not choose to take.

- **Import** a skill (a folder with `SKILL.md`, optionally more files) from: my `~/.claude/skills` (a discovered list with checkboxes), any local folder, or a git URL with an optional subfolder. I always see the file list and the `SKILL.md` before it is imported. Nothing is run.
- **Store** each import by the hash of its content, as a numbered **version**. Re-importing changed content creates v2; the same content is "already in the library".
- **Attach** skills to roles (Team → Roles) at a version, and optionally to a workflow step with `skills: [name@version|latest]`. `latest` becomes a concrete version when the task is created.
- **At run start** the pinned versions are put where the runtime reads them: Claude Code gets them in the working folder's `.claude/skills/<name>/` (kept out of commits through `.git/info/exclude`); a runtime that cannot load skills gets each `SKILL.md` appended to its prompt under a clear heading.
- **Every run records** each skill's name, version and hash. A pinned skill whose content is missing stops the step before it runs, with the skill named, as a card in the Inbox.
- **"Update available"** shows when a skill's source folder no longer matches its newest version. Updating is always a click; a role keeps its pinned version until I move it.

## Not in P13

- A marketplace or a shared catalogue of skills (a skill is always a folder the person chose).
- Plugin skills bundled inside Claude Code plugins (a person can import the plugin's skill folder by path).
- Skills for planning and refinement runs (they have no Run row; see P12 ruling 9). They keep running without skills.
- Automatic updates or update notifications outside the Skills screen.
- Editing a skill's files inside Tandemise.

## 1. Concepts

| Term | Meaning |
|---|---|
| Skill | A named entry in a project's library: `name`, `description` (from `SKILL.md` front matter), its source, its versions. Name is unique per project. |
| Version | One imported snapshot: `version` (1, 2, …), content `hash`, file list, size, when. Immutable. |
| Pin | `{ name, version, hash }` — what a role, a task and a run refer to. |
| Source | Where it was imported from: `claude` (a folder under the discovery root), `path` (a local folder), `git` (`url`, optional `subpath`, optional `ref`). |

**Name and description.** Read from the `SKILL.md` front matter (`name:`, `description:`); the folder name when `name` is absent. A name is 1–64 characters of letters, digits, `.`, `_`, `-`, starting with a letter or digit (it becomes a folder name).

**Content hash** (pure, `hashSkillFiles` in domain): sha-256 over the files sorted by their relative POSIX path, each fed as `path \0 size \0 bytes \0`, after a fixed prefix `tandemise-skill-v1\0`. `.git/` and `.DS_Store` are not part of a skill. Shown as its first 12 hex characters.

## 2. Import and its safety rules

Import is a two-step flow: **preview**, then **import the previewed hash**. The daemon keeps the previewed bytes in memory by hash, so the import stores exactly what the person saw. When that preview is no longer held (a restart, many previews later), the source is read again and the import is refused with 409 "The folder changed since you previewed it. Preview it again." if its hash differs.

A folder is refused (the preview says why, and the import button stays disabled) when:

| Rule | Words |
|---|---|
| no `SKILL.md` at its top level | "No SKILL.md in this folder. A skill is a folder with a SKILL.md at its top." |
| over 5 MB in total (reading stops there) | "This skill is over 5 MB; the limit is 5 MB." |
| more than 500 files | "This skill has more than 500 files; the limit is 500." |
| a symbolic link resolving outside the folder | "scripts/run links outside the skill folder (to /etc/hosts)." |
| an invalid name | "The name “My Skill” can't be a folder name. Use letters, digits, dots, dashes or underscores." |

Links that stay inside the folder are followed and stored as ordinary files. **Nothing is executed**: files are read as bytes; a git source is cloned shallow (`--depth 1`, no tags, no submodules, hooks path set to `/dev/null`, no terminal prompt, LFS smudge off) into a temporary folder that is removed afterwards.

**Discovery root.** `~/.claude/skills` by default; `TANDEMISE_SKILLS_DISCOVER_DIR` overrides it (tests point it at a fixture folder, never the real home). Each sub-folder is listed with its name, description, size and whether the library already has it ("In library as v1", "Newer than v1 in the library", or its refusal reason).

**Store.** `<TANDEMISE_HOME>/skills/<hash>/…files`, written to a temporary folder and renamed into place, shared by every project (identical content is stored once). Read back by hash; a read re-hashes the files and treats a mismatch as missing. A version's folder is removed only when no version in any project still names its hash.

## 3. Pinning

- **Role**: `role_templates.skills` = `[{ name, version }]`. Attaching picks the newest version; the editor offers "Use v3" when a newer one exists. Editing skills makes the role "edited" (a built-in refresh never overwrites it).
- **Workflow step**: `skills: [tdd@2, house-style@latest, lint-rules]` (a bare name is `latest`). Unknown skill or version → the workflow is refused at planning with the step and the name ("Step 'implement' asks for skill 'tdd' version 3, but the library has versions 1–2."). A step's pin wins over the role's pin of the same name.
- **Task**: `mission_tasks.skills` = `[{ name, version, hash, from: 'role' | 'step' }]`, resolved **when the task is created** (plan materialisation), `latest` replaced by the newest version at that moment. A task created later by the engine (a fix task, a merge-conflict task) has none recorded and resolves its role's pins on its first run, then keeps them.
- **Run**: `runs.skills` = `[{ name, version, hash, via: 'folder' | 'prompt' }]`, written on the run row before the runtime starts. Retries of the same task use the same pins.

## 4. At run start

Order inside an attempt, before the prompt is compiled:

1. **Missing content refuses the run.** For each pin, the store must hold its hash and the content must re-hash to it. Otherwise the task goes BLOCKED with the reason "Skill 'tdd' v1 is missing from the skills library (a1b2c3d4e5f6). Import it again on the Skills screen, then choose Retry." and an **intervention** card (no new approval kind) titled "‘Implement’ needs a skill that is missing", options **Retry** and **Leave blocked**. No attempt is spent. Retrying with the content back (a re-import of the same files yields the same hash) runs normally.
2. **Materialise.** The runtime adapter says where it reads skills (`skillsFolder?(profile)`):
   - Claude Code: `.claude/skills`. Generic CLI: `.claude/skills` when its settings say `skillsFolder: true`, else none. Codex: none.
   - With a folder: each pinned skill is written to `<working folder>/.claude/skills/<name>/` (the worktree for code tasks, the repository folder for no-worktree tasks, the mission folder when there is no repository), plus a self-ignoring `.gitignore` marker; `.claude/skills/<name>/` is added to the repository's `info/exclude` (via `git rev-parse --git-path info/exclude`), so it is never committed. An existing folder of that name **without** the Tandemise marker is the repository's own skill: it is left alone and that pin is delivered through the prompt instead (with a timeline note).
   - Without a folder: the prompt gains a section `## Skills pinned to this step` with, per skill, `### Skill: <name> (v<version>)` and the `SKILL.md` body (front matter removed). Other files of the skill are listed by path but not inlined. A SKILL.md longer than 40,000 characters is cut there, and the prompt says so.
   - With a folder the prompt still gets one short line per skill under the same heading ("Installed in .claude/skills/tdd (v1): <description>"), so the agent knows it has them.
3. After a run on a target that is not a worktree (the person's own checkout, the mission folder), the materialised folders are removed again. A worktree keeps them: it is the reviewable record of the run and they are excluded from its commits.

Workers still never load the person's own global skills: Claude Code keeps `--setting-sources project,local` (unchanged); only pinned skills get in.

## 5. Facts (measured in step gates)

Computed by `GateService.factsFor` for **every** task, so a step gate can read them:

| Fact | Type | Meaning |
|---|---|---|
| `skills.loaded` | number | how many pinned skills the task's newest run received (folder or prompt); 0 before any run |
| `skills.missing` | number | how many of the task's pins that run did not receive (name, version and hash all match); 0 when every pin arrived |

Example: `artifact.ChangeSet.exists && skills.missing == 0`. Both are in `GATE_FACT_VOCABULARY` and in the WORKFLOWS.md skills section with "Measured in: step gates".

## 6. Data (migration 018, additive)

```sql
CREATE TABLE skills (
  id TEXT PRIMARY KEY,                -- skl_…
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL,               -- JSON {kind, path | url, subpath?, ref?}
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (workspace_id, name)
);
CREATE TABLE skill_versions (
  id TEXT PRIMARY KEY,                -- skv_…
  skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version >= 1),
  hash TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  files TEXT NOT NULL,                -- JSON [{path, size}]
  size_bytes INTEGER NOT NULL,
  source TEXT NOT NULL,               -- JSON, the source this version came from
  created_at TEXT NOT NULL,
  UNIQUE (skill_id, version)
);
CREATE INDEX ix_skill_versions_hash ON skill_versions(hash);
ALTER TABLE role_templates ADD COLUMN skills TEXT;   -- JSON [{name, version}] or NULL
ALTER TABLE mission_tasks ADD COLUMN skills TEXT;    -- JSON [{name, version, hash, from}] or NULL (not resolved yet)
ALTER TABLE runs ADD COLUMN skills TEXT;             -- JSON [{name, version, hash, via}] or NULL (before P13)
```

## 7. API

| Route | Does |
|---|---|
| `GET /v1/workspaces/:id/skills` | the library: each skill with versions (newest first), "Used by" roles and their pinned version, and source status `current` / `update_available` / `missing` / `unchecked` (git sources are checked only on Update) |
| `GET /v1/workspaces/:id/skills/discover` | the discovery root and its folders with name, description, size, hash, library status, refusal reason |
| `POST /v1/workspaces/:id/skills/preview` | `{source}` → name, description, hash, files, `SKILL.md`, refusal reason, what an import would do ("New skill", "New version v2 of tdd", "Already in the library as tdd v1") |
| `POST /v1/workspaces/:id/skills` | `{source, hash}` → imports; 409 when the content no longer has that hash |
| `GET /v1/skills/:id/versions/:version` | one version with its `SKILL.md` |
| `POST /v1/skills/:id/update` | re-imports from the recorded source (explicit); "unchanged" when nothing changed |
| `DELETE /v1/skills/:id` | 409 "Used by Developer. Detach it in Team → Roles first." while a role pins it |
| `PUT /v1/roles/:id` | accepts `skills: [{name, version}]`; omitted keeps; each must exist (400 names it) |

`TaskView` (a `MissionTask`) carries `skills`; `latestRun.skills` carries what the run got.

## 8. Desktop

- **Sidebar**: "Skills" (icon `book`) in the project group after Team; command palette "Skills". Route `/skills`.
- **Skills screen** (`screens/Skills.tsx`): header "Skills" with **Import skills** (the one primary button). Section "About skills" (one plain line). Section "Library" (aria-label): one row per skill (aria-label "Skill: <name>") — name, description, "v2 · 3 files · 4 KB", source, "Used by Developer v1", badge **Update available** with an **Update** button, **Delete**. Clicking a row opens its detail (aria-label "Skill detail"): versions (aria-label "Versions") each "v2 · a1b2c3d4e5f6 · imported …", file list and the `SKILL.md` of the selected version.
- **Import dialog** (aria-label "Import skills"): tabs **Your Claude skills** / **A folder** / **A git repository**.
  - Your Claude skills: the discovery root, one checkbox row per folder (aria-label "Found: <name>"), disabled with its reason when refused, "In library as v1" / "Newer than v1"; clicking the name previews it. Button **Import N skills**.
  - A folder: path input (aria-label "Skill folder") + **Preview**. A git repository: URL (aria-label "Repository URL"), subfolder (aria-label "Subfolder"), + **Preview**.
  - Preview panel (aria-label "Preview"): name, description, "a1b2c3d4e5f6 · 3 files · 4 KB", what will happen, the file list, the `SKILL.md`. Button **Import** (disabled when refused).
- **Team → Roles** editor, section "Skills" (aria-label): one row per pin "tdd v1" with **Use v2** when newer and **Remove**; select (aria-label "Attach a skill") + **Attach**; saved with **Save role**. Empty: "No skills attached. Import skills on the Skills screen, then attach them here."
- **Step drawer**: line (aria-label "Skills") "Skills: tdd v1 · a1b2c3d4e5f6, house-style v2 · …" from the newest run (what it got; a skill given through the prompt reads "… (in prompt)"), else from the task's pins as "Skills (pinned): …".
- **Inbox**: the missing-skill card is an ordinary intervention card; its title and rationale name the skill.

## Testing

**Offline:** `scratch/p13-skills-check.mjs`, added to OFFLINE_CHECKS, written first and seen failing:

- pure: `hashSkillFiles` is order-independent and changes with any byte or path; front matter parsing; `parseSkillRef` (`tdd`, `tdd@2`, `tdd@latest`, bad refs); `resolveSkillPins` (step beats role, latest → newest, unknown name/version problems); `skillPromptSection`.
- workflow compile: `skills:` reaches `PlannedTask.skills`; a bad ref is refused.
- a real daemon (`startDaemon`, discovery root pointed at a fixture): discover lists good and refused folders (no SKILL.md, a link outside, over 5 MB); preview → import; re-import same content "unchanged", changed content v2; import with a stale hash → 409; a git source (a local repository by `file://` URL with a subfolder); a role attach and `skills.loaded`; a two-step mission on a worktree gets `.claude/skills/<name>/` in the worktree, `info/exclude` has it, the commit does not; the prompt-appended path for a runtime without a skills folder; `runs.skills` recorded; **an upstream edit does not change a pinned run** (edit the source after pinning: the next run of the old task still gets v1's hash; only an explicit update + re-pin moves it); a missing hash refuses the run with a named reason and an intervention card, re-import + Retry completes it; delete refused while a role uses it.

**Real app** (`scratch/acceptance/p13/`, CDP 9348, home `/tmp/tdm-p13`, discovery root = a fixture folder, scripted agent knob `SCRIPTED_ECHO_SKILLS`, set in the daemon's environment):

| # | Scenario | Must observe in the window |
|---|---|---|
| N1 | Skills → Import skills → Your Claude skills lists the fixture folder: two good skills and one refused ("links outside the skill folder"); preview one; tick both; Import 2 skills; then import a third from A folder | the Library lists tdd v1, house-style v1, lint-rules v1 with descriptions; the refused folder cannot be ticked; the preview showed the file list and SKILL.md |
| N2 | Team → Roles → Developer: attach tdd, save; run the "P13 skills" workflow (implement on a worktree, step `skills: [house-style@latest]`) with the scripted runtime reading `.claude/skills` | the implement drawer reads "Skills: tdd v1 · <hash>, house-style v1 · <hash>"; the agent's handoff says "Skills folder: house-style, tdd"; the worktree has `.claude/skills/tdd/SKILL.md`; the branch's commit does not include it; Skills shows "Used by Developer v1" |
| N3 | Edit the fixture's tdd `SKILL.md` | Skills shows "Update available" on tdd; Update → v2 in Versions; Team → Roles → Developer offers "Use v2"; the N2 drawer still reads tdd v1 with the old hash; a new mission (runtime now without a skills folder) reads "tdd v2 · <new hash> (in prompt)" and the agent's handoff says "Skills in prompt: house-style, tdd" |
| N4 | A two-step mission whose second step pins lint-rules; while step 1 runs, delete lint-rules on the Skills screen | step 2 is refused: Inbox card "‘Check lint’ needs a skill that is missing" naming lint-rules v1; re-import lint-rules from its folder; Retry on the card → the mission completes |

## Rulings

1. **Skills belong to a project**, like roles (the thing they attach to). The content store is shared by all projects, so identical files are stored once.
2. **Name is identity.** Importing a folder whose skill name already exists adds a version to that skill (whatever the source); the same content is "already in the library". The skill's source becomes the newest import's source.
3. **Resolution at task creation** for planned tasks (both step and role pins), **at first run** for tasks the engine adds later; either way the task keeps its pins for every retry. Editing a role's skills never changes a task that already exists.
4. **Missing means "the hash is not in the store"** (or its files no longer hash to it). Name and version are for people; the hash is what a run needs. Re-importing identical files therefore fixes a missing skill.
5. **Refusal is an intervention card with Retry / Leave blocked**, no "Accept the result" (there is no result). "Retry once more" never shrinks a task's attempt budget (it now takes the larger of the old budget and attempts + 1; before, a card raised before any attempt would have left a budget of one).
6. **A repository's own `.claude/skills/<name>` wins** over a pin of the same name delivered as a folder; that pin is delivered through the prompt, and the run records `via: 'prompt'`.
7. **Deleting a skill is allowed while tasks pin it** (they refuse with a named reason when they run); it is refused while a role pins it.
8. **Git sources are checked only on Update**, never on a list (no network on a screen load).
9. **Generic CLI profiles opt in to a skills folder with `skillsFolder: true`** in their settings (no new Runtimes-form field, as P12 did for `modelFlag`); the acceptance setup sets it through the API.
10. **Hashing covers relative path, size and bytes**, not modes or timestamps, so the same files copied anywhere hash the same.
11. **The scripted agent's knob is set in the daemon's environment** (`SCRIPTED_ECHO_SKILLS=1`), not in a step objective, so screenshots show the product's own words.
12. **Import keeps the previewed bytes** (by hash, in memory, 16 previews) rather than re-reading the folder: what is stored is exactly what the person saw. Without a held preview the folder is read again and a changed hash is refused (409).
