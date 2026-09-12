# MVP Acceptance Criteria — Evidence

Tracks MVP.md §30 against what has actually been demonstrated on this machine.
Every "met" claim names the script that proves it. Anything not demonstrated is
marked plainly as not demonstrated — a checked box with no evidence behind it
would be worse than an unchecked one.

Run any of these with `export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH"`.

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | Desktop app installs and launches tandemd without a cloud account | | |
| 2 | Discovers Claude Code and Codex when installed; reports health | | |
| 3 | User can select a local Git repository and create a workspace | | |
| 4 | Mission from natural language; typed proposed plan is inspectable | | |
| 5 | Plan executes as a DAG through Product, Developer, Reviewer, QA | | |
| 6 | Developer work happens in an isolated worktree → reviewable changeset | | |
| 7 | One mission uses different runtimes for different roles | | |
| 8 | Runtime events normalized into one mission timeline | | |
| 9 | Core artifacts persist across restart | | |
| 10 | Blocking reviewer findings create fix work and block QA/release | | |
| 11 | QA runs real browser automation with screenshots and criteria evidence | | |
| 12 | GitHub reads repo/PR state; creates a draft PR only under policy | | |
| 13 | MCP exposes a granted tool without exposing unrelated workspace tools | | |
| 14 | macOS control launches/inspects an allowlisted app, acts, captures evidence | | |
| 15 | Permissions are deny-by-default and visible to the user | | |
| 16 | Production release actions require explicit approval | | |
| 17 | Killing the window doesn't stop the daemon; daemon restart keeps state | | |
| 18 | Interrupted runs are marked correctly and resumed/retried by policy | | |
| 19 | No raw credentials in SQLite when a CLI session or OS reference will do | | |
| 20 | Cancelling a mission leaves no orphaned background worker | | |
| 21 | Full reference mission produces a release candidate, no copy/paste | | |

## Verification scripts

| Script | Covers |
|---|---|
| `scratch/gt.mjs` | Gate expression engine, DAG validation, plan rules |
| `scratch/persistence-check.mjs` | Durability, migrations, lease contention, event sequencing |
| `scratch/policy-eval-check.mjs` | Default-deny policy, scope matching, gate facts, artifact schemas |
| `scratch/execution-check.mjs` | Worktrees, process supervision, merge conflicts, path scoping |
| `scratch/runtime-check.mjs` | Claude Code adapter against the real CLI; fake runtime; cancellation |
| `scratch/gemini-check.mjs` | Runtime-agnosticism: a second CLI through the generic adapter |
| `scratch/secrets-check.mjs` | macOS Keychain secret store |
| `scratch/integrations-check.mjs` | Tool broker, run-scoped gateway, GitHub, browser |
| `scratch/desktop-check.mjs` | macOS Accessibility helper |
| `scratch/application-check.mjs` | Mission engine end to end with the deterministic runtime |
| `scratch/e2e-daemon.mjs` | The real daemon over its real HTTP + WebSocket API |
