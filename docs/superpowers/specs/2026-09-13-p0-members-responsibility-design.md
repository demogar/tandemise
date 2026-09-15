# P0: Members, team tree and responsibility

Status: design, 2026-09-13. Parent: [collaboration roadmap](2026-09-13-collaboration-roadmap.md).

## Goal

Every piece of work in Tandemise has three things written down:

- who did it (a person or an agent),
- who is responsible for it (always a real person),
- who recorded it.

Staffing decides who does each role, and it is configurable at three levels: workspace, mission and task. Questions and approvals go to the responsible person. If nobody answers, they escalate up the team tree. With no configuration, a solo user sees exactly today's behaviour.

## Not in P0 (and where it goes instead)

- **Accounts, sign-in, invites, permission enforcement, the Docker server, runners** → P4. P0 adds the identity seam and stores access levels, but does not enforce them.
- **AI members as reviewers** (an agent's findings becoming feedback for another round) → P2. In P0, only people review.
- **"Request changes" on an after-the-fact review starting a new round** → P2. In P0 the note is recorded and the task is marked as needing attention.
- **Take-over and hand-back** → P3.

## Concepts

### Person

A human known to this Tandemise installation. A person is global to the daemon, not tied to a workspace.

| Field | Notes |
|---|---|
| `id` | `per_…` |
| `displayName` | required |
| `handles` | `{ email?, github?, figma?, slack?, … }`, free-form string map |
| `accountId` | always `null` in P0; P4 attaches an account |
| `removedAt` | set when removed; history is kept |

The **local person** is created automatically on first start, named from `git config user.name`, falling back to the OS username. Until P4, every request made with the daemon token acts as this person.

### Member

A person's or an agent's place in one workspace.

| Field | Person member | Agent member |
|---|---|---|
| `id` | `mem_…` | `mem_…` |
| `kind` | `person` | `agent` |
| `personId` | required | — |
| `name` | taken from the person | required, e.g. "Figma design agent" |
| `reportsTo` | a person member, or `null` at the top | **required**: the owner, which must be a person member |
| `access` | `owner \| admin \| member \| guest` (stored, enforced in P4) | — |
| `oversight` | `delegate_owns \| both_sign_off` (default `delegate_owns`), applies to work delegated to their reports | — |
| `roleIds` | roles this person covers (informational, and used by presets) | roles this agent can perform |
| `runtimeProfileIds` | — | ranked; the same semantics as today's routing |
| `integrationIds` | — | the tools this agent is connected to (informational in P0; P3 uses them) |
| `status` | `active \| removed` | `active \| removed` |

Invariants, enforced in the service and checked by tests:

- Every workspace has at least one active person member with `access = owner`.
- `reportsTo` never forms a cycle.
- An agent's `reportsTo` is an active person member.
- Agents have no reports.
- Removing a person member marks their agents as **inactive through their owner**. The agents are not deleted. Staffing then skips them (see Resolution).

### Team tree

The tree is formed by `reportsTo`. The app shows it as an org chart. "Areas" such as Design are not a separate entity: an area is a person and the people and agents below them. This keeps one concept. A title such as "Director of Design" is an optional `title` on the member.

### Actor

Anywhere Tandemise records "who", it stores a **member id**, or the literal `system` for scheduler and engine actions. People and agents share the `members` table, so one column covers both.

### Responsibility

The responsible person for a task:

1. If the task's resolved staffing has an explicit `responsible` member, that person. This is how delegation works: Maria's staffing says Ana is responsible.
2. Otherwise, if the assignee is a person, that person.
3. Otherwise, if the assignee is an agent, the agent's owner (`reportsTo`).
4. Otherwise (unassigned pool, or legacy routing with no agent member), the workspace's first owner.

The **escalation chain** is: the responsible person, then each `reportsTo` above them in turn, then the workspace owners. Duplicates are removed.

**Sign-off.** If the responsible person's `reportsTo` has `oversight = both_sign_off`, a blocking review needs the responsible person's approval **and then** the lead's approval. Only the nearest lead counts; it does not repeat all the way up the tree.

## Staffing

### Shape

```ts
interface Staffing {
  /** Who does the work. Ordered. */
  assignees: string[];                 // member ids
  /** How the assignee list is used. */
  mode: 'first_available' | 'pool';    // pool = people claim it; agents in a pool are tried in order
  /** Explicit delegation; must be a person member. */
  responsible?: string;
  reviews: Review[];
  /** Escalate a waiting request after this long without an answer. */
  escalateAfterMs?: number;            // default 24h; null = never
  notify?: string[];                   // person members told on completion (FYI only)
}

interface Review {
  by: 'responsible' | string[];        // 'responsible' or explicit person member ids (any one of them)
  mode: 'blocking' | 'after';
  when: 'always' | GateExpression;     // evaluated against the task's gate facts
}
```

### Where it is set, and precedence

| Level | Stored in | Applies to |
|---|---|---|
| Task override | `mission_tasks.staffing_override` | that task |
| Mission override, per role | `missions.staffing` (`Record<roleId, Partial<Staffing>>`) | tasks of that role in the mission |
| Workspace default, per role | `workspaces.staffing` (`Record<roleId, Staffing>`) | every mission |
| Workflow step hint | `executor: human` becomes `{assignees: [], mode: 'pool'}` with the step's role kept | tasks from that step |
| Built-in | `{assignees: <active agent members with the role>, mode: 'first_available', reviews: []}` | when nothing is set |

**A person's step stays with people.** For a workflow step marked `executor: human`, agents from the built-in and workspace layers are ignored. Only an explicit mission or task override can put an agent on such a step. People staffed at the workspace level still apply. The reason: the migration creates a "<Role> agent" for every routed role, and without this rule every human step with a role would quietly go to a model. (Amended during implementation, 2026-09-13.)

Levels merge **field by field**, from the lowest to the highest. A mission that only sets `reviews` keeps the workspace's assignees. A workspace `PATCH` merges **per role**: sending `{design: …}` never touches `engineering`. This fixes the current routing bug, where saving one role's routing erases the others.

**Legacy routing.** At migration, every `workspace.routing[role] = [profiles]` becomes an agent member called "<Role name> agent". It is owned by the workspace owner, has `roleIds = [role]` and `runtimeProfileIds = profiles`, and the role's workspace staffing is set to `{assignees: [that agent]}`. After this, `routing` is derived from staffing on read (kept for API compatibility) and is no longer written.

A role that has no agent member and no staffing keeps today's fallback: every enabled runtime profile. The actor is the literal `system:runtime`, and the workspace owner is responsible. This is what makes zero-configuration installs behave exactly as they do today.

### Resolution

Staffing is resolved when a task becomes `READY`, and the result is snapshotted into `mission_tasks.staffing` together with `assignee_id` and `responsible_id`. Changes to the workspace or mission apply only to tasks that have not reached `READY` yet. The Plan view shows the resolved staffing for READY tasks and the would-be staffing for PENDING ones. A task override can be edited until the task starts running.

Resolution steps:

1. Merge the levels.
2. Drop inactive members: removed members, and agents whose owner has been removed.
3. Choose the assignee:
   - `first_available` whose first candidate is an **agent**: the executor is `agent`. Candidate runtime profiles are the ranked `runtimeProfileIds` of each agent in order, and `runtimeManager.select` picks the first healthy one. The agent it picks becomes the assignee.
   - `first_available` whose first candidate is a **person**: the executor is `human`, the assignee is that person, and the status is `AWAITING_HUMAN`.
   - `pool`: agents are tried first, in order, as above. If there are none, the executor is `human`, the task is unassigned, the status is `AWAITING_HUMAN`, and any listed person can **claim** it.
   - An empty list after filtering: the legacy fallback for agent-role tasks, or an unassigned pool containing the workspace owners for human steps.
4. Compute `responsible_id` (see Responsibility).

A task that was a human step keeps its role, so `roleId` is no longer rewritten to `human`. The `HUMAN_ROLE_ID` placeholder is used only for workflow steps that name no role.

### Reviews at completion

These replace `approvalPolicy.onCompletion` when staffing has reviews. A task whose `approvalPolicy.onCompletion = true` and whose staffing has no reviews gets `[{by: 'responsible', mode: 'blocking', when: 'always'}]`, so existing workflows behave exactly as before.

After a round passes its completion gate, each review is handled in order:

- If `when` is false, skip the review and record `review.skipped` together with the facts that were read.
- **`blocking`**: create an output approval addressed to the resolved reviewers and wait. Approving moves on to the next review, or to success. Rejecting behaves as today (a revision task with the note, or blocked if there is no note; P2 replaces this). When `both_sign_off` applies, a second approval goes to the lead after the first one is approved.
- **`after`**: create a non-blocking approval of the new kind `check`, with the options "Looks good" and "Needs changes". The task succeeds immediately and downstream work does not wait. "Needs changes" records the note, marks the task `needsAttention = true` and emits an event. P2 turns this into a round.

New gate facts that `when` can use: `task.attempt`, `task.risk` (the highest risk class among the task's capabilities: `read`, `write_reversible`, `external_side_effect`, `destructive`, `financial`, `release`), `task.risk_level` (that class's index, 0–5, so conditions can use `>=`), `task.role` and `diff.files_changed` (when a ChangeSet exists).

## Requests: addressing, escalation, recording on behalf

### Approvals

New columns:

- `addressees`: an array of member ids.
- `escalation_level` (integer).
- `escalate_at` (timestamp or null).
- `recorded_by`.

`decided_by` holds a member id.

- Created by a review: `addressees` = the review's reviewers.
- Created by `ask_human`: the task's assignee (if a person), then the responsible person.
- Created by a start or intervention approval: the responsible person.
- Created by a plan approval: the mission's creator, falling back to the owners.

An **escalation sweep** runs on the scheduler tick. For each pending approval whose `escalate_at` has passed:

- Append the next person in the escalation chain to `addressees`. Earlier addressees can still answer.
- Increase `escalation_level`.
- Reset `escalate_at`.
- Emit `approval.escalated {approvalId, to, level}`.

At the end of the chain, `escalate_at` becomes null and the request just waits until it expires, as today. Pool tasks in `AWAITING_HUMAN` escalate the same way, by adding owners to the claimable set.

### Deciding for someone

Any of these requests may carry `onBehalfOf: memberId`: `decide`, `complete`, `claim`, and the mission `create` request.

- The stored actor (`decided_by`, `author`, `assignee`) is `onBehalfOf`.
- `recorded_by` is the member for the principal.
- Validation: `onBehalfOf` must be an active person member of the workspace.
- Without `onBehalfOf`, the principal's member is both the actor and the recorder.

The principal is resolved **per request** by an `IdentityResolver`: token → person → member in the target workspace. P0's resolver maps the daemon token to the local person. If the local person has no member in a workspace, the request fails with `FORBIDDEN` (a guard that P4 relies on).

### Addressing is advisory in P0

Every approval is visible to everyone, as today. The UI filters default to **For me** (the principal is an addressee) and also offer **Everyone**. Enforcement arrives with P4.

## Data changes (migration 008)

- `people(id, display_name, handles json, account_id null, created_at, removed_at)`
- `members(id, workspace_id, kind, person_id, name, title, reports_to, access, oversight, role_ids json, runtime_profile_ids json, integration_ids json, status, created_at, updated_at)`
- `workspaces.staffing json default '{}'`
- `missions.created_by, missions.staffing json default '{}'`
- `mission_tasks.staffing json, staffing_override json, assignee_id, responsible_id, needs_attention int default 0`
- `artifacts.author_id, responsible_id, recorded_by`
- `approvals.addressees json default '[]', escalation_level int default 0, escalate_at, recorded_by` (`decided_by` now holds member ids)
- `run_events.actor_id`
- `runs.agent_member_id`
- `approval.kind` gains `check`

The migration also backfills existing data:

1. Create the local person.
2. For each workspace, create an owner member for the local person.
3. Convert routing into agent members and staffing (as above).
4. `approvals.decided_by = 'user'` → the owner member.
5. Artifacts with a run → the author is the agent member of that run's role when one exists, otherwise `system:runtime`. The responsible person is the owner.
6. `missions.created_by` → the owner.

The migration is transactional and idempotent, following the style of the existing migrations.

## API (api-contract + daemon routes)

- `GET /v1/people`, `POST /v1/people`, `PATCH /v1/people/:id`, `DELETE /v1/people/:id` (soft delete)
- `GET /v1/me`: the principal person and their member per workspace
- `GET /v1/workspaces/:id/members`, `POST …/members`, `PATCH /v1/members/:id`, `DELETE /v1/members/:id`
- `GET /v1/workspaces/:id/team`: the tree with resolved responsibility counts
- `GET /v1/workspaces/:id/staffing`, `PATCH /v1/workspaces/:id/staffing` (merged per role)
- `PATCH /v1/missions/:id/staffing`, `PATCH /v1/tasks/:id/staffing` (the latter only before the task runs)
- `GET /v1/tasks/:id/staffing/preview`: the resolution result and the escalation chain, without saving
- `POST /v1/tasks/:id/claim {onBehalfOf?}`
- `decide`, `complete` and `createMission` accept `onBehalfOf`
- Views gain `assignee`, `responsible`, `author`, `recordedBy` and `addressees`, each as `{id, name, kind}`

## Desktop

- **Team** replaces Workforce:
  - An org-chart tree, with add person / add agent (owner, roles, ranked runtimes, connected tools) / edit / remove.
  - An oversight toggle on each person who has reports.
  - A **Staffing** tab per role: a preset picker plus a Custom editor for assignees, mode, responsible, reviews (by, mode, when) and escalation.
- **Presets** (these write normal staffing):

  | Preset | Staffing |
  |---|---|
  | AI only | `assignees: [agent]` |
  | AI drafts, responsible person approves | `+ reviews: [{by: responsible, mode: blocking, when: always}]` |
  | AI drafts, person checks later | `mode: after` |
  | A person does it | `assignees: [person]` |
  | Anyone from a group | `mode: pool, assignees: [people]` |
  | AI with a safety net | `blocking, when: task.risk_level >= 2` |

- **Plan:** every task shows "Done by X · Responsible Y". A task drawer lets you edit the override until the task runs, and shows the escalation chain.
- **Task detail:** a Claim button for pool tasks; complete and claim offer "on behalf of" when the principal is not the assignee.
- **Inbox** (the Approvals screen, renamed): lists approvals *and* `AWAITING_HUMAN` tasks, with a For me / Everyone filter. The nav badge counts both. Also: each card shows who it is addressed to and its escalation state; "Recording for" selector when deciding on behalf.
- **Cards and timeline:** artifacts and decisions show "by X · responsible Y", with "recorded by Z" when that differs from the author.
- **Mission create:** an optional staffing override per role.

## Error handling

- Invalid staffing (an unknown member, a removed person, an agent as `responsible`, a reviewer who is not a person, an invalid `when` expression) → `VALIDATION`, with the field path.
- Staffing edits that would orphan the workspace, such as removing the last owner → `CONFLICT`.
- Removing a person who has active assignments: allowed. Affected READY and AWAITING_HUMAN tasks are re-resolved on the next tick. Running tasks finish, and their completion reviews re-resolve.
- Nobody to address (every member removed): fall back to the workspace owners. An owner always exists, by invariant.

## Testing

**Offline checks.** A new `scratch/staffing-check.mjs` is added to `OFFLINE_CHECKS` and covers:

- the precedence merge, field by field
- per-role PATCH does not clobber other roles
- inactive filtering, including an agent whose owner was removed
- responsibility rules 1–4
- the escalation chain, including dedupe and `both_sign_off`
- review `when` evaluation with the new facts
- the escalation sweep timing
- the `onBehalfOf` actor and `recorded_by`
- migration backfill on a database built from migrations 001–007, with representative rows
- A1 regression: a no-configuration mission is identical to today

Existing checks must still pass (`npm run ci`).

**Real-app acceptance** is a hard requirement (see the roadmap). It runs against an isolated configuration under my control:

- `TANDEMISE_HOME=<scratch>/home`
- a scratch git repository with a trivial project
- the daemon built from this branch
- a second Electron instance with `--remote-debugging-port` and its own `--user-data-dir`, driven over CDP
- **scripted agents**: a generic-CLI runtime profile pointing at a scratch Node script that writes valid artifacts for the task it receives, so every run is deterministic
- one scenario also runs on the real Claude runtime, to prove nothing depends on the fake

For each scenario, the PR records the API state, the DOM text and a screenshot.

| # | Scenario | Setup | Must observe in the app |
|---|---|---|---|
| A1 | Solo, no configuration | fresh home | Mission completes; Plan shows "Done by Development agent · Responsible <you>"; approval decided_by = your member |
| A2 | Solo, AI drafts, you approve | preset on product | Spec approval addressed to you, shown under "For me"; approving starts downstream work |
| A3 | You do a stage | "A person does it: you" on a docs step | Task shows in Inbox → For me; complete; artifact "by you · responsible you" |
| A4 | Team with no accounts | add Maria (lead, design), Ana reports to Maria, Ana's Figma agent | Design task done by Ana's agent; approval addressed to Ana; Maria is not asked (`delegate_owns`) |
| A5 | Both sign off | Maria `both_sign_off` | After Ana approves, a second approval goes to Maria; downstream waits for both |
| A6 | Record on behalf | operator approves as Ana | Card reads "Ana · recorded by <you>" |
| A7 | Pool and claim | QA pool [Ana, Bo] | Unassigned; Claim as Bo; assignee Bo; responsible Bo |
| A8 | Check later | architecture `after` | Downstream starts at once; check card appears; "Needs changes" marks the task as needing attention |
| A9 | Safety net | release `when: task.risk_level >= 2` | Low-risk task passes without an approval; a release task gets an approval |
| A10 | Escalation | `escalateAfterMs: 60000` | After about a minute the request shows as escalated to Maria, then to the owner; the timeline shows `approval.escalated` |
| A11 | Remove a person | remove Ana | Ana's agent shows as inactive; the next design task resolves to the next assignee or escalates |
| A12 | Staffing change mid-mission | change development staffing while an earlier task runs | Only tasks not yet READY pick it up |
| A13 | Beyond design | finance lead with a finance agent; a code task | Same behaviour for FinanceReport and ChangeSet |
| A14 | Routing bug | Team screen: edit one role's runtimes | Other roles' staffing is unchanged (API diff) |
| A15 | Real runtime | A4 with Ana's agent on real Claude | Same attribution and addressing as with the scripted agent |
