# ADR 0001 — Tandemise owns organizational state; agent sessions do not

**Status:** accepted

## Context

Every AI coding tool keeps its own notion of what is being worked on, inside a
conversation. That notion dies when the session ends, cannot be inspected, and
cannot be handed to a different tool. Coordinating several such tools by pasting
context between them is the problem this product exists to remove.

## Decision

Missions, tasks, roles, decisions, artifacts, permissions, evaluations,
approvals and the event log are durable Tandemise state in SQLite and on the
filesystem. An agent session is a *worker*: it receives a compiled context
bundle, does one task, produces typed artifacts, and is discarded. Nothing
organizationally meaningful lives only inside a runtime.

## Consequences

- A runtime can be swapped mid-mission with no loss of state.
- A crashed desktop, a killed daemon, or an exhausted quota is an interruption,
  not data loss.
- Context must be *compiled* for each task rather than accumulated, which is
  more work than passing a growing transcript — see ADR 0004.
- We pay for durability on every state transition. The scheduler persists
  before it acts, never after.
