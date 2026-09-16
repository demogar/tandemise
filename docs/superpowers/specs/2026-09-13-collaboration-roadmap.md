# Collaboration roadmap: feedback loops, short output, and teams

Status: agreed direction (2026-09-13). Each sub-project below gets its own
design spec and implementation plan before any code is written.

## The problems

1. **You cannot iterate.** A mission runs until it is done. There is no way to
   give feedback on a task's output and get a new version. The engine can
   partly do this, but the app does not expose it:
   - Rejecting an output approval with a note does create a revision. It only
     works at planned approval gates, and it clones the task (`remediation.ts`).
   - Retry-with-note exists in the API. The app has no note field, and the
     agent is told the note is a gate failure (`task-executor.ts:843`).
   - A retry does not see its own previous output (`#loadDependencies`).
   - Notes left when *approving* never reach any prompt.
   - The user cannot message a running agent. Finished sessions are never
     resumed with new instructions.
2. **Output is too long to read.** A real mission (`msn_01m2bgw745qs9djk64f1`)
   produced 31 artifacts and about 300 KB of text. Design briefs average 35 KB.
   - No artifact has a real summary. The list shows the first paragraph cut
     at 300 characters.
   - Titles are sentences.
   - Front matter renders as garbled text.
   - Superseded versions stay in the list.
   - Approval evidence shows raw `art_…` ids.
3. **The system assumes one person and AI doing everything.** In practice,
   people build software in very different setups (below). Tandemise has to
   fit all of them.

## Scenarios Tandemise must serve

| # | Who | What they need |
|---|-----|----------------|
| 1 | Solo, delegates everything | Short handoffs, few interruptions, quick tweaks |
| 2 | Solo, brings their own work (a spec, a Figma file, a Lovable prototype, a branch) | Uploads, skipping stages that are already covered, continuing in their own tool and handing back |
| 3 | Team where one person runs Tandemise and teammates contribute in their tools | Roles staffed by people, hand-backs via links or PRs, feedback from where teammates already comment |
| 4 | Team inside Tandemise, everyone with a seat | Accounts, per-person inboxes, routing by role, attribution, permissions |

All four are in scope.

## Principles

0. **Someone real is responsible.** Every task, output and decision has a
   responsible person, and that person is always a real human. Agents can do
   the work, but they are never the responsible party. Whenever the product
   says "who", it means a real person who answers for the work.
1. **Roles are staffed, not assumed.** A role or task is assigned to a
   member: a person, an agent, or a pool of members. The default is set per
   workspace, and a mission or task can override it. Reviews and staffing are
   as configurable as possible, with presets on top.
2. **Every contribution is authored and typed.** Agent rounds, human rounds,
   uploads, external hand-backs and feedback all use the same handoff
   contract. Each carries an author (human or agent).
3. **Nothing is specific to a stage.** Workspace links, hand-backs, snapshots
   and feedback work the same way for specs, designs, code, QA, marketing,
   finance, or anything else an integration can read.
4. **A human reads a handoff, not a document.** The default view of any output
   is a headline, up to 3 points, what is needed from the reader, and what
   changed. The full document is one click away.
5. **Tandemise owns the state (ADR 0001).** When work happens in an external
   tool, handing it back pins a snapshot. Downstream work uses exactly that
   version.

## Decisions

- **Iteration model: rounds within the same task.** Feedback sends a task
  back to work as round N+1. The runtime session is resumed when possible;
  otherwise the round gets the previous output plus all feedback. Artifacts
  are versioned. This replaces revision clones. The automatic review → fix
  loop keeps creating separate fix tasks, because the fixer is a different
  role.
- **Notes on a running task** are delivered when its current pass ends, by
  resuming the session before the task is marked done. Runtimes that can
  accept a message mid-run receive it right away.
- **Downstream impact: ask each time.** When feedback touches a task whose
  output later tasks already used, Tandemise shows those tasks. The person
  chooses to redo them or keep them.
- **Main surface: the handoff feed.** A mission opens on one card per step:
  what it needs from you, and what you got. Artifacts become reference
  material.
- **Handoff block, validated.** Every artifact has a required `handoff` block:
  - `headline`: 90 characters or fewer.
  - `points`: 3 or fewer, 140 characters or fewer each.
  - `needs`: optional.
  - `changed`: required from round 2 onward, and points at feedback ids.
  - `links`: optional. `kind: workspace` means "the real work lives here".

  Titles are 60 characters or fewer. The manifest summary becomes the
  headline.
- **Length budgets per type.** Each type has a word budget for the main body.
  Detail goes under `## Appendix`, which may be up to 2× the budget and is
  collapsed in the app. Over budget: one "tighten" pass in the same session,
  then the artifact is accepted with an over-budget flag. Length never blocks
  a mission.
- **Uploads** are accepted at mission creation, on feedback, and as
  hand-backs. An intake task turns them into typed artifacts. The planner may
  skip a stage that an upload already covers, but it has to say so in the
  plan.
