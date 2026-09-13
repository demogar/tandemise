# Tandemise

[![CI](https://github.com/demogar/tandemise/actions/workflows/ci.yml/badge.svg)](https://github.com/demogar/tandemise/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

*A local-first operating system for running a software company with
interchangeable AI workers, tools, and machines.*

Tandemise is not a model, a coding agent, or a chat client. It is the
organization layer above them. It owns the missions, roles, state, permissions,
artifacts, approvals, evaluation, and recovery — and delegates the actual work to
whichever agent runtimes, integrations, and machines you choose.

> **The architectural maxim.** Tandemise owns the organization. Agents are
> replaceable workers. Tools are replaceable capabilities. Machines are
> replaceable execution targets.

The test this codebase is built to pass: *if Claude Code disappeared tomorrow,
the organization should survive.* Missions, roles, decisions, artifacts,
permissions and history stay intact. Only an adapter changes.

---

## How it works

You give Tandemise an outcome in one sentence. It plans a DAG of tasks across
specialized roles, runs each one in an isolated Git worktree through whichever
runtime you've routed that role to, collects typed artifacts at every stage,
measures deterministic gates, escalates to you only for decisions that deserve
human judgement, and ends at a verified release candidate.

```
Intent → Plan → Approve → Execute → Review → QA → Release candidate → Your call
```

Nothing gets copy-pasted between tools. Everything is attributable and
recoverable.

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  apps/desktop        Electron + React. Control surface only.  │
│                      No filesystem, shell, or DB access.      │
└───────────────────────────┬──────────────────────────────────┘
                            │  HTTP + WebSocket on 127.0.0.1,
                            │  bearer-authenticated
┌───────────────────────────▼──────────────────────────────────┐
│  apps/daemon (tandemd)    The authoritative process.          │
│                           Composition root — the ONLY place   │
│                           that names a concrete provider.     │
└───────────────────────────┬──────────────────────────────────┘
                            │
┌───────────────────────────▼──────────────────────────────────┐
│  packages/application     Mission engine: planning, DAG       │
│                           scheduling, gates, recovery.        │
│                           Depends on ports, never providers.  │
├──────────────────────────────────────────────────────────────┤
│  packages/domain          Entities, the canonical agent event │
│  packages/kernel          vocabulary, the gate language, DAG  │
│  packages/shared          validation, and every port.         │
├──────────────────────────────────────────────────────────────┤
│  Providers (outward)                                          │
│    runtime-claude · runtime-generic · runtime-codex           │
│    execution-local · persistence · artifacts                  │
│    integration-github · browser · desktop-control             │
└──────────────────────────────────────────────────────────────┘
```

**The dependency rule is enforced mechanically.** `npm run check:boundaries`
fails the build if a package imports something it hasn't declared, imports from
an equal-or-higher layer, or — if it's a core package — imports a provider
module like `electron`, `playwright`, `better-sqlite3`, or `child_process`.

### Why it's shaped this way

- **Adapters, not integrations.** Every runtime implements one contract and
  contributes itself to a registry. Routing is by *capability* — the scheduler
  asks "who can do `shell` + `git`, is healthy, and isn't saturated?", never
  "is Claude available?". Adding a new worker is: write the adapter, export a
  module, append it to the composition list.
- **Artifacts, not chat.** Roles hand off typed documents with schemas —
  ProductSpec, ArchitecturePlan, ChangeSet, ReviewReport, QAReport — written to
  `.tandemise/out/` and validated on collection. A reviewer reads the diff and
  the spec, never the implementer's transcript, because independence is the
  whole point of a review.
- **Gates, not assurances.** Progression depends on measured facts:
  `checks.typecheck == PASS && review.blocking_findings == 0`. "The developer
  says it's done" is never a gate condition. When a gate blocks, it tells you
  exactly which conjunct failed and what the measured value was.
- **Default deny.** No tool, path, domain, or app is reachable without an
  explicit grant scoped to one worker assignment. A QA worker cannot even
  *discover* a production-write tool.
- **Crash recovery is a feature.** The daemon outlives the window. Runs are
  checkpointed with resumable session handles; a restart reconciles interrupted
  runs, releases only leases whose holder is genuinely dead, and tells you in the
  mission timeline that it happened.

## Getting started

Requires **Node 22** and macOS.

```bash
nvm use                 # 22.23.1, per .nvmrc
npm install
npm run build
npm run check:boundaries

npm run daemon          # starts tandemd
npm run desktop         # starts the Electron app
```

Point it at a Git repository, connect a runtime (Claude Code is detected
automatically; any other CLI can be wired through the generic adapter without
writing code), and create a mission.

## Repository layout

| Path | What lives there |
|---|---|
| `packages/shared` | Branded ids, errors, `Result`, clock, structured logging, secret redaction, path scoping |
| `packages/kernel` | Typed service tokens, the IoC container, composable modules, the capability registry |
| `packages/domain` | Entities, event vocabulary, gate language, plan validation, **all ports** |
| `packages/application` | Mission engine — planning, scheduling, execution, gates, remediation, recovery |
| `packages/policy` | Risk classification, permission decisions, grant derivation, trust boundaries |
| `packages/persistence` | SQLite (WAL) implementations of the repository ports, plus migrations |
| `packages/artifacts` | Content-addressed artifact store and the artifact schemas |
| `packages/context` | The context compiler — smallest task-relevant prompt bundle |
| `packages/evaluation` | Deterministic checks and the gate fact vocabulary |
| `packages/runtimes-core` | The `AgentRuntimeAdapter` contract, registry, and capability router |
| `packages/execution-core` | Execution target contract, process supervisor, scoped filesystem |
| `packages/integrations-core` | Tool broker, run-scoped tool gateway, MCP gateway |
| `apps/daemon` | `tandemd` — HTTP/WS API, composition root, lifecycle |
| `apps/desktop` | Electron main/preload + React renderer |
| `native/macos-helper` | Swift helper for Accessibility, screen capture, and input |
| `docs/` | `BUILD_BRIEF.md` (engineering contract), `APPLICATION_DESIGN.md` (mission engine), `DESIGN_SYSTEM.md` (palette, tokens, logo) |

`MVP.md` is the full product and architecture specification this implements.

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) for the
workflow (Conventional Commit PR titles, squash merges, automated releases) and
[SECURITY.md](SECURITY.md) for reporting vulnerabilities.

## License

Tandemise is licensed under the [Apache License 2.0](LICENSE).
