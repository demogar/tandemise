---
version: "0.1"
target: "Fully functional macOS-first local MVP"
primary_user: "Independent software developer / one-person software company"
architecture_posture: "Local-first, runtime-agnostic, integration-agnostic, human-authority-first"
---

# Tandemise

## MVP Product & Architecture Specification

*Local-first operating system for running a software company with interchangeable AI workers, tools, and machines.*

> **Product thesis.** Tandemise is not an AI model, a coding agent, or a chat client. It is the organization layer above them: a desktop application that owns missions, roles, state, permissions, artifacts, approvals, evaluation, and recovery while delegating work to whichever agent runtimes, integrations, and execution targets the user chooses.

> **Architecture maxim.** Tandemise owns the organization. Agents are replaceable workers. Tools are replaceable capabilities. Machines are replaceable execution targets.

# Document Purpose

This document defines a buildable MVP for Tandemise. It is intentionally more concrete than a product vision: it specifies the architectural boundaries, core domain model, runtime contracts, execution model, security posture, UI surfaces, workflows, persistence model, recovery behavior, and acceptance criteria required for a genuinely useful desktop product.

The MVP is considered complete only when a user can connect existing local agent runtimes such as Claude Code and Codex, select a software repository, create a mission in natural language, allow Tandemise to plan and execute work through multiple specialized roles, review artifacts and approvals, run automated browser-based QA, and arrive at a verified release candidate without manually shuttling context between tools.

# Table of Contents