- **External hand-back.** "I'll continue there" parks the task
  (`AWAITING_EXTERNAL`). Handing back a link or file creates a human-authored
  round. The integration snapshots the referenced version into Evidence. If
  no integration can read the link, an attached export is required.
## People, agents and responsibility

This model is borrowed from Block's Buzz ([block/buzz](https://github.com/block/buzz)).
The borrowed parts are its owned-agent model (NIP-OA, NIP-AA) and
owner-reviewed drafts. Its chat and Nostr protocol parts are not used.

- **Members.** A workspace's members are people and agents. A person does not
  need an account: the operator can record work on that person's behalf, and
  an invite attaches an account later. Every agent has an **owner**, and the
  owner is a person.
- **Team tree.** Areas such as Design, Engineering, QA and Finance have a lead.
  People and agents sit below the lead. Agents connect to tools (Figma, Open
  Design, …) or to the person they work for.
- **Responsible person.** By default this is the nearest person above whoever
  did the work. Work can also be explicitly delegated to someone further down.
  Each area chooses its oversight rule: either "the delegate owns it and the
  lead oversees", or "both sign off".
- **Asking and escalation.** Approvals, questions and "done" notices go to the
  responsible person. If that person does not respond, the request moves up
  the tree to the workspace owners. Reviews go to the responsible person unless
  staffing configures something else.
- **Authority.** An agent's effective permissions are its own grants
  intersected with its owner's current permissions. Removing a person disables
  that person's agents.
- **Records.** Every contribution stores who did it (the agent or person), who
  is responsible, and who recorded it. None of these fields replaces another.
- **Wake rules** (who can steer a running agent, and whether a new message
  queues, steers or interrupts the current task) belong to P2.

## Server, accounts and permissions

- **The server is the product.** Tandemise ships as a server that runs in
  Docker (`docker compose up`). Opening its URL starts a setup wizard: create
  the owner account and name the org, connect repos, integrations and
  runtimes, build the team tree, and invite people.
- **Solo use needs no Docker.** The desktop app can start the same server
  locally. Moving that setup to Docker later is an export followed by an
  import.
- **Runners do the agent work.** The server holds missions, people, approvals,
  configuration and history. Runners execute agent work, either inside the
  server container (headless coding) or on a member's machine. Work that needs
  subscription logins, local repos, desktop control or a real browser runs on
  a member's machine. A member's desktop app acts as the runner for that
  member's own agents.
- **Registration is invite-only.** There is no public sign-up. Owners and
  admins create single-use, expiring invite links, and each link presets a
  permission level and a place in the team tree. Sign-in is by passkey or
  password; SSO comes later.
- **Permission levels** control what a person may do. They are separate from
  the team tree, which controls what a person is responsible for.

  | Level | Can |
  |-------|-----|
  | Owner | Everything. Only owners manage admins, transfer ownership and delete the org. There is always at least one owner. |
  | Admin | Invite and remove people; manage integrations, secrets, runtimes, staffing, workflows and policies |
  | Member | Create missions, work and approve within their areas, bring their own agents |
  | Guest | Only the missions they are invited to: review, comment, and approve what is assigned to them |

- **Shared and personal state.** Shared state lives on the server and is the
  same for everyone: projects, repos, roles, the team tree, staffing,
  workflows, policies and org integrations. Every change to it is attributed.
  Personal state stays on each machine: theme, last workspace, and the
  member's own agent logins.

## Sub-projects

| # | Sub-project | Depends on |
|---|-------------|------------|
| P0 | Members, team tree and responsibility: people, owned agents, staffing, escalation, attribution | — |
| P1 | Handoff contract and mission feed | P0 |
| P2 | Feedback and rounds: tweak anything, notes to running tasks, wake rules, downstream impact | P0, P1 |
| P3 | Outside contributions: uploads, hand-backs with snapshots | P0, P2 |
| P4 | Server and team access: Docker image, setup wizard, accounts, invites, permission levels, runners, web client for guests | P0 |

Order: P0 first. P1 → P2 → P3 follow in sequence. P4 can run in parallel
once P0 has landed.

**Focus (2026-09-16): you plus agents.** P0, P1 and P2 are done. The user chose
to focus on one person working with agents until that loop feels right:
- P3 is in progress, proven for a solo owner. Uploads and external hand-backs
  are the work that matters most now; see the
  [P3 design](2026-09-16-p3-outside-contributions-design.md).
- P4 is parked, with any other new team-only work. Revisit after P3.

## Acceptance

Every sub-project is proven in the real app, not assumed. Its acceptance
scenarios run as real missions against the desktop app and the
server/daemon. The PR records the evidence: API state, DOM text and
screenshots. Unit and scratch checks are required, but they are not proof
that a flow works.

## Open questions (resolved in the sub-project specs)

- How runners authenticate to the server and pick up work. (P4)
- TLS and exposing the server beyond the local network. (P4)
- Capturing feedback from external tools, such as PR review comments or
  Figma comments. (P3)
- Exact word budgets per type. (P1)
