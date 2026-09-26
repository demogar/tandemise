# Quickstart

## Run it

```bash
nvm use                 # Node 22.23.1, per .nvmrc
npm install
npm run build
npm run dev             # builds, starts tandemd, then opens the desktop app
```

`npm run dev` leaves the daemon running when you close the window — that is
deliberate (MVP.md §7.3). Stop it with `npm run dev -- --stop-daemon`, or
`kill <pid>` using the pid printed on exit.

Run the two processes separately if you prefer:

```bash
npm run daemon          # tandemd on 127.0.0.1, ephemeral port
npm run desktop         # Electron, reads ~/.tandemise/daemon.json
```

## First mission

1. **Settings → Repositories**: the daemon creates a workspace on first start,
   so all you do here is point it at a Git repository. There is a demo
   repository at `~/projects/tandemise-demo-app` (Taskly — a small task tracker
   with real tests, a typecheck, and a dev server) if you want something safe to
   aim at first.
2. **Runtimes → Discover**: Claude Code is detected automatically. Any other
   agent CLI can be added here as a `generic-cli` runtime — give it a command,
   an argument template with `{{prompt}}`, and whether the prompt goes as an
   argument or on stdin. No code change is needed to add a worker.
3. **Missions → New Mission**: describe the outcome in one sentence and write
   at least one line under **Done when (one per line)**, then press ⌘↵.
   Inspect the proposed plan, approve it, and watch the DAG execute. The
   mission's feed shows each Done-when line and whether QA verified it.
   Leave **Done when** empty and the button reads **Create and refine**
   instead: a product agent proposes criteria for you to decide first.

## Next

The guides in [`docs/guides/`](guides/) each answer one "how do I…":
[Done when](guides/done-when.md), [Refine](guides/refine.md),
[Backlog and work in progress](guides/backlog.md), [Limits](guides/limits.md),
[The Inbox](guides/inbox.md),
[The desk and the status report](guides/desk-and-status-report.md) and
[Routines](guides/routines.md). [WORKFLOWS.md](WORKFLOWS.md) covers workflow
files and every gate fact.

## Where things are

| | |
|---|---|
| Database, artifacts, worktrees, logs | `~/.tandemise/` |
| Daemon connection info | `~/.tandemise/daemon.json` (0600) |
| Per-mission worktrees | `~/.tandemise/workspaces/<ws>/missions/<mission>/worktrees/` |
| Artifacts an agent produced | `.tandemise/out/` inside each worktree |
| Logs | `~/.tandemise/logs/` |

Your own checkout is never modified: every code-writing task runs in its own
Git worktree on its own branch, and the branch survives after the worktree is
released so the change stays reviewable.

## Checks

```bash
npm run check:boundaries          # enforces the dependency direction
npx tsc -b tsconfig.build.json    # whole monorepo

node scratch/gt.mjs                    # gate language + DAG validation
node scratch/persistence-check.mjs     # durability, leases, event ordering
node scratch/policy-eval-check.mjs     # permissions, risk, gate facts
node scratch/fs-security-check.mjs     # filesystem containment
node scratch/execution-check.mjs       # worktrees, process supervision, git
node scratch/runtime-check.mjs         # the real Claude Code CLI
node scratch/integrations-check.mjs    # tool broker, MCP gateway, gh, browser
node scratch/qa-e2e-check.mjs          # QA path against the running demo app
node scratch/e2e-daemon.mjs            # the daemon over its real HTTP + WS API
```

`docs/ACCEPTANCE.md` maps each MVP acceptance criterion to the script that
demonstrates it, and records what is not yet demonstrated.

## Adding a worker without writing code

The Runtimes screen can wire any CLI that takes a prompt and prints output:

```
command:      /usr/local/bin/some-agent
args:         ["--headless", "{{prompt}}"]
promptVia:    arg            (or "stdin")
outputFormat: ndjson         (or "text")
eventMap:     { "types": { "assistant": "message", "done": "completed" } }
```

That is the whole extension point for a new worker. Writing an adapter is only
necessary when a CLI needs bespoke argument handling or richer event mapping —
see `packages/runtime-claude` for the shape.
