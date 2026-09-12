# ADR 0005 — The daemon is a separate process from the desktop app

**Status:** accepted

## Context

Electron is a good control surface and a poor place to own a process supervisor,
a database, and long-running work. Closing a window should not abandon a mission
that is twenty minutes into an implementation task.

## Decision

`tandemd` is a plain Node process that owns the database, the schedulers, all
child processes, integrations, recovery and the event stream. The desktop app is
a client: it binds no state and reads no SQLite. They speak HTTP + WebSocket over
127.0.0.1, authenticated with a per-installation bearer token written to a 0600
file in `~/.tandemise/`.

## Consequences

- Closing the window leaves work running; only "Quit Tandemise" performs a
  coordinated shutdown.
- `better-sqlite3` loads against the system Node ABI rather than Electron's,
  removing a whole class of native-module rebuild pain.
- The same API can later serve a CLI, a test harness, or a remote node with no
  change to the application layer.
- It costs a serialization boundary and a handshake. Worth it.
- The renderer runs with `contextIsolation`, no Node integration, and a minimal
  preload bridge, because it is the only part of the system that renders content
  originating from agents and the web.
