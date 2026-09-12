# Known Limitations

What is not done, or is done in a way you should know about before relying on
it. Written plainly — a surprise here costs more than an omission.

## Not yet implemented

**Codex has never driven a real run.** The adapter is written and degrades
correctly, but the CLI is not installed on this machine. Its argv defaults are
configuration, editable from the Runtimes screen, precisely because they could
not be verified.

**No mission archive.** Worktrees and branches are deliberately never cleaned
up — the branch *is* the reviewable artifact — but nothing removes them either.
After a dozen missions expect a dozen stale `tandemise/*` branches and their
worktrees. Remove them with `git worktree remove` and `git branch -D`.

## Behaviour worth knowing

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

## The daemon's CORS grant is loopback-wide

Any process that can serve a page on `http://localhost` can have that page read
the daemon's unauthenticated `/v1/health` route, and attempt authenticated ones.
The grant cannot be narrowed to the desktop's exact origin because the Vite dev
server picks its own port, and the packaged renderer has no origin at all
(`file://` sends `null`). Every route except health still requires the bearer
token, which never leaves the connection file, so the exposure is liveness only.
Narrowing this means having the daemon learn the renderer's origin at handshake
time rather than inferring it - worth doing before any non-loopback transport.

## A profile selects a config directory, not a credential

`configDir` is the only environment variable a profile may set, and it is typed
as a path rather than exposed as a free-form env map - a map is where an
`ANTHROPIC_API_KEY` would end up, and credentials do not belong in the database
(MVP.md §P8). Two profiles can therefore be two logins, because the credential
lives in the config directory the profile names, but a profile still cannot
carry a token, a base URL override, or a proxy setting of its own. Doing that
properly means referencing the existing secret store by id rather than storing
a value, which is worth building before any runtime needs per-profile auth.

## A task's repository is chosen at plan time, not re-chosen on retry

A task names its repository when the plan is materialized, and a retry reruns it
in the same one. That is right for a retry of the same work, but a plan that put
a task in the wrong repository has to be re-planned rather than corrected in
place - there is no way to move a single task to another repository from the
mission view. Worth adding once it is clear whether people correct plans or
simply re-plan.

## A wait step polls; it is not woken

A `wait` step runs a command on an interval until it exits 0. That covers CI, a
deploy and a post-deploy check without holding a model, but it is still polling:
a webhook arriving the instant a build finishes would be both faster and
cheaper. Inbound webhooks need a listener the daemon does not have, and a
tunnel or a hosted endpoint to reach it — worth doing when a workflow is waiting
on something that pushes rather than something that can be asked.

## Integrations authenticate by hand, not by OAuth

An integration is configured with whatever the underlying transport already
needs: `gh` is logged in already, and an MCP server takes its own environment.
There is no authorize-in-a-browser flow, no token refresh, and no expiry
handling — a credential that expires shows up as an integration going
`unavailable` with the vendor's own error, which is honest but is not the
one-click connect a non-engineer expects.

OAuth needs three things Tandemise does not have: a loopback redirect listener
in the daemon, refresh-token storage in the OS credential store with rotation,
and a per-provider authorize/token endpoint description. The credential store
and the health model are already the right shape for it; the flow is the work.

## An MCP integration's `env` is config, not a secret

The `mcp` transport passes `config.env` straight to the server process, and
config lives in the database. That is correct for a project ref, a region or a
`--read-only` flag, and wrong for an access token. Until `secretRef` is wired
through to the spawned environment, prefer a server that reads its own
credentials from the environment the daemon inherits, or one that is already
authenticated the way `gh` is.
