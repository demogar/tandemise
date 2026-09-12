# ADR 0003 — Roles hand off typed artifacts, written to the filesystem

**Status:** accepted

## Context

Multi-agent systems usually coordinate by passing messages between agents. That
produces no inspectable record, no schema to validate, no way for a human to
review a stage, and a strong tendency for a downstream agent to simply agree with
whatever the upstream one asserted.

Separately, the hand-off mechanism must work with *any* runtime, including one
with no tool-calling and no MCP support. Otherwise the runtime-agnosticism in
ADR 0002 is a fiction.

## Decision

Each role produces typed artifacts — ProductSpec, ArchitecturePlan, ChangeSet,
ReviewReport, QAReport, ReleaseCandidate — as Markdown with a validated YAML
front-matter header. A worker writes them to `.tandemise/out/<Type>.md` in its
working directory. After the run, the harvester parses, validates and stores
them.

A reviewer receives the diff and the spec. It does **not** receive the
implementer's transcript.

## Consequences

- Works with every runtime, including a plain CLI that only reads stdin.
- Survives a crashed run: the file is already on disk.
- The user can read every hand-off in Finder or in the app.
- A worker can forget to write a file. This is caught by the completion gate
  `artifact.X.exists`, which converts a soft failure into a hard, retryable one.
- `.tandemise/` is added to the worktree's `.git/info/exclude` so agent output
  never pollutes the reviewable diff.
