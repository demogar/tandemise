# ADR 0002 — Route work by capability, never by vendor identity

**Status:** accepted

## Context

The obvious design is `if (role === 'developer') useClaudeCode()`. It is also
the design that makes the product worthless the moment a better tool appears, or
a subscription hits its quota mid-mission.

## Decision

A role declares the capabilities it needs (`shell.exec`, `git.commit`,
`browser`). A runtime profile declares the capabilities it has. The scheduler
asks the registry: *which enabled, healthy, non-saturated profile satisfies these
capabilities, in this workspace's preference order for this role?* No domain or
application code contains a vendor name. `scripts/check-boundaries.mjs` and code
review enforce this.

Runtime capability is descriptive; a grant is authoritative. A runtime being
*able* to run shell commands never implies a worker is *permitted* to.

## Consequences

- Adding a runtime is: implement `AgentRuntimeAdapter`, export a
  `TandemiseModule`, append it to the composition list. Nothing else changes.
- Quota exhaustion degrades to the next profile in the routing list rather than
  stalling the mission.
- Capability vocabulary has to be agreed up front and kept stable; it is the
  lingua franca between roles, runtimes, and the policy engine.
