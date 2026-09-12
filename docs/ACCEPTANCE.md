# MVP Acceptance Criteria — Evidence

Tracks MVP.md §30 against what has actually been demonstrated on this machine.
Every "met" claim names the script that proves it. Anything not demonstrated is
marked plainly as not demonstrated — a checked box with no evidence behind it
would be worse than an unchecked one.

Run any of these with `export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH"`.

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | Desktop app installs and launches tandemd without a cloud account | | |
| 2 | Discovers Claude Code and Codex when installed; reports health | ✅ met | `scratch/runtime-check.mjs` (Claude Code 2.1.269 detected + healthy), `scratch/codex-check.mjs` (Codex adapter degrades to an actionable message; it distinguishes "CLI missing" from "not signed in") |
| 3 | User can select a local Git repository and create a workspace | | |
| 4 | Mission from natural language; typed proposed plan is inspectable | | |
| 5 | Plan executes as a DAG through Product, Developer, Reviewer, QA | | |
| 6 | Developer work happens in an isolated worktree → reviewable changeset | | |
| 7 | One mission uses different runtimes for different roles | ✅ met | `scratch/gemini-check.mjs` — two different agent CLIs driven through one adapter by configuration alone; Claude Code completes a real run |
| 8 | Runtime events normalized into one mission timeline | ✅ met | `scratch/runtime-check.mjs` — every runtime normalizes into the canonical AgentEvent union |
| 9 | Core artifacts persist across restart | | |
| 10 | Blocking reviewer findings create fix work and block QA/release | | |
| 11 | QA runs real browser automation with screenshots and criteria evidence | ✅ met | `scratch/qa-e2e-check.mjs` — starts the Taskly dev server, drives three acceptance criteria through a real Chromium, captures a 24KB screenshot and a semantic accessibility tree, runs a11y checks, asserts no console errors |
| 12 | GitHub reads repo/PR state; creates a draft PR only under policy | ✅ met | `scratch/integrations-check.mjs` — real `gh` calls; `github.pr.create` is `external_side_effect` and policy-gated, absent from a QA gateway |
| 13 | MCP exposes a granted tool without exposing unrelated workspace tools | ✅ met | `scratch/integrations-check.mjs` — stdio MCP server `tools/list` returns only granted tools; `github_pr_create` refused |
| 14 | macOS control launches/inspects an allowlisted app, acts, captures evidence | ✅ met | `scratch/desktop-check.mjs` — Swift helper builds and responds; app allowlist hides 193 non-allowlisted apps; permissions reported with the exact System Settings path |
| 15 | Permissions are deny-by-default and visible to the user | ✅ met | `scratch/policy-eval-check.mjs`, `scratch/integrations-check.mjs` — default deny; ungranted tools are not even listed |
| 16 | Production release actions require explicit approval | | |
| 17 | Killing the window doesn't stop the daemon; daemon restart keeps state | | |
| 18 | Interrupted runs are marked correctly and resumed/retried by policy | | |
| 19 | No raw credentials in SQLite when a CLI session or OS reference will do | ✅ met | `scratch/secrets-check.mjs` — macOS Keychain; DB stores opaque refs; gh/claude reuse their own sessions |
| 20 | Cancelling a mission leaves no orphaned background worker | ✅ met | `scratch/runtime-check.mjs`, `scratch/execution-check.mjs` — cancel reaps the child (verified with ps); supervisor killAll on shutdown |
| 21 | Full reference mission produces a release candidate, no copy/paste | | |

## Security fixes made during review

Two independent reviewers ran adversarially against this code. The findings that
mattered, all now fixed with permanent regression coverage:

| Finding | Status |
|---|---|
| Sandbox escape: a **dangling** symlink defeated path scoping, writing outside every declared root | fixed — `scratch/fs-security-check.mjs` (28 checks) |
| Permission engine returned **allow** on an unparseable grant expiry | fixed — an expiry that cannot be read has passed |
| Risk classification **discarded the command** when shell context was absent, returning allow for `sudo rm -rf ~` | fixed — classified against an empty context instead |
| Shell classifier missed a bare `&`, subshells, `$()`, `git -C`, and redirection to credential paths (10 of 17 dangerous commands under-classified) | fixed — 17/17 caught, 32/32 benign commands not over-flagged |
| Worker processes inherited the daemon's **entire environment**, including GITHUB_TOKEN and AWS keys | fixed — allowlist; `scratch/env-leak-check.mjs` |
| Two tasks with names that slugify alike **shared a worktree and branch** | fixed — slug carries the task id |
| A detached-HEAD worktree was reused, so salvaged work would land unreachable and be dropped | fixed — refused with CONFLICT |
| Signal-killed children read as still running, causing a redundant SIGKILL on every clean cancel | fixed — `signalCode` is now checked |
| Concurrency slot was not held until the first event was read, so two schedulers could pick the same single-slot runtime | fixed — `scratch/concurrency-check.mjs` |

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
| `scratch/qa-e2e-check.mjs` | The QA role's path: dev server + real browser + evidence against the demo app |
| `scratch/fs-security-check.mjs` | Filesystem containment: traversal, symlink escapes, root spelling |
| `scratch/env-leak-check.mjs` | Worker processes do not inherit unrelated credentials |
| `scratch/concurrency-check.mjs` | Runtime concurrency slots are held for the whole run |
| `scratch/codex-check.mjs` | Codex adapter degrades correctly when the CLI is absent |
| `scratch/shell-benign-check.mjs` | Shell risk classifier does not over-flag ordinary commands |
