# Known Limitations

What is not done, or is done in a way you should know about before relying on
it. Written plainly — a surprise here costs more than an omission.

## Not yet implemented

**Integration tools are advertised but not invocable by a runtime.**
The tool broker, the per-assignment `RunScopedToolGateway`, the policy gate and
the approval gate are all live and exercised, and the compiled prompt names the
tools a worker may use. But `RunRequest.mcpConfigPath` is still null: the daemon
does not yet compose `writeMcpGatewayConfig` + `ToolBridgeServer`, so a runtime
has no channel to actually call one. GitHub and browser tools therefore work
when driven directly (and are verified that way) but a *worker* cannot reach
them. This is the largest single gap.

**Integration health reads `unknown`.** `COMMAND_EXECUTOR` and
`BACKGROUND_PROCESS_LAUNCHER` are unbound in the composition root. Handled
gracefully, not thrown, but the Integrations screen cannot tell you whether
`gh` is authenticated.

**Codex has never driven a real run.** The adapter is written and degrades
correctly, but the CLI is not installed on this machine. Its argv defaults are
configuration, editable from the Runtimes screen, precisely because they could
not be verified.

**No mission archive.** Worktrees and branches are deliberately never cleaned
up — the branch *is* the reviewable artifact — but nothing removes them either.
After a dozen missions expect a dozen stale `tandemise/*` branches and their
worktrees. Remove them with `git worktree remove` and `git branch -D`.

## Behaviour worth knowing

**Reviewer and QA branch from the base, not from the implementation branch.**
A reviewer's worktree is `main`, so it reviews the `ChangeSet` artifact and the
diff it names rather than having the change checked out. The integration branch
only exists after implementation completes. This weakens the independence story
in MVP.md §16.1 and is the next architectural decision to make.

**`checks.install` defaults to `npm install`, per worktree.** A fresh worktree
has no `node_modules`, so the first mission on a real repository runs a full
install for every code task — network-dependent, minutes each. Clear the
install command on the repository if you would rather manage it yourself.

**Non-isolated tasks run in your actual checkout.** Product, design,
architecture and release use `isolation: 'none'`, so they write
`.tandemise/out/` into the repository you selected. That directory is added to
`.git/info/exclude` and cleared before each task, so your diff stays clean — but
an agent that writes elsewhere in that tree is writing to your working copy,
and there is no undo. Only code-writing tasks get a worktree.

**A mission with no repository fails late.** `repositoryId: null` produces tasks
that fail at target provisioning rather than being refused at creation. Adding
a repository sets it as the workspace default, which covers the normal path.

**Commit signing will break the fallback commit.** Commits Tandemise makes on a
worker's behalf are authored as `<roleId>@tandemise.local`. On a repository with
signing or a hooks policy that commit fails; it is caught and recorded as a
timeline note, so no work is lost, but the ChangeSet's `commits` will be empty
and nothing shouts about it.

**Planning has no run history.** `Run.taskId` is non-nullable, so the planner's
own execution has no `Run` row — its events are recorded against the mission
with `runId: null` and the UI cannot show a planning transcript.

**Screen Recording is not granted on this machine**, so macOS screenshot capture
reports `degraded`. Grant it in System Settings → Privacy & Security → Screen
Recording.

## Verified, so you do not have to wonder

Lease acquisition and event sequencing were tested under real multi-process
contention: four processes on one lease key at a 40ms TTL produced 63 handoffs
with zero overlapping holding windows, and four processes × 150 appends produced
600 unique gapless sequences. Filesystem containment, the prompt-injection
boundary, environment isolation, and the permission engine's default-deny
posture each have their own regression suite. See `docs/ACCEPTANCE.md`.
