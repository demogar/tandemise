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

**Limits do not count planning or refinement.** Only step runs write usage
records, so the planner's and the refinement agent's time and tokens are not
measured against a mission or monthly limit (see `docs/guides/limits.md`).

**Two gate facts are listed but never measured.** `security.required_checks`
and `git.clean` are in the gate fact vocabulary, but the daemon does not supply
them when it checks a step's gate, so a gate that reads either one never passes.
`docs/WORKFLOWS.md` marks them.

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

## Some vendors cannot be connected with one click

Connect relies on the vendor's authorization server accepting dynamic client
registration. GitHub's hosted MCP server and Stripe's do not (checked against
the live servers), so they are not connectors: GitHub goes through `gh`, and a
server like Stripe's needs a client registered with the vendor, which there is
no place to enter yet.

## A connect attempt does not survive a daemon restart

The attempt, its PKCE verifier and its loopback listener live in memory. If the
daemon restarts while you are on the consent page, the browser's redirect finds
nothing listening. Press Connect again.

## An integration's permissions are its capability, not a per-tool list

Earlier builds showed a switch per capability on each integration. Nothing ever
enforced those switches — they were stored and ignored — so they were removed
rather than left looking like a permission. What a worker can do with an app is
decided by which roles hold its capability and by the project's autonomy
setting. Choosing individual tools per project is not possible today.

## A local MCP server's `env` is config, not a secret

The stdio `mcp` transport passes `config.env` straight to the server process,
and config lives in the database. That is correct for a project ref or a
`--read-only` flag and wrong for an access token. Hosted servers do not have
this problem — their credentials are in the Keychain — so prefer the connector
when a vendor has one.

## A worker's question does not survive a daemon restart

A worker blocked in `ask_human` is a live process waiting on the answer. A daemon
restart ends the run; the question is withdrawn, and the task retries and may
ask again. A question is also answered or expired within 24 hours, after which
the worker decides on its own and records the assumption.


## Planning and refinement runs get no skills

Pinned skills reach the steps of a mission, not the planner or the refinement
run that happen before it: those have no run record to pin a version on. A
skill that should shape the plan itself has to be said in the mission's request
for now.