- [1. Executive Summary](#1-executive-summary)
- [2. Product Definition](#2-product-definition)
- [3. MVP Scope and Non-Goals](#3-mvp-scope-and-non-goals)
- [4. Architectural Principles](#4-architectural-principles)
- [5. System Context](#5-system-context)
- [6. Logical Architecture](#6-logical-architecture)
- [7. Desktop and Daemon Architecture](#7-desktop-and-daemon-architecture)
- [8. Core Domain Model](#8-core-domain-model)
- [9. Mission and Workflow Engine](#9-mission-and-workflow-engine)
- [10. Runtime Abstraction](#10-runtime-abstraction)
- [11. Execution Targets and Workspace Isolation](#11-execution-targets-and-workspace-isolation)
- [12. Integration and Tool Broker](#12-integration-and-tool-broker)
- [13. Browser and Installed-App Control](#13-browser-and-installed-app-control)
- [14. Context, Memory, and Knowledge](#14-context-memory-and-knowledge)
- [15. Artifact System](#15-artifact-system)
- [16. Built-in Organizational Roles](#16-built-in-organizational-roles)
- [17. Evaluation and Quality Gates](#17-evaluation-and-quality-gates)
- [18. Human Authority and Approvals](#18-human-authority-and-approvals)
- [19. Security and Permissions](#19-security-and-permissions)
- [20. Persistence and Data Model](#20-persistence-and-data-model)
- [21. Process Supervision and Recovery](#21-process-supervision-and-recovery)
- [22. Observability and Usage](#22-observability-and-usage)
- [23. Desktop UX](#23-desktop-ux)
- [24. End-to-End Reference Mission](#24-end-to-end-reference-mission)
- [25. Extensibility and Plugin Model](#25-extensibility-and-plugin-model)
- [26. Repository and Package Structure](#26-repository-and-package-structure)
- [27. Core Interfaces and Schemas](#27-core-interfaces-and-schemas)
- [28. Testing Strategy](#28-testing-strategy)
- [29. Implementation Plan](#29-implementation-plan)
- [30. MVP Acceptance Criteria](#30-mvp-acceptance-criteria)
- [31. Post-MVP Expansion](#31-post-mvp-expansion)
- [32. Risks and Mitigations](#32-risks-and-mitigations)
- [33. Architectural Decision Summary](#33-architectural-decision-summary)
- [Appendix A. Example Workspace Configuration](#appendix-a-example-workspace-configuration)
- [Appendix B. Example Mission Plan](#appendix-b-example-mission-plan)
- [Appendix C. Recommended Technology Stack](#appendix-c-recommended-technology-stack)

# 1. Executive Summary

Tandemise is a desktop-first, local-first operating system for coordinating an AI-assisted software organization. The user defines intent and retains authority. Tandemise converts that intent into missions, plans, tasks, artifacts, evaluations, and approvals; then delegates execution to interchangeable agent runtimes such as Claude Code, Codex, DeepSeek-based harnesses, OpenCode, or future tools.

The central architectural rule is that no external agent owns organizational state. Agent sessions are temporary workers. Tandemise owns the durable truth: what is being built, why it is being built, what decisions were made, which artifacts were produced, which checks passed, what permissions exist, and what still requires a human decision.

- **Local-first.** Repositories, credentials, runtime sessions, artifacts, and execution remain on user-controlled machines by default.

- **Runtime-agnostic.** Claude Code, Codex, local models, and future agents implement a common worker contract and can be replaced without changing missions or roles.

- **Tool-agnostic.** GitHub, Figma, Lovable, PostHog, Sentry, browsers, desktop applications, and other services are exposed through a common integration broker.

- **Artifact-driven.** Roles communicate through explicit specs, plans, changesets, reviews, test reports, decisions, and other durable artifacts rather than through opaque agent-to-agent chat.

- **Human authority.** Automation may propose and execute within policy, but consequential actions are governed by explicit approval rules.

- **Recoverable.** Every run is observable, checkpointed, interruptible, resumable where possible, and reconstructible from durable state.

- **Capability-based.** Tandemise assigns work based on required capabilities, available runtimes, permissions, and execution targets - not on hard-coded vendor identities.

> **MVP north-star workflow.** Intent → Plan → Approve → Execute → Review → QA → Release candidate → Human ship decision. The user should not need to copy/paste context between Claude Code, Codex, GitHub, Figma, browser tools, or terminals.

# 2. Product Definition

## 2.1 Product statement

Tandemise lets one person operate a virtual software organization from a desktop application by coordinating specialized AI roles across interchangeable agent runtimes, local repositories, browser sessions, installed applications, external services, and quality gates.

## 2.2 What Tandemise is

- A mission orchestration engine.

- A durable organizational state and artifact system.

- A capability router for AI runtimes, integrations, browsers, and machines.

- A policy and approval engine.

- A local execution supervisor.

- A desktop control surface for observing and directing work.

- A normalized event stream and audit trail across heterogeneous agents.

## 2.3 What Tandemise is not

- Not a new foundation model.

- Not another general-purpose chat application.

- Not a wrapper that depends on a single provider API.

- Not a replacement for Git, CI, Figma, GitHub, or other systems of record.

- Not an autonomous authority allowed to perform unrestricted destructive or financial actions.

- Not a SaaS requirement; the MVP operates entirely on the user's machine except when connected tools themselves are remote.

## 2.4 Target user

The initial user is a technically sophisticated independent developer who already uses multiple AI coding tools and wants them to behave like a coordinated product organization rather than isolated assistants. The architecture must later support small teams, but multi-user collaboration is explicitly outside the MVP.

# 3. MVP Scope and Non-Goals

## 3.1 Functional MVP definition

The MVP is complete when Tandemise can run a real software-development mission end-to-end on macOS using at least two interchangeable local agent runtimes and a real repository. The mission must produce durable product, engineering, review, and QA artifacts; isolate concurrent work; enforce permissions; survive application restarts; and end in a human-verifiable release candidate.

| **Area**       | **Required MVP capability**                                                                                              |
|----------------|--------------------------------------------------------------------------------------------------------------------------|
| Desktop        | Electron + React desktop application with background daemon.                                                             |
| Runtimes       | Claude Code and Codex adapters using the user's installed/authenticated CLIs; generic adapter contract for others.       |
| Repository     | Local Git repositories, branches, commits, worktrees, diffs, and status.                                                 |
| Roles          | Product, Designer, Architect, Developer, Reviewer, QA, Release; Finance Analyst as read-only generic capability example. |
| Workflow       | DAG-based mission plan with dependencies, retries, gates, approvals, and role routing.                                   |
| Browser        | Playwright-controlled isolated Chromium profiles for QA and browser-based tools.                                         |
| Installed apps | macOS app discovery, launch, accessibility-tree inspection, input, shortcuts, and screenshots through a native helper.   |
| Integrations   | GitHub + generic MCP + generic REST/CLI connectors; preconfigured patterns for Figma/Lovable-style tools.                |
| State          | SQLite durable state plus filesystem artifact store.                                                                     |
| Security       | Default-deny permissions, action risk classification, secret references, approval gates, isolated workspaces.            |
| Recovery       | Daemon restart recovery and interrupted-run detection; resumable sessions when runtime supports them.                    |
| Observability  | Mission timeline, normalized agent events, tool calls, artifacts, approvals, logs, runtime usage where available.        |

## 3.2 Deliberate non-goals for v0.1

- No cloud control plane or mandatory account.

- No multi-user collaboration or RBAC across humans.

- No marketplace for third-party plugins.

- No Windows/Linux desktop automation implementation, although interfaces must be cross-platform.

- No fully autonomous production deployment without explicit human approval.

- No payment initiation, refunds, bank transfers, or other money-moving actions.

- No attempt to recreate Figma, Linear, GitHub, CI, or browser devtools inside Tandemise.

- No generic visual computer-use model as the first choice when API, CLI, MCP, browser DOM, or accessibility semantics are available.

# 4. Architectural Principles

### P1 - Tandemise owns truth

Agent conversations and sessions are ephemeral. Missions, decisions, artifacts, policies, evaluation results, and approvals are durable Tandemise state.

### P2 - Brains are replaceable

No domain entity references “Claude” or “Codex” as its identity. Roles declare capabilities; runtime profiles satisfy them.

### P3 - Tools are organization resources

GitHub, Figma, Lovable, PostHog, browser, desktop control, and other integrations belong to the workspace and are permissioned independently of the agent runtime.

### P4 - Prefer deterministic interfaces

API/CLI/MCP/DOM/accessibility semantics are preferred over screenshot-and-coordinate automation.

### P5 - Artifacts over chat

Each phase produces inspectable outputs with schemas and acceptance criteria. Chat may exist for interaction, but is never the sole coordination protocol.

### P6 - Human authority is explicit

A policy engine decides which actions can run automatically and which require approval. “Automation” is never implicitly equivalent to authority.

### P7 - Every action is attributable

Every event records mission, task, run, role, runtime, tool/integration, target machine, timestamps, and outcome.

### P8 - Local-first security

Credentials remain in native secure storage or existing CLI sessions. Tandemise stores secret references, not raw secrets, whenever possible.

### P9 - Crash recovery is a first-class feature

The daemon writes checkpoints and event history continuously so a desktop crash is an interruption, not loss of organizational state.

### P10 - Architecture before autonomy

The first version optimizes for dependable controlled execution, not maximal unattended behavior.

# 5. System Context

```text
HUMAN OWNER

|

v

+------------------+

| Tandemise Desktop|

+--------+---------+

|

v

+------------------+

| tandemd |

| organization core|

+--+-------+-----+-+

| | |

+------------+ | +----------------+

v v v

Agent Runtimes Integration Hub Execution Targets

-------------- --------------- -----------------

Claude Code GitHub Local Mac

Codex Figma / MCP Git worktrees

Other CLI/SDK Lovable / MCP Docker

Local models REST / CLI Browser profiles

Browser/App drivers Remote (future)
```


The desktop process is a control surface. The background daemon is the authoritative runtime process. It can continue work while the main window is closed, can supervise child processes, and can recover mission state after the UI or operating system restarts.

# 6. Logical Architecture

```text
+-----------------------------------------------------------------------+

| UI LAYER |

| Dashboard | Missions | Approvals | Workforce | Artifacts | Settings |

+-----------------------------------+-----------------------------------+

|

+-----------------------------------v-----------------------------------+

| APPLICATION SERVICES |

| Mission Service | Planning | Scheduler | Policy | Evaluation | Search |

+-------------+--------------------+---------------------+---------------+

| | |

+-------------v------+ +----------v----------+ +------v----------------+

| Runtime Manager | | Integration Broker | | Execution Manager |

| adapters/sessions | | tools/MCP/API/CLI | | git/browser/desktop |

+-------------+------+ +----------+----------+ +------+----------------+

| | |

+-------------v--------------------v--------------------v----------------+

| DOMAIN CORE |

| Mission | Task | Artifact | Decision | Approval | Policy | Run | Event |

+-----------------------------------+-----------------------------------+

|

+-----------------------------------v-----------------------------------+

| PERSISTENCE / ARTIFACTS |

| SQLite (WAL) | filesystem blobs | Git | OS secure credential store |

+-----------------------------------------------------------------------+
```


## 6.1 Boundary rule

The domain core must not import Electron, Claude Code, Codex, Playwright, GitHub SDKs, Figma SDKs, macOS APIs, or other provider-specific modules. Those concerns live behind ports/adapters. This is the primary guard against architectural lock-in.

# 7. Desktop and Daemon Architecture

## 7.1 Processes

| **Process**                           | **Responsibility**                                                                                                                          |
|---------------------------------------|---------------------------------------------------------------------------------------------------------------------------------------------|
| Tandemise Desktop (Electron renderer) | React UI only. No direct filesystem, shell, credential, or child-process access.                                                            |
| Electron main/preload                 | Window lifecycle, tray, secure IPC bridge, updater, daemon bootstrap. Keep minimal.                                                         |
| tandemd                               | Long-running Node.js orchestration daemon. Owns missions, database, schedulers, child processes, integrations, recovery, and event streams. |
| Native platform helper                | macOS Swift helper for Accessibility API, app/window discovery, ScreenCaptureKit/CG APIs, and input events.                                 |
| Worker processes                      | Claude Code, Codex, Git, tests, build tools, MCP servers, Playwright, Docker commands, and other task processes.                            |

## 7.2 IPC

The UI communicates only with tandemd. For the MVP, tandemd binds to 127.0.0.1 on an ephemeral port and requires a random per-installation bearer token stored in the OS credential store. Request/response operations use HTTP/JSON; live mission/run updates use WebSocket. A future implementation may replace loopback networking with Unix domain sockets/named pipes without changing application contracts.

- Bind to loopback only; never 0.0.0.0 by default.

- Authenticate every daemon request.

- Rotate local session token on explicit sign-out/reset.

- Use an explicit API version from the beginning.

- UI subscribes to projected state; it never reads SQLite directly.

## 7.3 Background behavior

Closing the main window does not terminate active work. The app remains in the system tray/menu bar while missions run. “Quit Tandemise” performs an explicit coordinated shutdown: active runs are paused/cancelled according to policy, events are flushed, and recoverable session identifiers are saved.

# 8. Core Domain Model

| **Entity**        | **Purpose**                                                                                                             |
|-------------------|-------------------------------------------------------------------------------------------------------------------------|
| Workspace         | Top-level organizational context: repositories, integrations, policies, role templates, runtime routing, and knowledge. |
| Mission           | A user outcome with goal, constraints, status, plan, artifacts, metrics, and approval state.                            |
| Task              | Atomic schedulable unit in a mission DAG with typed inputs/outputs and required capabilities.                           |
| Role Template     | Organizational responsibility: instructions, capabilities, policies, preferred tools, evaluation expectations.          |
| Worker Assignment | A temporary binding of Role Template + Runtime Profile + Execution Target + permission set for one task/run.            |
| Runtime Profile   | Configured agent runtime such as Claude Code or Codex, including adapter and capability metadata.                       |
| Execution Target  | Machine/environment where work executes: local host, worktree, Docker, browser profile, future SSH node.                |
| Integration       | Organization resource such as GitHub, Figma, MCP server, REST connector, browser driver, or app driver.                 |
| Artifact          | Durable output consumed by people or downstream tasks: spec, plan, diff, screenshot, report, decision record.           |
| Decision          | Explicit choice with rationale, alternatives, evidence, status, and decision owner.                                     |
| Approval          | Human authorization request tied to an action, artifact, gate, or policy rule.                                          |
| Run               | One execution attempt of a task by a worker assignment.                                                                 |
| Event             | Append-only normalized record of what happened during a run.                                                            |
| Policy            | Rules controlling permissions, approvals, budgets, routing, retries, and allowed side effects.                          |
| Evaluation        | Structured result from deterministic checks or an evaluator role against explicit criteria.                             |

## 8.1 Identity separation

```text
Role: QA Engineer

Runtime: Codex CLI

Target: qa-worktree-238

Tools: Browser + GitHub read + Figma read

Permissions: repository.read, browser.localhost, tests.run


Changing Runtime to Claude Code does not change the role, workflow, artifacts,

permissions, or mission state.
```

# 9. Mission and Workflow Engine

## 9.1 Mission lifecycle

```text
DRAFT

-> PLANNING

-> AWAITING_PLAN_APPROVAL (optional)

-> EXECUTING

-> REVIEWING

-> QA

-> READY_TO_SHIP

-> RELEASED (only after explicit approval)

-> OBSERVING (optional)

-> COMPLETE


Any active state may transition to BLOCKED, PAUSED, FAILED, or CANCELLED.
```


## 9.2 DAG execution

A mission plan is a directed acyclic graph rather than a fixed Product → Developer → QA chain. Each task declares dependencies, required capabilities, input artifacts, expected output artifact types, execution constraints, and gates. This allows parallelization without hard-coding organizational structure.

| **Task field**  | **Example**                                    |
|-----------------|------------------------------------------------|
| id              | task_implement_onboarding                      |
| role            | developer                                      |
| depends_on      | task_architecture                              |
| requires        | filesystem.write, shell, git, tests            |
| inputs          | ProductSpec, ArchitecturePlan, DesignReference |
| outputs         | ChangeSet, TestEvidence                        |
| target          | isolated git worktree                          |
| approval        | none                                           |
| retry           | max 2; then block                              |
| completion gate | tests.pass && artifact.ChangeSet.valid         |

## 9.3 Planning

The planner is a role, not a trusted source of truth. It proposes a typed MissionPlan. Tandemise validates that the plan is acyclic, all capabilities can be satisfied, required artifacts have producers, policies allow requested actions, and resource limits are feasible before execution begins.

## 9.4 Scheduler

- Chooses an eligible runtime based on role routing policy, capabilities, availability, concurrency limits, and user preference.

- Chooses or creates an execution target with the required isolation and application access.

- Acquires leases on shared resources such as repository branches or exclusive desktop applications.

- Starts tasks whose dependencies and gates are satisfied.

- Applies backoff, retries, fallbacks, and escalation rules.

- Never silently changes the mission goal or acceptance criteria.

# 10. Runtime Abstraction

## 10.1 Runtime contract

```typescript
interface AgentRuntimeAdapter {

discover(): Promise<RuntimeDiscovery>;

healthCheck(profile): Promise<RuntimeHealth>;

capabilities(profile): Promise<RuntimeCapabilities>;

start(request: RunRequest): AsyncIterable<RuntimeEvent>;

send?(session, message): AsyncIterable<RuntimeEvent>;

resume?(sessionRef, request): AsyncIterable<RuntimeEvent>;

cancel(runRef): Promise<void>;

usage?(runRef): Promise<UsageReport>;

}
```


## 10.2 MVP runtime adapters

| **Adapter**             | **MVP behavior**                                                                                                                                                                             |
|-------------------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Claude Code             | Detect local executable; invoke under the user's existing authenticated environment; prefer machine-readable/structured output when supported; capture session references; normalize events. |
| Codex CLI               | Same pattern: local executable, existing user authentication, structured/headless mode where available, normalized events, cancellation and resume when supported.                           |
| Generic process adapter | Fallback for CLIs that accept a task via stdin/arguments and emit parseable stdout; configurable by plugin.                                                                                  |

## 10.3 Subscription-aware design

Tandemise must never require users to export their Claude/ChatGPT session credentials into its database. It launches already-installed tools in the user environment. Authentication belongs to the runtime itself. Tandemise stores only runtime configuration, executable location, capabilities, usage observations, and session identifiers that are safe to persist.

## 10.4 Canonical event normalization

```typescript
type AgentEvent =

| { type: 'message'; text: string }

| { type: 'thinking_summary'; text: string }

| { type: 'tool.started'; tool: string; inputSummary: string }

| { type: 'tool.completed'; tool: string; outcome: 'ok'|'error' }

| { type: 'file.changed'; path: string; change: 'add'|'edit'|'delete' }

| { type: 'artifact.created'; artifactId: string }

| { type: 'approval.requested'; approvalId: string }

| { type: 'usage'; inputTokens?: number; outputTokens?: number; cost?: number }

| { type: 'checkpoint'; externalSessionId?: string }

| { type: 'completed'; resultRef?: string }

| { type: 'failed'; code: string; message: string; retryable: boolean };
```


## 10.5 Capability model

Runtime capability flags are descriptive, not authoritative permissions. A runtime may be capable of shell access, but a worker assignment still needs policy permission to use shell tools in a particular workspace.

```text
reasoning | vision | shell | filesystem | git | web | browser

mcp | structured_output | session_resume | tool_calling | computer_use
```

# 11. Execution Targets and Workspace Isolation

## 11.1 ExecutionTarget contract

```typescript
interface ExecutionTarget {

id: string;

type: 'local' | 'worktree' | 'docker' | 'browser' | 'remote';

capabilities(): Promise<TargetCapability[]>;

exec(command: ExecRequest): Promise<ExecResult>;

filesystem(): FileSystemHandle;

browser?(): BrowserHandle;

desktop?(): DesktopHandle;

}
```


## 11.2 Git worktree isolation

Every code-writing task runs in an isolated Git worktree and branch by default. Tandemise never allows two developer runs to modify the same working tree concurrently. This avoids agent collisions and makes every changeset independently inspectable and reversible.

```text
~/.tandemise/workspaces/<workspace-id>/

repos/<repo-id>/ # canonical mirror/reference

missions/<mission-id>/

worktrees/

task-implementation-a/

task-implementation-b/

task-review/

artifacts/

logs/

browser-profiles/
```


## 11.3 Merge/integration branch

When multiple development tasks run in parallel, Tandemise creates a mission integration branch. Successful task branches are merged in dependency order. Merge conflicts become explicit tasks assigned to an eligible developer role; they are never silently auto-resolved by infrastructure code.

## 11.4 Docker

Docker is optional in the MVP but supported as an execution target for repositories that already provide a containerized environment or when a user explicitly chooses stronger isolation. Tandemise must not require Docker for basic operation.

# 12. Integration and Tool Broker

## 12.1 Core rule

Integrations belong to Tandemise, not to individual agent runtimes. The Integration Broker exposes normalized capabilities and actions; runtime-specific mechanisms are adapters. This prevents a mission from breaking merely because a different agent is assigned to the same role.

## 12.2 Integration transports

| **Transport**        | **Use**                                                                                               |
|----------------------|-------------------------------------------------------------------------------------------------------|
| Native API/SDK       | Preferred for deterministic service operations and stable authorization.                              |
| MCP                  | Preferred when a vendor provides agent-oriented capabilities and the runtime can consume them safely. |
| CLI                  | Excellent for local developer tooling and existing authenticated sessions, e.g., git/gh/docker.       |
| Browser driver       | Use Playwright/DOM for web apps when APIs are unavailable or insufficient.                            |
| Desktop driver       | Use native accessibility/application control for installed applications as a fallback.                |
| Vision + coordinates | Last resort only; always verify state after action.                                                   |

## 12.3 Internal tool contract

```typescript
interface IntegrationTool {

name: string;

capability: string;

risk: 'read' | 'write_reversible' | 'external_side_effect' |

'destructive' | 'financial';

inputSchema: JsonSchema;

outputSchema: JsonSchema;

execute(ctx: ToolContext, input: unknown): Promise<ToolResult>;

}
```


## 12.4 MCP gateway

Tandemise should expose an ephemeral, run-scoped MCP gateway to runtimes that support MCP. The gateway publishes only the tools granted to the current worker assignment. A QA worker therefore cannot discover finance or production-write tools simply because those integrations exist in the workspace.

## 12.5 MVP integrations

| **Integration**             | **MVP strategy**                                                                                                                                                      |
|-----------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Git / GitHub                | Native Git commands plus GitHub via gh CLI initially. Read/write scopes are separate. Later replace or augment with GitHub App/OAuth.                                 |
| Figma                       | Generic MCP connector first; optionally direct REST read operations. If unsupported operation is required, use browser or macOS app driver under explicit permission. |
| Lovable / prototyping tools | Generic MCP connector if available; otherwise browser automation. Treated as prototype/design output, never source of production truth.                               |
| Local filesystem            | Scoped roots only. Workspace paths and artifact paths are explicit capabilities.                                                                                      |
| Browser                     | Playwright isolated contexts and profiles.                                                                                                                            |
| Generic REST                | User-configurable base URL, OAuth/token reference, OpenAPI/manual action schema; read/write actions permissioned separately.                                          |

# 13. Browser and Installed-App Control

## 13.1 Automation priority

```text
Native API / CLI / MCP

↓ if insufficient

Browser DOM / accessibility semantics

↓ if insufficient

Native desktop accessibility tree

↓ if insufficient

Screenshot + vision + coordinate action

↓ if unsafe/ambiguous

Human approval or intervention
```


## 13.2 Browser automation

Playwright is the primary browser control layer. Each role/task uses an isolated browser profile unless explicitly configured otherwise. Profiles can persist login state across missions while remaining separated by purpose, e.g., qa, product, finance.

- Primary targets: localhost/staging QA, authenticated web tools, screenshot capture, accessibility checks, network inspection, form interactions.

- Domain allowlists are enforced per worker assignment.

- Downloads are placed into mission-scoped directories.

- Browser screenshots and videos become artifacts.

- Production write operations remain subject to integration policy even when performed via browser.

## 13.3 macOS desktop control

The fully functional MVP targets macOS for generic installed-application control. A small signed Swift helper provides a stable native boundary while the rest of Tandemise remains TypeScript.

| **Native capability** | **Implementation**                                                                           |
|-----------------------|----------------------------------------------------------------------------------------------|
| Discover/launch apps  | NSWorkspace / Launch Services.                                                               |
| Inspect UI            | Accessibility API (AXUIElement) with role, title, value, enabled state, hierarchy, position. |
| Keyboard/mouse        | CGEvent with explicit permission checks.                                                     |
| Screenshots           | ScreenCaptureKit / CoreGraphics with window-scoped capture when possible.                    |
| Window metadata       | CGWindow APIs + Accessibility references.                                                    |
| App automation        | AppleScript/JXA optional driver for apps that expose useful scripting dictionaries.          |

## 13.4 Semantic desktop actions

Agent-facing tools should use semantic selectors such as app, window, accessibility role, label, and identifier. Raw coordinates are permitted only as a fallback and must be followed by screenshot or accessibility-state verification.

```typescript
desktop.launch({ app: 'Xcode' })

desktop.inspect({ app: 'Xcode', window: 'Beveloce' })

desktop.click({ role: 'AXButton', label: 'Run' })

desktop.shortcut(['CMD', 'R'])

desktop.screenshot({ app: 'iOS Simulator' })
```


## 13.5 App drivers

Generic desktop control is a fallback. Tandemise can provide optimized app drivers that combine CLI, accessibility, and application-specific semantics. Useful initial drivers include Xcode/iOS Simulator, Android emulator/adb, Figma, and Chrome. Drivers implement the same internal tool contract as external integrations.

# 14. Context, Memory, and Knowledge

## 14.1 No giant shared prompt

Tandemise must not solve memory by concatenating the entire organization into every prompt. Instead, a Context Compiler creates the smallest task-relevant context bundle from structured mission state, dependent artifacts, workspace knowledge, decisions, policies, and repository references.

## 14.2 Context layers

| **Layer** | **Examples**                                                                        |
|-----------|-------------------------------------------------------------------------------------|
| Role      | Responsibilities, boundaries, output contract, quality expectations.                |
| Workspace | Product vision, architecture principles, coding standards, design system, glossary. |
| Mission   | Goal, problem statement, constraints, success metrics, approved decisions.          |
| Task      | Exact objective, inputs, expected outputs, permitted tools, acceptance criteria.    |
| Evidence  | Relevant code paths, screenshots, analytics snippets, prior test reports.           |
| Policy    | What the worker may read/write/execute and which actions require approval.          |

## 14.3 Knowledge storage

MVP knowledge is deliberately simple: Markdown/text documents, structured decisions, artifact metadata, and repository indexes. Full semantic-vector memory is optional and should be introduced only when retrieval quality demonstrates a need. Exact references and explicit dependency links take precedence over fuzzy recall.

## 14.4 Decision memory

Important decisions are first-class records containing context, alternatives, rationale, consequences, related artifacts, and supersession links. A downstream role receives approved decisions automatically when they affect its task.

# 15. Artifact System

## 15.1 Why artifacts are central

Artifacts are the contract between organizational stages. A Product role should hand Engineering a ProductSpec artifact, not “whatever it said in chat.” QA should produce a QAReport with explicit checks and evidence, not a conversational assurance that things look fine.

## 15.2 Required artifact types

| **Artifact type**  | **Minimum contents**                                                              |
|--------------------|-----------------------------------------------------------------------------------|
| ProblemBrief       | Problem, user/context, evidence, constraints, success metric.                     |
| ProductSpec        | Scope, requirements, non-goals, acceptance criteria, edge cases.                  |
| DesignBrief        | Flows, states, design references, accessibility requirements, unresolved choices. |
| ArchitecturePlan   | Approach, components, data/API changes, risks, migration, test strategy.          |
| ImplementationPlan | Ordered changes, files/components, task split, dependencies.                      |
| ChangeSet          | Branch/commit refs, diff summary, tests executed, known limitations.              |
| ReviewReport       | Findings by severity, required fixes, architecture/spec compliance.               |
| QAPlan             | Test matrix mapped to acceptance criteria and risks.                              |
| QAReport           | Pass/fail per criterion, evidence, screenshots/video/logs, defects.               |
| ReleaseCandidate   | Integrated commit/tag, checks, unresolved risks, rollback note.                   |
| DecisionRecord     | Decision, rationale, alternatives, consequences, approver.                        |
| FinanceReport      | Read-only analysis output with source references and confidence.                  |

## 15.3 Storage

Artifact metadata and relationships live in SQLite; content lives in the artifact filesystem unless it is naturally represented by an external immutable reference such as a Git commit. Binary artifacts are content-addressed by hash to reduce duplication and improve reproducibility.

# 16. Built-in Organizational Roles

Roles are templates and may be customized per workspace. They do not carry independent long-term conversational memory; durable knowledge is injected from Tandemise state.

| **Role**         | **Responsibilities**                                                                                                   | **Typical tools**                                                  |
|------------------|------------------------------------------------------------------------------------------------------------------------|--------------------------------------------------------------------|
| Product Manager  | Clarify problem, inspect evidence, define scope, produce ProductSpec and acceptance criteria.                          | Analytics read, GitHub read, browser, workspace knowledge.         |
| Product Designer | Define flows/states, design references, accessibility and interaction behavior; create/update prototypes when allowed. | Figma, Lovable/prototyping, browser, desktop driver.               |
| Architect        | Produce technical approach and risks; validate boundaries and migration strategy.                                      | Repository read, docs, Git history, optional web.                  |
| Developer        | Implement approved plan in isolated worktree; add/update tests.                                                        | Filesystem write, shell, Git, tests, browser local.                |
| Reviewer         | Review diff independently against spec, architecture, standards, security, and maintainability.                        | Git diff/read, tests read, artifacts.                              |
| QA Engineer      | Create test plan, execute deterministic/browser tests, inspect UI/accessibility, report defects with evidence.         | Playwright, browser, local app/simulator, logs.                    |
| Release Manager  | Assemble release candidate and validate gates; never deploy production without approval.                               | GitHub, CI read, Git/tag actions, release notes.                   |
| Finance Analyst  | Read-only business/usage analysis to prove Tandemise can orchestrate non-code roles.                                   | Read-only REST/browser integrations; no money-moving capabilities. |

## 16.1 Role independence

The same runtime can temporarily perform multiple roles, but Tandemise creates separate run contexts. Reviewer and QA should not automatically inherit the Developer run transcript; they receive the relevant artifacts and evidence so they can evaluate independently.

# 17. Evaluation and Quality Gates

## 17.1 Evaluation hierarchy

1.  Deterministic checks first: schema validation, Git cleanliness, compile/typecheck, lint, unit/integration tests, browser assertions, accessibility tests.

2.  Rule-based evaluation second: required artifacts present, acceptance criteria mapped, prohibited file/path changes absent.

3.  Independent evaluator role third: review qualitative architecture, UX, product compliance, edge cases, and maintainability.

4.  Human approval last for consequential decisions and release.

## 17.2 Gate model

```yaml
Gate: ready_for_qa

require:

- artifact.ChangeSet.exists

- checks.typecheck == PASS

- checks.tests == PASS

- review.blocking_findings == 0


Gate: ready_to_ship

require:

- qa.acceptance_criteria_coverage == 100%

- qa.blocking_defects == 0

- security.required_checks == PASS

- approval.release_candidate == APPROVED
```


## 17.3 Evaluator independence

Where practical, the evaluator uses a different run context and may use a different runtime from the implementer. Tandemise should prefer deterministic evidence over model self-assessment. “The developer says it is done” is never a gate condition.

# 18. Human Authority and Approvals

## 18.1 Approval inbox

All human decisions appear in one queue with concise evidence, recommendation, alternatives, risk, and the exact action that will occur if approved. The goal is to reduce human time without hiding responsibility.

## 18.2 Default risk model

| **Risk class**       | **Examples**                                                | **Default**                                           |
|----------------------|-------------------------------------------------------------|-------------------------------------------------------|
| Read                 | Read repo, inspect Figma, query analytics.                  | Auto-allow within granted scope.                      |
| Write reversible     | Edit worktree, create local artifact, create draft branch.  | Auto-allow within mission workspace.                  |
| External side effect | Create PR, issue, comment, update design document.          | Policy-controlled; usually allow after plan approval. |
| Destructive          | Delete remote branch, force push, remove production data.   | Human approval required.                              |
| Financial            | Refund, purchase, payment, billing change.                  | Disallowed in MVP.                                    |
| Release/production   | Merge protected branch, deploy production, publish release. | Human approval required.                              |

## 18.3 Decision types

- Plan approval: approve or edit proposed mission plan.

- Choice approval: select among product/design/architecture alternatives.

- Exception approval: grant temporary permission outside default policy.

- Release approval: authorize merge/deploy/publish action.

- Intervention request: worker is blocked by ambiguity, login, CAPTCHA, unsupported UI, or an unsafe operation.

# 19. Security and Permissions

## 19.1 Threat model

The primary threats are over-permissioned agents, prompt-injected external content, accidental destructive shell commands, leakage of credentials, browser-session crossover, malicious repository content, and a compromised runtime attempting actions beyond its role.

## 19.2 Core controls

- Default deny: no tool, path, domain, app, or integration action is available without a grant.

- Secrets live in macOS Keychain or existing authenticated CLIs; database stores opaque credential references.

- Run-scoped tool gateway publishes only granted tools.

- Filesystem scopes are explicit roots; sensitive home directories are not globally exposed.

- Browser profiles are separated by role/purpose and domain allowlists.

- Desktop app access is allowlisted per role and mission.

- Shell commands are logged; risky command patterns may require approval.

- External content is treated as untrusted data and cannot silently change policy/instructions.

- All side effects are attributable in the event log.

- Production and financial capabilities are excluded or approval-gated in MVP.

## 19.3 Prompt-injection boundary

Instructions originating from web pages, repository files, emails, issue descriptions, design comments, or other external content are data, not policy. The Context Compiler marks trusted system/role instructions separately from untrusted evidence. Integration tools cannot grant new permissions based on content returned by those tools.

# 20. Persistence and Data Model

## 20.1 Storage choices

| **Store**           | **Purpose**                                                                             |
|---------------------|-----------------------------------------------------------------------------------------|
| SQLite (WAL mode)   | Transactional domain state, event log, metadata, projections, run/session state.        |
| Filesystem          | Artifact bodies, screenshots, videos, exported reports, run logs, browser profiles.     |
| Git                 | Source-code truth, branches, commits, diffs, repository history.                        |
| OS credential store | Tokens/secret values when Tandemise must own them; preferably reuse authenticated CLIs. |

## 20.2 Recommended core tables

```text
workspaces

repositories

missions

mission_tasks

task_dependencies

role_templates

runtime_profiles

execution_targets

integrations

integration_grants

worker_assignments

runs

run_events

artifacts

artifact_links

decisions

approvals

policies

evaluations

check_results

resource_leases

checkpoints

usage_records
```


## 20.3 Event log + projections

Tandemise uses an append-only run event log for audit/recovery plus normalized current-state tables for efficient queries. It is not necessary to implement full event sourcing for every domain entity; the event log exists primarily for run reconstruction, debugging, streaming, and reliable recovery.

## 20.4 Migrations

All database changes use ordered migrations checked into source control. The daemon performs compatibility checks before startup. A desktop auto-update must never open a newer database using an older binary.

# 21. Process Supervision and Recovery

## 21.1 Supervisor responsibilities

- Spawn worker processes with controlled environment variables and working directories.

- Capture stdout/stderr/PTY streams without blocking.

- Maintain process IDs and runtime session references.

- Emit heartbeats for long-running processes.

- Apply cancellation escalation: graceful request → SIGTERM → forced termination.

- Write checkpoints after durable milestones.

- Detect abandoned leases and orphaned “running” records at daemon startup.

## 21.2 Startup recovery

5.  Open DB and verify migrations.

6.  Acquire single-daemon instance lock.

7.  Find runs whose state was RUNNING when the daemon exited.

8.  Check whether child process/session still exists.

9.  If runtime supports session resume, mark RESUMABLE and offer/perform policy-based resume.

10. Otherwise mark INTERRUPTED and schedule retry from the last durable artifact/checkpoint.

11. Release stale resource leases only after verifying no active process owns them.

12. Rebuild mission projections and notify UI.

## 21.3 Idempotency

Integration writes that can create external duplicates must use idempotency keys when available. Tandemise stores external object identifiers immediately after creation. Retries must verify prior effects before repeating a create operation.

# 22. Observability and Usage

## 22.1 Trace hierarchy

```text
Workspace

Mission

Task

Run / attempt

Runtime events

Tool calls

File changes

Artifacts

Check results

Approval requests
```


## 22.2 UI metrics

- Mission wall-clock time.

- Agent/runtime active time.

- Human wait time and human interaction time.

- Number of retries and failures.

- Runtime/model usage when exposed by the runtime.

- Estimated direct API cost only when reliable; subscription usage may be displayed as usage observations rather than fabricated cost.

- Files changed, commits, tests, review findings, QA defects.

- Time spent blocked on approvals.

- Runtime fallback events and quota/rate-limit failures.

## 22.3 Log hygiene

Logs are structured and redact secret values. Tool inputs that may contain sensitive content should store safe summaries in the main event log and optionally a locally encrypted full payload only when the user enables diagnostic retention.

# 23. Desktop UX

## 23.1 Primary navigation

| **Surface**    | **Purpose**                                                                                      |
|----------------|--------------------------------------------------------------------------------------------------|
| Home           | Active missions, blocked work, approvals, recent outcomes, runtime health.                       |
| Missions       | Create, inspect, pause, resume, cancel, duplicate, archive missions.                             |
| Mission Detail | Plan DAG, stage, task cards, live timeline, artifacts, decisions, checks, branches, costs/usage. |
| Approvals      | Single inbox for plan, permission, choice, and release decisions.                                |
| Workforce      | Role templates, preferred runtimes, capabilities, concurrency and fallback routing.              |
| Runtimes       | Detected Claude Code/Codex/etc., health, executable path, session capability, routing priority.  |
| Integrations   | GitHub, MCP, REST, browser profiles, Figma/prototyping connections and permissions.              |
| Machines       | Local execution target and future remote nodes; tool availability and status.                    |
| Artifacts      | Searchable specs, plans, screenshots, reports, decisions, release candidates.                    |
| Settings       | Security defaults, workspace paths, update channel, logs, developer mode.                        |

## 23.2 Mission creation

The default new-mission form contains outcome, workspace/repository, optional constraints, workflow preset, and autonomy level. Advanced routing remains optional. A user should be able to start with one natural-language sentence and inspect the proposed plan before execution.

## 23.3 Mission detail behavior

The UI should show semantic events rather than terminal noise by default: “Product spec created,” “Developer changed 8 files,” “Typecheck passed,” “Reviewer found 2 blocking issues,” “QA captured 4 screenshots.” A raw terminal/log view exists for debugging but is secondary.

## 23.4 Approval UX

> **Approval design requirement.** Every approval card must answer: What is being requested? Why? What evidence supports it? What changes if I approve? What is the risk? Can I choose an alternative? The user should never need to open five agent transcripts to make one decision.

# 24. End-to-End Reference Mission

Reference mission: “Improve Beveloce onboarding so users can finish setup with fewer steps; preserve existing authentication behavior; update web UI and tests; do not deploy production.”

13. User creates mission and selects repository.

14. Planner proposes a DAG: Product analysis → Design → Architecture → Implementation → Review → QA → Release Candidate.

15. Tandemise validates the plan and requests plan approval if workspace policy requires it.

16. Product role receives mission context, current analytics/read-only evidence if connected, and relevant repository/product docs. It creates ProblemBrief + ProductSpec.

17. Design role receives ProductSpec and design-system context. It may read/write Figma via permitted MCP integration or create a prototype through a configured prototyping connector. DesignBrief becomes the durable output.

18. Architect reads ProductSpec, DesignBrief, repository architecture, and relevant decisions. It produces ArchitecturePlan + ImplementationPlan.

19. Developer runs in a new Git worktree using preferred runtime (for example Codex). It implements changes, runs tests, and produces ChangeSet.

20. Reviewer runs independently (for example Claude Code) against the spec, architecture plan, diff, and repository standards. Blocking findings create fix tasks automatically.

21. Developer fixes findings. Deterministic gates rerun.

22. QA creates QAPlan mapped to acceptance criteria, starts the application, runs Playwright, screenshots key states, checks accessibility, and produces QAReport.

23. If QA fails, defects become tasks routed back to development; affected tests are rerun after fixes.

24. When all gates pass, Release Manager builds ReleaseCandidate with final commit, checks, release notes, and known risks.

25. Tandemise presents one “Ready to Ship” approval. Production merge/deployment remains outside automatic authority.

26. All mission artifacts, decisions, events, branches, usage, and evidence remain inspectable after completion.

# 25. Extensibility and Plugin Model

## 25.1 Plugin categories

| **Plugin type**    | **Examples**                                                               |
|--------------------|----------------------------------------------------------------------------|
| Runtime adapter    | Claude Code, Codex, OpenCode, DeepSeek Harness, custom CLI.                |
| Integration        | GitHub, Figma, Linear, PostHog, Sentry, Stripe read-only.                  |
| Execution target   | Docker, SSH node, cloud VM.                                                |
| Desktop app driver | Xcode, Simulator, Figma Desktop, Photoshop.                                |
| Artifact/evaluator | Security report, accessibility report, visual diff.                        |
| Workflow preset    | Feature delivery, bug investigation, dependency upgrade, finance analysis. |

## 25.2 Plugin isolation

The MVP may load first-party plugins in-process, but interfaces should allow later migration to out-of-process plugins. Third-party arbitrary code loading is not required for v0.1; avoiding it significantly reduces security and packaging risk.

## 25.3 Capability registration

Plugins register capability descriptors, action schemas, risk levels, health checks, and optional UI settings. Workflows reference capabilities, never package names.

# 26. Repository and Package Structure

```text
tandemise/

apps/

desktop/ # Electron main/preload + React shell

daemon/ # tandemd bootstrap and API

packages/

domain/ # entities, value objects, domain rules

application/ # mission services, scheduler, planning, gates

persistence/ # SQLite repositories + migrations

artifacts/ # artifact store and schemas

events/ # canonical event types and projections

runtimes-core/ # runtime contracts and manager

runtime-claude/ # Claude Code adapter

runtime-codex/ # Codex adapter

execution-core/ # target contracts, process supervisor

execution-local/ # local/worktree execution

execution-docker/ # optional Docker target

integrations-core/ # tool broker, grants, MCP gateway

integration-github/ # git + gh

integration-mcp/ # generic MCP client/server bridge

browser/ # Playwright profiles and tools

policy/ # permissions, risk, approvals

context/ # context compiler and workspace knowledge

evaluation/ # checks, evaluator contracts, quality gates

shared/ # ids, schemas, errors, utilities

native/

macos-helper/ # Swift Accessibility / ScreenCapture / input

docs/

architecture/

adr/
```


## 26.1 Dependency direction

Provider-specific packages may depend inward on contracts; domain/application packages never depend outward on providers. A lint rule or TypeScript project-reference boundary should enforce this mechanically.

# 27. Core Interfaces and Schemas

## 27.1 Task specification

```typescript
interface MissionTask {

id: TaskId;

missionId: MissionId;

title: string;

objective: string;

role: RoleId;

dependencies: TaskId[];

requiredCapabilities: Capability[];

inputArtifacts: ArtifactRequirement[];

expectedOutputs: ArtifactContract[];

executionPolicy: ExecutionPolicy;

approvalPolicy: ApprovalPolicy;

retryPolicy: RetryPolicy;

completionGate: GateExpression;

}
```


## 27.2 Worker assignment

```typescript
interface WorkerAssignment {

role: RoleTemplateRef;

runtime: RuntimeProfileRef;

target: ExecutionTargetRef;

grants: CapabilityGrant[];

contextBundle: ContextBundleRef;

budgets: {

maxWallTime?: number;

maxAttempts?: number;

maxUsageUnits?: number;

};

}
```


## 27.3 Artifact manifest

```typescript
interface ArtifactManifest {

id: ArtifactId;

type: ArtifactType;

missionId: MissionId;

taskId?: TaskId;

createdByRunId: RunId;

contentRef: string;

mediaType: string;

sha256: string;

schemaVersion: number;

sourceRefs: ExternalRef[];

supersedes?: ArtifactId;

createdAt: string;

}
```


## 27.4 Tool grant

```typescript
interface CapabilityGrant {

subject: WorkerAssignmentId;

capability: string; // e.g. github.pr.create

resourceScope?: string[]; // repo/domain/path/app restrictions

conditions?: PolicyCondition[];

expiresAt?: string;

approvalMode: 'auto' | 'ask' | 'deny';

}
```

# 28. Testing Strategy

## 28.1 Test pyramid for Tandemise itself

| **Layer**   | **Coverage**                                                                                                          |
|-------------|-----------------------------------------------------------------------------------------------------------------------|
| Unit        | Domain rules, DAG validation, policy evaluation, routing, artifact schemas, event reducers.                           |
| Contract    | Every runtime adapter against common fixture tests; every integration tool against schemas and risk metadata.         |
| Integration | SQLite repositories, Git worktrees, process supervisor, Playwright profiles, daemon API, MCP gateway.                 |
| End-to-end  | Real local repository with fake runtime + real Claude/Codex smoke tests behind opt-in environment flags.              |
| Recovery    | Kill daemon/process mid-run, restart, verify leases/checkpoints/status and no duplicate side effects.                 |
| Security    | Permission bypass attempts, path traversal, unauthorized tool discovery, secret redaction, prompt-injection fixtures. |
| Desktop     | Electron UI against daemon fixtures; native macOS helper accessibility/screenshot tests.                              |

## 28.2 Fake deterministic runtime

A deterministic fake agent runtime is mandatory. It consumes scripted task fixtures and emits canonical events/tool requests. Most orchestration tests must not depend on paid models or nondeterministic external behavior.

## 28.3 Golden mission fixtures

- Simple code change with passing tests.

- Review rejects implementation, then developer fixes.

- QA failure creates defect and loopback task.

- Runtime quota failure causes configured fallback.

- Daemon crash during tool call and recovery.

- Git merge conflict creates explicit resolution task.

- Denied production action generates approval instead of executing.

- Prompt-injected web content cannot expand permissions.

# 29. Implementation Plan

The implementation order intentionally builds the architecture before broad integrations. Each phase must end with a usable vertical slice rather than an isolated subsystem.

| **Phase**               | **Deliverable**                                                                                    | **Exit condition**                                                                              |
|-------------------------|----------------------------------------------------------------------------------------------------|-------------------------------------------------------------------------------------------------|
| 0 - Foundation          | Monorepo, domain contracts, SQLite migrations, tandemd API, Electron shell, event stream.          | UI connects to daemon; workspace/missions persist across restarts.                              |
| 1 - Single worker       | Runtime discovery + Claude adapter + process supervisor + local repository/worktree + live events. | One mission task can safely run Claude Code in an isolated worktree and produce an artifact.    |
| 2 - Multi-role workflow | Planner, DAG scheduler, Product/Developer/Reviewer/QA role templates, artifacts, gates, approvals. | End-to-end mission runs through review/QA with fake runtime and one real runtime.               |
| 3 - Runtime agnosticism | Codex adapter, capability routing, fallback, concurrency limits.                                   | Same mission can swap Developer runtime without workflow changes.                               |
| 4 - Browser QA          | Playwright profiles, localhost/staging control, screenshots, accessibility/test evidence.          | QA role validates a real UI and produces evidence-backed QAReport.                              |
| 5 - Integrations        | GitHub via gh, generic MCP gateway/client, Figma/prototyping connector pattern.                    | Mission can consume/produce at least one external artifact and create a GitHub PR under policy. |
| 6 - Desktop control     | Swift helper, macOS Accessibility, app launch/inspect/click/type/screenshot, app permissions.      | Agent can safely perform a scripted task in an allowlisted installed app and verify result.     |
| 7 - Recovery/security   | Restart recovery, leases, retries, secret redaction, permission hardening, idempotency checks.     | Kill/restart tests pass without state loss or duplicate side effects.                           |
| 8 - Polish              | Approvals inbox, workforce/runtimes/settings UX, mission history, packaging/signing.               | Daily-use quality for a single technical user on macOS.                                         |

# 30. MVP Acceptance Criteria

Tandemise v0.1 is “fully functional” only if all of the following are true on a clean supported macOS installation:

- [ ] The desktop app installs and launches tandemd without requiring a cloud account.

- [ ] Tandemise discovers both Claude Code and Codex when installed and reports runtime health.

- [ ] The user can select a local Git repository and create a workspace.

- [ ] The user can create a mission from natural language and inspect a typed proposed plan.

- [ ] The plan executes as a DAG through at least Product, Developer, Reviewer, and QA roles.

- [ ] Developer work happens in an isolated Git worktree and results in a reviewable changeset.

- [ ] At least one mission can use Claude Code for one role and Codex for another without changing workflow semantics.

- [ ] Runtime events are normalized and visible in one mission timeline.

- [ ] ProductSpec, Architecture/Implementation Plan, ChangeSet, ReviewReport, QAReport, and ReleaseCandidate artifacts persist after restart.

- [ ] Blocking reviewer findings generate fix work and prevent QA/release progression.

- [ ] QA runs real browser automation with screenshots and acceptance-criteria evidence.

- [ ] GitHub integration can read repository/PR state and create a draft PR only when policy permits it.

- [ ] Generic MCP integration can expose a granted external tool to an eligible worker without exposing unrelated workspace tools.

- [ ] macOS desktop control can launch and inspect an allowlisted application, invoke a semantic UI action, and capture evidence.

- [ ] Desktop/app/browser/file/integration permissions are deny-by-default and visible to the user.

- [ ] Production release actions require explicit approval.

- [ ] Killing the desktop window does not stop the daemon; killing/restarting the daemon does not lose durable mission state.

- [ ] Interrupted runs are marked correctly and resumed/retried according to runtime capability and policy.

- [ ] Raw credentials are not stored in SQLite when an existing CLI session or OS credential reference can be used.

- [ ] The user can cancel a running mission and no background worker remains orphaned.

- [ ] The full reference mission can produce a release candidate with no manual copy/paste between agent applications.

# 31. Post-MVP Expansion

| **Area**               | **Post-MVP direction**                                                                                                        |
|------------------------|-------------------------------------------------------------------------------------------------------------------------------|
| Remote workers         | Signed Tandemise node daemon over mutually authenticated connection; route jobs to home server/cloud VM.                      |
| Cross-platform desktop | Windows UI Automation and Linux AT-SPI/Wayland/X11 adapters.                                                                  |
| Multi-user             | Organization accounts, human RBAC, shared approvals, synchronized state.                                                      |
| Cloud control plane    | Optional encrypted sync, remote notifications, execution fleet management.                                                    |
| More runtimes          | OpenCode, DeepSeek Harness, Gemini CLI, local inference, API-native runtimes.                                                 |
| More integrations      | Linear, Sentry, PostHog, Stripe read-only then carefully gated writes, AWS, Vercel, Slack, Google Workspace.                  |
| Design evaluation      | Automated visual regression against Figma/design references, design-token consistency checks.                                 |
| Finance/operations     | Recurring reports, anomaly detection, budgets, vendor-cost optimization, but money-moving actions remain separately governed. |
| Marketplace            | Signed out-of-process plugins with permission manifests and review model.                                                     |
| Learning               | Workspace-level policy/recommendation learning from explicit user corrections, never silent authority expansion.              |

# 32. Risks and Mitigations

| **Risk**                                    | **Mitigation**                                                                                                                                        |
|---------------------------------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------|
| Runtime CLI changes break adapters          | Strict adapter boundary, health checks, contract tests, version detection, graceful degradation.                                                      |
| Agent hallucination/poor judgment           | Typed artifacts, deterministic gates, independent review, evidence requirements, approval boundaries.                                                 |
| Prompt injection from external content      | Trust labels, context separation, deny-by-default tools, policies never writable by agent content.                                                    |
| Desktop automation fragility                | Prefer API/MCP/CLI/DOM/Accessibility; coordinate+vision only fallback; app-specific drivers.                                                          |
| Credential leakage                          | Reuse authenticated CLIs, OS keychain, secret redaction, minimal environment propagation.                                                             |
| Concurrent agents corrupt repository        | Isolated worktrees, resource leases, integration branch, no shared writable tree.                                                                     |
| Duplicate external side effects after crash | Idempotency keys, external IDs, side-effect checkpoints, verify-before-retry.                                                                         |
| Subscription quotas stall workflows         | Runtime health/availability, explicit fallback policies, pause/block instead of uncontrolled retry loops.                                             |
| Electron attack surface                     | Context isolation, no Node in renderer, restrictive CSP, signed builds, daemon auth.                                                                  |
| Architecture becomes “framework soup”       | Keep domain model small; adapters around providers; no orchestration logic in integration packages.                                                   |
| MVP scope explodes                          | Software-delivery reference workflow is the acceptance target; finance and broad operations remain demonstration capability, not breadth requirement. |

# 33. Architectural Decision Summary

| **Decision**      | **Choice**                                         | **Reason**                                                                                                |
|-------------------|----------------------------------------------------|-----------------------------------------------------------------------------------------------------------|
| Desktop framework | Electron + React + TypeScript                      | Fastest fit for Node process/CLI orchestration and user skill set; isolate privileged code from renderer. |
| Background core   | Separate tandemd Node process                      | Keeps work alive, enables recovery/CLI/remote future, prevents UI from becoming architecture.             |
| Persistence       | SQLite WAL + filesystem artifact store             | Local, transactional, zero-admin, adequate for one-user workload.                                         |
| Runtime design    | Adapter + capability model                         | Allows Claude Code, Codex, future runtimes and subscription-based CLIs to be replaceable.                 |
| Coordination      | Typed mission DAG + artifacts                      | More reliable than agent chat; enables gates, recovery, independent evaluation.                           |
| Tool design       | Integration Broker + run-scoped MCP gateway        | Tools are workspace resources and can be shared safely across runtimes.                                   |
| Code isolation    | Git worktree per writing task                      | Prevents concurrent corruption and produces naturally reviewable changesets.                              |
| Browser           | Playwright                                         | Semantic, deterministic, scriptable, evidence-friendly.                                                   |
| Desktop control   | Native Swift helper on macOS                       | Reliable Accessibility/ScreenCapture/input boundary without coupling core to Swift.                       |
| Security          | Default-deny capabilities + risk/approval policy   | Preserves human authority and limits runtime compromise.                                                  |
| Memory            | Context Compiler over durable artifacts/decisions  | Avoids giant prompts and keeps organizational truth outside agent sessions.                               |
| Recovery          | Append-only run events + checkpoints + projections | Auditability and reliable restart behavior without full event-sourced complexity.                         |

# Appendix A. Example Workspace Configuration

```yaml
workspace: beveloce

repository: ~/Projects/beveloce


autonomy:

plan_approval: ask

local_code_changes: auto

external_writes: policy

production_release: ask

financial_actions: deny


routing:

product: [claude]

design: [claude, codex]

architecture: [claude]

development: [codex, claude]

review: [claude, codex]

qa: [codex, claude]


concurrency:

max_total_workers: 3

claude: 2

codex: 2


integrations:

github:

transport: gh-cli

permissions: [repo.read, pr.read, pr.create_draft]

figma:

transport: mcp

permissions: [design.read, design.write]

browser:

profile: qa

allowed_domains: [localhost, staging.example.com]
```

# Appendix B. Example Mission Plan

```yaml
mission: onboarding-v2


tasks:

- id: product_spec

role: product

outputs: [ProductSpec]


- id: design

role: design

depends_on: [product_spec]

outputs: [DesignBrief]


- id: architecture

role: architecture

depends_on: [product_spec, design]

outputs: [ArchitecturePlan, ImplementationPlan]


- id: implement

role: development

depends_on: [architecture]

outputs: [ChangeSet]

gate: tests.pass && typecheck.pass


- id: review

role: review

depends_on: [implement]

outputs: [ReviewReport]

gate: blocking_findings == 0


- id: qa

role: qa

depends_on: [review]

outputs: [QAReport]

gate: acceptance_criteria.pass == 100%


- id: release_candidate

role: release

depends_on: [qa]

outputs: [ReleaseCandidate]

approval: required
```

# Appendix C. Recommended Technology Stack

| **Layer**         | **Recommendation**                                                                               |
|-------------------|--------------------------------------------------------------------------------------------------|
| Desktop           | Electron, React, TypeScript, Vite.                                                               |
| Daemon            | Node.js + TypeScript.                                                                            |
| API               | HTTP/JSON + WebSocket on loopback with authenticated session.                                    |
| Validation        | Zod / JSON Schema.                                                                               |
| Database          | SQLite in WAL mode; Drizzle or a thin SQL repository layer.                                      |
| Queue/scheduling  | In-process durable scheduler backed by DB state; avoid Redis for local MVP.                      |
| Process execution | child_process for structured commands; node-pty only where interactive TTY is actually required. |
| Git               | git CLI + worktree manager; optional lib only for read helpers.                                  |
| Browser           | Playwright.                                                                                      |
| MCP               | Official TypeScript MCP SDK or equivalent stable implementation behind internal abstraction.     |
| Native macOS      | Swift executable/helper using Accessibility, NSWorkspace, ScreenCaptureKit, CGEvent.             |
| Logging           | Structured JSON logs with mission/task/run correlation IDs.                                      |
| Tests             | Vitest/Jest, Playwright, deterministic fake runtime, fixture repositories.                       |
| Packaging         | electron-builder/electron-forge, code signing, notarization for distributable macOS builds.      |

# Closing Architectural Position

Tandemise should be judged by a simple test: if Claude Code disappears tomorrow, or Codex becomes better, or Figma changes its preferred integration mechanism, the organization should continue to exist. Missions, roles, decisions, artifacts, permissions, policies, and history remain intact. Only an adapter changes.

That separation is the product. The MVP is successful when one developer can assign an outcome once, supervise only the decisions that deserve human judgment, and receive a verified release candidate produced by a coordinated, inspectable, replaceable AI workforce operating real tools on real machines.
