// Fixture data for the mock daemon. Shapes follow @tandemise/api-contract
// exactly; if a field here drifts from the contract, the UI is being developed
// against a lie, so keep them in step.

const now = Date.now();
export const iso = (offsetMs = 0) => new Date(now + offsetMs).toISOString();
const min = (n) => n * 60_000;

export const WORKSPACE_ID = 'wsp_default';

export const workspace = {
  id: WORKSPACE_ID,
  name: 'Orbital',
  defaultRepositoryId: 'rep_web',
  autonomy: {
    planApproval: 'ask',
    localCodeChanges: 'auto',
    externalWrites: 'policy',
    productionRelease: 'ask',
    financialActions: 'deny',
  },
  concurrency: { maxTotalWorkers: 3, perRuntime: { rtp_claude: 2, rtp_codex: 1 } },
  routing: {
    product: ['rtp_claude', 'rtp_codex'],
    design: ['rtp_claude'],
    architecture: ['rtp_claude', 'rtp_codex'],
    development: ['rtp_claude', 'rtp_codex'],
    review: ['rtp_codex', 'rtp_claude'],
    qa: ['rtp_claude'],
    release: ['rtp_claude'],
  },
  defaultAutonomyLevel: 'balanced',
  knowledge: {
    productVision: 'Orbital is a scheduling tool for distributed engineering teams.',
    architecturePrinciples: 'Ports inward, implementations outward. No provider names in core packages.',
    codingStandards: 'TypeScript strict. No `any`. Comments explain why, never what.',
    designSystem: 'Tokens in theme.css; components are hand-built.',
    glossary: null,
  },
  createdAt: iso(-min(60 * 24 * 30)),
  updatedAt: iso(-min(90)),
};

export const repositories = [
  {
    id: 'rep_web',
    workspaceId: WORKSPACE_ID,
    name: 'orbital-web',
    path: '/Users/you/code/orbital-web',
    defaultBranch: 'main',
    remoteUrl: 'git@github.com:orbital/orbital-web.git',
    checks: {
      install: 'npm ci',
      typecheck: 'npm run typecheck',
      lint: 'npm run lint',
      test: 'npm test',
      build: 'npm run build',
      devServer: 'npm run dev',
      devServerUrl: 'http://localhost:5173',
    },
    createdAt: iso(-min(60 * 24 * 30)),
    updatedAt: iso(-min(60 * 24)),
  },
  {
    id: 'rep_api',
    workspaceId: WORKSPACE_ID,
    name: 'orbital-api',
    path: '/Users/you/code/orbital-api',
    defaultBranch: 'main',
    remoteUrl: 'git@github.com:orbital/orbital-api.git',
    checks: {
      install: 'pnpm install',
      typecheck: 'pnpm typecheck',
      lint: null,
      test: 'pnpm test',
      build: 'pnpm build',
      devServer: null,
      devServerUrl: null,
    },
    createdAt: iso(-min(60 * 24 * 21)),
    updatedAt: iso(-min(60 * 24 * 2)),
  },
];

export const roles = [
  ['product', 'Product', 'Turns an outcome into a testable specification.', ['ProblemBrief', 'ProductSpec'], []],
  ['design', 'Design', 'Defines the interaction and visual contract for the change.', ['DesignBrief'], ['ProductSpec']],
  ['architecture', 'Architecture', 'Chooses the technical approach and records the decision.', ['ArchitecturePlan', 'DecisionRecord'], ['ProductSpec']],
  ['development', 'Developer', 'Implements the change inside an isolated worktree.', ['ChangeSet'], ['ProductSpec', 'ArchitecturePlan', 'DesignBrief']],
  ['review', 'Reviewer', 'Reviews the change against the spec and the codebase standards.', ['ReviewReport'], ['ChangeSet', 'ProductSpec']],
  ['qa', 'QA', 'Verifies behaviour against the acceptance criteria and captures evidence.', ['QAPlan', 'QAReport', 'Evidence'], ['ChangeSet', 'ProductSpec']],
  ['release', 'Release', 'Assembles the release candidate and opens it for approval.', ['ReleaseCandidate'], ['ChangeSet', 'ReviewReport', 'QAReport']],
  ['finance', 'Finance', 'Reviews anything with a cost. Never authorised to spend.', ['FinanceReport'], []],
].map(([id, name, summary, produces, consumes]) => ({
  id,
  workspaceId: WORKSPACE_ID,
  name,
  summary,
  instructions: `You are the ${name} role in an autonomous software organization.\n\nYou receive typed artifacts from upstream roles and produce typed artifacts for downstream ones. You never read another role's transcript — the artifact is the contract.\n\nWork only inside the working directory you were given. If you need a capability you were not granted, stop and request it rather than working around the restriction.`,
  defaultCapabilities:
    id === 'development'
      ? ['repository.read', 'filesystem.write', 'shell.exec', 'git.commit', 'tests.run']
      : id === 'qa'
        ? ['repository.read', 'browser', 'tests.run']
        : ['repository.read', 'artifact.write'],
  producesArtifacts: produces,
  consumesArtifacts: consumes,
  defaultIsolation: id === 'development' || id === 'qa' ? 'worktree' : 'none',
  outputContract: `The ${name} artifact must be specific enough that the next role can act on it without asking a question.`,
  builtIn: true,
  createdAt: iso(-min(60 * 24 * 30)),
  updatedAt: iso(-min(60 * 24 * 30)),
}));

// ------------------------------------------------------------------ missions

const policy = (isolation, capabilities) => ({ isolation, maxWallTimeMs: 1_800_000, capabilities });
const retry = { maxAttempts: 2, backoffMs: 5000, onExhausted: 'block' };

/** The seven-task feature-delivery DAG, with mixed statuses. */
const checkoutTasks = [
  {
    key: 'spec', title: 'Write the passkey sign-in specification', role: 'product', level: 0, dependsOn: [],
    status: 'SUCCEEDED', outputs: ['ProductSpec'], runtime: 'Claude Code', target: 'local',
    gate: null, started: -min(184), finished: -min(171),
  },
  {
    key: 'design', title: 'Design the enrolment and fallback flows', role: 'design', level: 1, dependsOn: ['spec'],
    status: 'SUCCEEDED', outputs: ['DesignBrief'], runtime: 'Claude Code', target: 'local',
    gate: null, started: -min(170), finished: -min(154),
  },
  {
    key: 'architecture', title: 'Choose the WebAuthn library and credential storage', role: 'architecture', level: 1, dependsOn: ['spec'],
    status: 'SUCCEEDED', outputs: ['ArchitecturePlan', 'DecisionRecord'], runtime: 'Codex', target: 'local',
    gate: null, started: -min(170), finished: -min(148),
  },
  {
    key: 'implement', title: 'Implement passkey enrolment and sign-in', role: 'development', level: 2, dependsOn: ['design', 'architecture'],
    status: 'SUCCEEDED', outputs: ['ChangeSet'], runtime: 'Claude Code', target: 'wt/passkey-impl',
    gate: { expression: 'checks.typecheck == PASS && checks.tests == PASS', passed: true, detail: 'All gate conditions met.', facts: { 'checks.typecheck': 'PASS', 'checks.tests': 'PASS' } },
    started: -min(147), finished: -min(63),
  },
  {
    key: 'review', title: 'Review the change against the specification', role: 'review', level: 3, dependsOn: ['implement'],
    status: 'SUCCEEDED', outputs: ['ReviewReport'], runtime: 'Codex', target: 'wt/passkey-impl',
    gate: { expression: 'review.blocking_findings == 0', passed: false, detail: 'Gate failed: review.blocking_findings was 2, expected 0. The reviewer found 2 blocking issues, so dependent tasks stay pending until they are remediated.', facts: { 'review.blocking_findings': 2 } },
    started: -min(62), finished: -min(41),
  },
  {
    key: 'remediate', title: 'Fix the two blocking review findings', role: 'development', level: 4, dependsOn: ['review'],
    status: 'RUNNING', outputs: ['ChangeSet'], runtime: 'Claude Code', target: 'wt/passkey-impl',
    gate: null, started: -min(9), finished: null, remediates: 'review',
  },
  {
    key: 'qa', title: 'Verify enrolment, sign-in and the password fallback', role: 'qa', level: 5, dependsOn: ['remediate'],
    status: 'PENDING', outputs: ['QAReport', 'Evidence'], runtime: null, target: null,
    gate: null, started: null, finished: null,
  },
  {
    key: 'release', title: 'Assemble the release candidate', role: 'release', level: 6, dependsOn: ['qa'],
    status: 'PENDING', outputs: ['ReleaseCandidate'], runtime: null, target: null,
    gate: null, started: null, finished: null,
  },
];

function buildTasks(missionId, specs) {
  return specs.map((spec, index) => ({
    id: `tsk_${missionId.slice(4)}_${spec.key}`,
    missionId,
    key: spec.key,
    title: spec.title,
    objective: `${spec.title}. Produce ${spec.outputs.join(' and ')} and hand off to the next stage.`,
    roleId: spec.role,
    roleName: roles.find((role) => role.id === spec.role)?.name ?? spec.role,
    level: spec.level,
    dependsOn: spec.dependsOn,
    requiredCapabilities: spec.role === 'development' ? ['filesystem.write', 'shell.exec', 'git.commit'] : ['repository.read'],
    inputArtifacts: [],
    expectedOutputs: spec.outputs,
    executionPolicy: policy(spec.role === 'development' || spec.role === 'qa' ? 'worktree' : 'none', ['repository.read']),
    approvalPolicy: spec.role === 'release' ? { beforeStart: true, onCompletion: false, reason: 'Release actions always ask.' } : { beforeStart: false, onCompletion: false },
    retryPolicy: retry,
    completionGate: spec.gate?.expression ?? null,
    status: spec.status,
    statusReason:
      spec.status === 'PENDING' && spec.dependsOn.length > 0
        ? `Waiting on ${spec.dependsOn.join(', ')}.`
        : spec.key === 'review'
          ? 'Two blocking findings were raised; a remediation task was generated.'
          : null,
    attempts: spec.status === 'PENDING' ? 0 : 1,
    remediatesTaskId: spec.remediates ? `tsk_${missionId.slice(4)}_${spec.remediates}` : null,
    orderHint: index,
    createdAt: iso(-min(190)),
    updatedAt: iso(spec.finished ?? spec.started ?? -min(190)),
    startedAt: spec.started ? iso(spec.started) : null,
    finishedAt: spec.finished ? iso(spec.finished) : null,
    latestRun: spec.started
      ? {
          id: `run_${spec.key}`,
          missionId,
          taskId: `tsk_${missionId.slice(4)}_${spec.key}`,
          assignmentId: `asg_${spec.key}`,
          attempt: 1,
          status: spec.status === 'RUNNING' ? 'RUNNING' : spec.status === 'SUCCEEDED' ? 'SUCCEEDED' : 'FAILED',
          roleId: spec.role,
          runtimeProfileId: spec.runtime === 'Codex' ? 'rtp_codex' : 'rtp_claude',
          executionTargetId: 'tgt_local',
          externalSessionId: `sess_${spec.key}`,
          pid: spec.status === 'RUNNING' ? 48213 : null,
          exitCode: spec.status === 'SUCCEEDED' ? 0 : null,
          errorCode: null,
          errorMessage: null,
          usage: { inputTokens: 18_400, outputTokens: 4_120, costUsd: null, wallTimeMs: 812_000, turns: 24 },
          startedAt: iso(spec.started),
          finishedAt: spec.finished ? iso(spec.finished) : null,
          heartbeatAt: iso(-min(1)),
        }
      : null,
    runCount: spec.started ? 1 : 0,
    outputArtifacts: [],
    checks: [],
    gate: spec.gate,
    pendingApprovalId: null,
    runtimeName: spec.runtime,
    targetName: spec.target,
  }));
}

export const missions = {
  msn_checkout: {
    id: 'msn_checkout',
    workspaceId: WORKSPACE_ID,
    repositoryId: 'rep_web',
    title: 'Passkey sign-in',
    goal: 'Add passkey sign-in to the web app, keeping the existing password flow working for anyone who has not enrolled.',
    constraints: ['Do not change the public API', 'No new runtime dependencies in the client bundle'],
    successCriteria: ['Existing password sign-in still works', 'Enrolment is covered by an end-to-end test', 'No new accessibility violations'],
    status: 'EXECUTING',
    autonomy: 'balanced',
    workflowPreset: 'feature-delivery',
    integrationBranch: 'tandemise/passkey-sign-in',
    baseBranch: 'main',
    statusReason: null,
    createdAt: iso(-min(190)),
    updatedAt: iso(-min(1)),
    startedAt: iso(-min(185)),
    completedAt: null,
  },
  msn_billing: {
    id: 'msn_billing',
    workspaceId: WORKSPACE_ID,
    repositoryId: 'rep_api',
    title: 'Usage-based billing export',
    goal: 'Export per-workspace usage totals to the billing system every night, with a replayable job.',
    constraints: ['The export must be idempotent'],
    successCriteria: ['A failed run can be replayed without double-counting'],
    status: 'BLOCKED',
    autonomy: 'supervised',
    workflowPreset: 'feature-delivery',
    integrationBranch: 'tandemise/usage-export',
    baseBranch: 'main',
    statusReason: 'The release role needs authorisation to open a pull request against orbital-api.',
    createdAt: iso(-min(60 * 26)),
    updatedAt: iso(-min(38)),
    startedAt: iso(-min(60 * 25)),
    completedAt: null,
  },
  msn_a11y: {
    id: 'msn_a11y',
    workspaceId: WORKSPACE_ID,
    repositoryId: 'rep_web',
    title: 'Keyboard navigation for the scheduler grid',
    goal: 'Make the scheduler grid fully operable from the keyboard, including range selection.',
    constraints: [],
    successCriteria: ['Every interactive cell is reachable with Tab and arrow keys'],
    status: 'COMPLETE',
    autonomy: 'balanced',
    workflowPreset: 'feature-delivery',
    integrationBranch: 'tandemise/grid-keyboard',
    baseBranch: 'main',
    statusReason: null,
    createdAt: iso(-min(60 * 52)),
    updatedAt: iso(-min(60 * 44)),
    startedAt: iso(-min(60 * 51)),
    completedAt: iso(-min(60 * 44)),
  },
};

export const tasksByMission = {
  msn_checkout: buildTasks('msn_checkout', checkoutTasks),
  msn_billing: buildTasks('msn_billing', [
    { key: 'spec', title: 'Specify the nightly usage export', role: 'product', level: 0, dependsOn: [], status: 'SUCCEEDED', outputs: ['ProductSpec'], runtime: 'Claude Code', target: 'local', gate: null, started: -min(60 * 25), finished: -min(60 * 24) },
    { key: 'implement', title: 'Build the export job', role: 'development', level: 1, dependsOn: ['spec'], status: 'SUCCEEDED', outputs: ['ChangeSet'], runtime: 'Claude Code', target: 'wt/usage-export', gate: { expression: 'checks.tests == PASS', passed: true, detail: 'All gate conditions met.', facts: { 'checks.tests': 'PASS' } }, started: -min(60 * 23), finished: -min(60 * 3) },
    { key: 'release', title: 'Open the pull request', role: 'release', level: 2, dependsOn: ['implement'], status: 'AWAITING_APPROVAL', outputs: ['ReleaseCandidate'], runtime: 'Claude Code', target: 'wt/usage-export', gate: null, started: -min(40), finished: null },
  ]),
  msn_a11y: buildTasks('msn_a11y', [
    { key: 'spec', title: 'Specify keyboard behaviour for the grid', role: 'product', level: 0, dependsOn: [], status: 'SUCCEEDED', outputs: ['ProductSpec'], runtime: 'Claude Code', target: 'local', gate: null, started: -min(60 * 51), finished: -min(60 * 50) },
    { key: 'implement', title: 'Implement roving tabindex and range selection', role: 'development', level: 1, dependsOn: ['spec'], status: 'SUCCEEDED', outputs: ['ChangeSet'], runtime: 'Claude Code', target: 'wt/grid-keyboard', gate: { expression: 'checks.typecheck == PASS && checks.tests == PASS', passed: true, detail: 'All gate conditions met.', facts: { 'checks.typecheck': 'PASS', 'checks.tests': 'PASS' } }, started: -min(60 * 49), finished: -min(60 * 46) },
    { key: 'qa', title: 'Verify with a screen reader and keyboard only', role: 'qa', level: 2, dependsOn: ['implement'], status: 'SUCCEEDED', outputs: ['QAReport'], runtime: 'Claude Code', target: 'wt/grid-keyboard', gate: null, started: -min(60 * 46), finished: -min(60 * 44) },
  ]),
};

// ----------------------------------------------------------------- artifacts

const SPEC_BODY = `# Passkey sign-in

## Problem

Password reset is the single largest source of support volume in Orbital: 41% of
tickets in the last quarter. Passkeys remove the password from the common path
without removing it from the product, which matters because roughly a third of
our users sign in from managed devices where passkey enrolment is disabled.

## Outcome

A user can enrol a passkey from account settings and use it to sign in. Anyone
who has not enrolled sees exactly the flow they see today.

## Acceptance criteria

1. A signed-in user can enrol a passkey from **Settings → Security**.
2. On the sign-in screen, a user with an enrolled passkey is offered it first,
   with "Use password instead" always visible.
3. A user with no passkey sees the current password form, unchanged.
4. Losing a passkey does not lock a user out: password sign-in remains active.
5. Enrolment and sign-in are covered by end-to-end tests.

## Out of scope

- Passkey-only accounts.
- Cross-device enrolment via QR code.
- Administrative revocation of a passkey by a workspace owner.

## Open questions resolved during planning

| Question | Resolution |
| --- | --- |
| Do we store the public key or a handle? | Public key, in \`user_credentials\` |
| Do we require user verification? | Yes, \`userVerification: "preferred"\` |
`;

const REVIEW_BODY = `# Review report — Passkey sign-in

**Verdict: needs changes.** Two blocking findings, three minor.

## Blocking

### 1. The challenge is not bound to the session

\`POST /auth/passkey/verify\` accepts any challenge previously issued to any
user. The challenge is generated per request but never associated with the
session that requested it, so a challenge issued to user A can be replayed by
user B who observed it.

\`\`\`ts
// src/auth/passkey.ts:94
const challenge = await challenges.take(body.challengeId);
// ^ no check that challenge.userId === session.userId
\`\`\`

**Suggested fix.** Store the issuing session id alongside the challenge and
reject a mismatch before verification.

### 2. Password fallback is hidden when enrolment exists

The sign-in screen renders "Use password instead" only when
\`credentials.length === 0\`, which is exactly when it is not needed. Acceptance
criterion 4 requires the opposite.

## Minor

- \`verifyRegistration\` swallows the library's error and rethrows a generic one, losing the reason.
- The new \`user_credentials\` migration has no down migration.
- \`PasskeyButton\` re-renders on every keystroke in the email field.
`;

const DECISION_BODY = `# Decision record — WebAuthn library

## Context

We need server-side WebAuthn attestation and assertion verification. Three
options were considered.

## Decision

Use **@simplewebauthn/server**, pinned to a single major version.

## Rationale

It is the only option that verifies attestation without a native dependency,
which keeps our deploy image unchanged. Its API surface maps closely onto the
spec, so the code reads like the standard rather than like the library.

## Alternatives considered

- **fido2-lib** — richer attestation support, but pulls in a native crypto
  binding that would change our base image.
- **Hand-rolled verification** — rejected. Attestation parsing is exactly the
  kind of code where a subtle bug is invisible until it is a CVE.

## Consequences

- One new server dependency, no new client dependency.
- Attestation formats beyond \`packed\` and \`none\` are not supported. That is
  acceptable: no platform authenticator we support uses another format.
`;

export const artifacts = [
  { id: 'art_spec', missionId: 'msn_checkout', taskId: 'tsk_checkout_spec', type: 'ProductSpec', title: 'Passkey sign-in specification', summary: 'Five acceptance criteria; password fallback stays for everyone.', body: SPEC_BODY, createdAt: iso(-min(171)) },
  { id: 'art_design', missionId: 'msn_checkout', taskId: 'tsk_checkout_design', type: 'DesignBrief', title: 'Enrolment and fallback flows', summary: 'Two screens, one modal. Fallback is always one tap away.', body: `# Design brief — Passkey enrolment\n\n## Principles\n\nThe passkey path must never feel like a trap. Every screen that offers a passkey also offers the password, at the same visual weight, without a disclosure.\n\n## Screens\n\n1. **Settings → Security.** A single "Add a passkey" row. After enrolment the row becomes a list of credentials with the device name and last-used date.\n2. **Sign-in.** When the browser reports a discoverable credential, the passkey button is primary and the password form is collapsed behind "Use password instead". When it does not, nothing changes.\n\n## States to design\n\n- Enrolment cancelled by the user (not an error).\n- Authenticator unavailable (an error, with the password path).\n- Credential no longer recognised by the server.\n`, createdAt: iso(-min(154)) },
  { id: 'art_arch', missionId: 'msn_checkout', taskId: 'tsk_checkout_architecture', type: 'DecisionRecord', title: 'WebAuthn library choice', summary: '@simplewebauthn/server, no native dependency.', body: DECISION_BODY, createdAt: iso(-min(148)) },
  { id: 'art_changeset', missionId: 'msn_checkout', taskId: 'tsk_checkout_implement', type: 'ChangeSet', title: 'Passkey enrolment and sign-in', summary: '11 files changed across the client and the auth service.', body: `# Change set\n\nBranch \`tandemise/passkey-impl\`, 4 commits, 11 files.\n\n| File | Change |\n| --- | --- |\n| \`src/auth/passkey.ts\` | new — attestation and assertion verification |\n| \`src/auth/challenges.ts\` | new — challenge issue/consume |\n| \`src/routes/auth.ts\` | two new routes |\n| \`migrations/0042_user_credentials.sql\` | new table |\n| \`web/src/auth/PasskeyButton.tsx\` | new component |\n| \`web/src/auth/SignInForm.tsx\` | offers passkey when available |\n| \`web/src/settings/Security.tsx\` | enrolment entry point |\n| \`e2e/passkey.spec.ts\` | enrolment + sign-in coverage |\n\n## Notes for the reviewer\n\nThe challenge store is in-memory for now; it is keyed by a random id with a\n60-second TTL. If we scale the auth service horizontally this has to move to\nRedis, which is called out in the architecture plan.\n`, createdAt: iso(-min(63)) },
  { id: 'art_review', missionId: 'msn_checkout', taskId: 'tsk_checkout_review', type: 'ReviewReport', title: 'Review — 2 blocking, 3 minor', summary: 'Session binding missing on the challenge; password fallback hidden.', body: REVIEW_BODY, createdAt: iso(-min(41)) },
  { id: 'art_billing_spec', missionId: 'msn_billing', taskId: 'tsk_billing_spec', type: 'ProductSpec', title: 'Nightly usage export', summary: 'Idempotent, replayable, one row per workspace per day.', body: `# Nightly usage export\n\n## Outcome\n\nEvery night at 02:00 UTC, one row per workspace per day lands in the billing\nsystem. A failed run can be replayed for any date without double-counting.\n\n## Acceptance criteria\n\n1. The job is idempotent per \`(workspaceId, date)\`.\n2. A partial failure leaves no partial day.\n3. Replaying a completed date is a no-op.\n`, createdAt: iso(-min(60 * 24)) },
  { id: 'art_billing_rc', missionId: 'msn_billing', taskId: 'tsk_billing_release', type: 'ReleaseCandidate', title: 'Release candidate — usage export', summary: 'Ready to open as a pull request against orbital-api.', body: `# Release candidate\n\nBranch \`tandemise/usage-export\` → \`main\`.\n\n- 6 files changed, 284 insertions, 12 deletions\n- typecheck PASS, tests PASS (128 passed, 0 failed), build PASS\n- No new dependencies\n\n## What this changes for users\n\nNothing visible. Billing totals become available a day earlier.\n`, createdAt: iso(-min(40)) },
  { id: 'art_a11y_qa', missionId: 'msn_a11y', taskId: 'tsk_a11y_qa', type: 'QAReport', title: 'QA — keyboard navigation', summary: 'All 14 criteria pass. 4 screenshots captured.', body: `# QA report — scheduler grid keyboard navigation\n\n**Verdict: pass.** 14 of 14 criteria verified.\n\n## Method\n\nKeyboard only, no pointer. Verified with VoiceOver on Safari 18 and NVDA on\nFirefox 133.\n\n## Results\n\n| Criterion | Result | Evidence |\n| --- | --- | --- |\n| Every cell reachable with arrow keys | PASS | screenshot-01 |\n| Range selection with Shift+Arrow | PASS | screenshot-02 |\n| Escape clears the selection | PASS | — |\n| Focus visible at 3:1 contrast | PASS | screenshot-03 |\n| Screen reader announces the cell's date and state | PASS | screenshot-04 |\n`, createdAt: iso(-min(60 * 44)) },
].map((artifact) => ({
  manifest: {
    id: artifact.id,
    workspaceId: WORKSPACE_ID,
    missionId: artifact.missionId,
    taskId: artifact.taskId,
    createdByRunId: null,
    type: artifact.type,
    title: artifact.title,
    contentRef: `${artifact.missionId}/${artifact.id}.md`,
    mediaType: 'text/markdown',
    sha256: `${artifact.id.padEnd(16, '0')}7f3a9c2b41e8d605`,
    byteSize: artifact.body.length,
    schemaVersion: 1,
    sourceRefs: artifact.type === 'ChangeSet' ? [{ kind: 'git.branch', value: 'tandemise/passkey-impl', label: 'passkey-impl' }] : [],
    supersedes: null,
    summary: artifact.summary,
    createdAt: artifact.createdAt,
  },
  body: artifact.body,
}));

// ----------------------------------------------------------------- approvals

export const approvals = [
  {
    approval: {
      id: 'apr_release',
      workspaceId: WORKSPACE_ID,
      missionId: 'msn_billing',
      taskId: 'tsk_billing_release',
      runId: 'run_release',
      kind: 'release',
      status: 'PENDING',
      risk: 'release',
      title: 'Open a pull request against orbital-api for the nightly usage export',
      rationale:
        'The change is complete and every deterministic check passed. Opening a pull request writes to GitHub, which leaves this machine, so the release role cannot do it without you.',
      effect:
        'Pushes the branch tandemise/usage-export to origin and opens a pull request into main with the release notes below. No merge, no deploy — the pull request waits for a human reviewer.',
      evidence: [
        { kind: 'check', label: 'Typecheck', value: 'PASS — pnpm typecheck, 0 errors, 14.2s' },
        { kind: 'check', label: 'Tests', value: 'PASS — 128 passed, 0 failed, 41.7s' },
        { kind: 'check', label: 'Build', value: 'PASS — pnpm build, 22.9s' },
        { kind: 'diff', label: 'Change size', value: '6 files changed, +284 −12' },
        { kind: 'artifact', label: 'Release candidate', value: 'Release candidate — usage export' },
        { kind: 'text', label: 'Reviewer verdict', value: 'Pass, no blocking findings. One minor note about log volume, already addressed.' },
        { kind: 'link', label: 'Target repository', value: 'https://github.com/orbital/orbital-api' },
      ],
      options: [
        { id: 'approve', label: 'Open the pull request', description: 'Push the branch and open a PR into main. Nothing merges.', recommended: true },
        { id: 'approve_draft', label: 'Open it as a draft', description: 'Same, but marked draft so CI runs without requesting review.' },
        { id: 'reject', label: 'Do not open it', description: 'The branch stays local. The mission stops here and you can inspect the worktree.' },
      ],
      recommendedOptionId: 'approve',
      selectedOptionId: null,
      decidedBy: null,
      decisionNote: null,
      createdAt: iso(-min(38)),
      decidedAt: null,
      expiresAt: iso(min(60 * 22)),
    },
    missionTitle: 'Usage-based billing export',
    taskTitle: 'Open the pull request',
    roleName: 'Release',
  },
  {
    approval: {
      id: 'apr_choice',
      workspaceId: WORKSPACE_ID,
      missionId: 'msn_checkout',
      taskId: 'tsk_checkout_remediate',
      runId: 'run_remediate',
      kind: 'choice',
      status: 'PENDING',
      risk: 'write_reversible',
      title: 'How should the passkey challenge be stored?',
      rationale:
        'The reviewer found that challenges are not bound to a session. Fixing that means choosing where challenges live, and the two reasonable options differ in whether the auth service can scale horizontally.',
      effect:
        'The developer implements the option you choose and records it as a decision record, which every downstream role then receives automatically.',
      evidence: [
        { kind: 'artifact', label: 'Review finding', value: 'Blocking #1 — the challenge is not bound to the session' },
        { kind: 'text', label: 'Current behaviour', value: 'In-memory map keyed by a random id, 60-second TTL, no session binding.' },
        { kind: 'text', label: 'Deployment today', value: 'The auth service runs as a single instance. Horizontal scaling is on the roadmap for Q3.' },
      ],
      options: [
        { id: 'session_bound_memory', label: 'Keep it in memory, bound to the session', description: 'Smallest change. Correct today, but breaks the moment the auth service runs on more than one instance.', recommended: true },
        { id: 'redis', label: 'Move challenges to Redis', description: 'Survives horizontal scaling. Adds Redis to the auth service’s critical path, which it does not currently depend on.' },
        { id: 'reject', label: 'Neither — ask me again with more analysis', description: 'The developer produces a short comparison document and asks again.' },
      ],
      recommendedOptionId: 'session_bound_memory',
      selectedOptionId: null,
      decidedBy: null,
      decisionNote: null,
      createdAt: iso(-min(6)),
      decidedAt: null,
      expiresAt: null,
    },
    missionTitle: 'Passkey sign-in',
    taskTitle: 'Fix the two blocking review findings',
    roleName: 'Developer',
  },
  {
    approval: {
      id: 'apr_plan_done',
      workspaceId: WORKSPACE_ID,
      missionId: 'msn_a11y',
      taskId: null,
      runId: null,
      kind: 'plan',
      status: 'APPROVED',
      risk: 'read',
      title: 'Approve the plan for keyboard navigation',
      rationale: 'Plan approval is on for this workspace.',
      effect: 'The mission starts executing the approved task graph.',
      evidence: [{ kind: 'text', label: 'Tasks', value: '3 tasks across 3 stages' }],
      options: [
        { id: 'approve', label: 'Approve', recommended: true },
        { id: 'reject', label: 'Reject' },
      ],
      recommendedOptionId: 'approve',
      selectedOptionId: 'approve',
      decidedBy: 'you',
      decisionNote: 'Looks right. Skip the design stage, this is behavioural only.',
      createdAt: iso(-min(60 * 51)),
      decidedAt: iso(-min(60 * 51)),
      expiresAt: null,
    },
    missionTitle: 'Keyboard navigation for the scheduler grid',
    taskTitle: null,
    roleName: null,
  },
];

// ------------------------------------------------------------------ runtimes

export const runtimes = [
  {
    profile: {
      id: 'rtp_claude',
      workspaceId: WORKSPACE_ID,
      adapterId: 'claude-code',
      name: 'Claude Code',
      executablePath: '/Users/you/.local/bin/claude',
      args: [],
      settings: { model: 'claude-opus-5', permissionMode: 'acceptEdits' },
      capabilities: ['reasoning', 'shell', 'filesystem', 'git', 'web', 'mcp', 'structured_output', 'session_resume', 'tool_calling'],
      enabled: true,
      maxConcurrent: 2,
      createdAt: iso(-min(60 * 24 * 30)),
      updatedAt: iso(-min(60 * 2)),
    },
    health: { profileId: 'rtp_claude', state: 'healthy', version: '2.0.31', detail: 'Responded to a version probe in 180ms.', checkedAt: iso(-min(3)), quotaWarning: null },
    adapterDisplayName: 'Claude Code',
    activeRuns: 1,
    rolesRouted: ['product', 'design', 'architecture', 'development', 'qa', 'release'],
  },
  {
    profile: {
      id: 'rtp_codex',
      workspaceId: WORKSPACE_ID,
      adapterId: 'generic-cli',
      name: 'Codex',
      executablePath: '/opt/homebrew/bin/codex',
      args: ['exec', '--json'],
      settings: { promptVia: 'stdin' },
      capabilities: ['reasoning', 'shell', 'filesystem', 'structured_output'],
      enabled: true,
      maxConcurrent: 1,
      createdAt: iso(-min(60 * 24 * 12)),
      updatedAt: iso(-min(60 * 6)),
    },
    health: {
      profileId: 'rtp_codex',
      state: 'unavailable',
      version: null,
      detail: 'The executable exited with code 127. It may have been removed or is no longer on PATH.',
      checkedAt: iso(-min(4)),
      quotaWarning: null,
    },
    adapterDisplayName: 'Generic CLI',
    activeRuns: 0,
    rolesRouted: ['review'],
  },
];

export const discoveries = [
  { adapterId: 'claude-code', displayName: 'Claude Code', detected: true, executablePath: '/Users/you/.local/bin/claude', version: '2.0.31', capabilities: ['reasoning', 'shell', 'filesystem', 'git', 'session_resume'], detail: 'Found on PATH.', suggestedSettings: { permissionMode: 'acceptEdits' }, configured: true },
  { adapterId: 'generic-cli', displayName: 'Codex CLI', detected: true, executablePath: '/opt/homebrew/bin/codex', version: '0.48.0', capabilities: ['reasoning', 'shell', 'filesystem'], detail: 'Found on PATH.', suggestedSettings: { promptVia: 'stdin' }, configured: true },
  { adapterId: 'gemini-cli', displayName: 'Gemini CLI', detected: false, executablePath: null, version: null, capabilities: [], detail: 'Not found on PATH. Install it, or add it as a generic CLI runtime.', suggestedSettings: {}, configured: false },
];

// -------------------------------------------------------------- integrations

export const integrations = [
  {
    integration: {
      id: 'itg_github',
      workspaceId: WORKSPACE_ID,
      providerId: 'github',
      name: 'GitHub — orbital',
      transport: 'cli',
      config: { host: 'github.com', org: 'orbital' },
      credentialRef: 'keychain://tandemise/github/orbital',
      enabledCapabilities: ['github.read', 'github.pr.create'],
      enabled: true,
      createdAt: iso(-min(60 * 24 * 20)),
      updatedAt: iso(-min(60 * 24)),
    },
    health: { state: 'healthy', detail: 'gh auth status reports an authenticated session for orbital.', checkedAt: iso(-min(11)) },
    availableCapabilities: [
      { capability: 'github.read', risk: 'read', description: 'Read repositories, issues, pull requests and checks.' },
      { capability: 'github.pr.create', risk: 'external_side_effect', description: 'Open a pull request. Never merges.' },
      { capability: 'github.issue.create', risk: 'external_side_effect', description: 'Open an issue or comment on one.' },
      { capability: 'github.pr.merge', risk: 'release', description: 'Merge a pull request into its base branch.' },
    ],
  },
  {
    integration: {
      id: 'itg_browser',
      workspaceId: WORKSPACE_ID,
      providerId: 'browser',
      name: 'QA browser profile',
      transport: 'browser',
      config: { engine: 'chromium', headless: false },
      credentialRef: null,
      enabledCapabilities: ['browser.navigate'],
      enabled: true,
      createdAt: iso(-min(60 * 24 * 8)),
      updatedAt: iso(-min(60 * 24 * 8)),
    },
    health: { state: 'degraded', detail: 'Chromium 131 is installed but the profile has no stored session, so authenticated QA will fail.', checkedAt: iso(-min(11)) },
    availableCapabilities: [
      { capability: 'browser.navigate', risk: 'read', description: 'Open pages and read the DOM.' },
      { capability: 'browser.interact', risk: 'write_reversible', description: 'Click, type and submit forms in the QA profile.' },
    ],
  },
];

export const settings = {
  logLevel: 'info',
  home: '/Users/you/.tandemise',
  artifactRoot: '/Users/you/.tandemise/artifacts',
  worktreeRoot: '/Users/you/.tandemise/worktrees',
  telemetryEnabled: false,
  updateChannel: 'stable',
  developerMode: false,
};

export const checks = [
  { id: 'chk_1', missionId: 'msn_checkout', taskId: 'tsk_checkout_implement', runId: 'run_implement', name: 'checks.install', outcome: 'PASS', detail: 'npm ci completed, 1204 packages.', command: 'npm ci', exitCode: 0, durationMs: 31_400, outputRef: null, createdAt: iso(-min(96)) },
  { id: 'chk_2', missionId: 'msn_checkout', taskId: 'tsk_checkout_implement', runId: 'run_implement', name: 'checks.typecheck', outcome: 'PASS', detail: 'tsc --noEmit, 0 errors.', command: 'npm run typecheck', exitCode: 0, durationMs: 12_800, outputRef: null, createdAt: iso(-min(71)) },
  { id: 'chk_3', missionId: 'msn_checkout', taskId: 'tsk_checkout_implement', runId: 'run_implement', name: 'checks.lint', outcome: 'PASS', detail: 'eslint, 0 errors, 2 warnings.', command: 'npm run lint', exitCode: 0, durationMs: 8_100, outputRef: null, createdAt: iso(-min(69)) },
  { id: 'chk_4', missionId: 'msn_checkout', taskId: 'tsk_checkout_implement', runId: 'run_implement', name: 'checks.tests', outcome: 'PASS', detail: '212 passed, 0 failed, 3 skipped.', command: 'npm test', exitCode: 0, durationMs: 64_200, outputRef: null, createdAt: iso(-min(65)) },
  { id: 'chk_5', missionId: 'msn_checkout', taskId: 'tsk_checkout_implement', runId: 'run_implement', name: 'checks.build', outcome: 'PASS', detail: 'vite build, 1.2 MB gzipped.', command: 'npm run build', exitCode: 0, durationMs: 27_600, outputRef: null, createdAt: iso(-min(64)) },
  { id: 'chk_6', missionId: 'msn_checkout', taskId: 'tsk_checkout_remediate', runId: 'run_remediate', name: 'checks.typecheck', outcome: 'FAIL', detail: "src/auth/passkey.ts:97:18 — Property 'sessionId' does not exist on type 'Challenge'.", command: 'npm run typecheck', exitCode: 2, durationMs: 11_900, outputRef: null, createdAt: iso(-min(4)) },
];

export const evaluations = [
  {
    id: 'evl_review',
    missionId: 'msn_checkout',
    taskId: 'tsk_checkout_review',
    runId: 'run_review',
    evaluatorRoleId: 'review',
    verdict: 'needs_changes',
    summary: 'The implementation matches the specification, but two security-relevant issues block it. Neither is difficult to fix.',
    findings: [
      { severity: 'blocking', title: 'Challenge is not bound to the issuing session', detail: 'A challenge issued to one user can be replayed by another; verification never compares the challenge owner to the session.', location: 'src/auth/passkey.ts:94', suggestedFix: 'Store the session id with the challenge and reject a mismatch before verification.' },
      { severity: 'blocking', title: 'Password fallback is hidden exactly when it is needed', detail: 'The "Use password instead" control renders only when the user has no credentials, which contradicts acceptance criterion 4.', location: 'web/src/auth/SignInForm.tsx:63', suggestedFix: 'Render the control unconditionally.' },
      { severity: 'minor', title: 'Verification error is rethrown without its reason', detail: 'The library error is replaced with a generic one, which makes support triage guesswork.', location: 'src/auth/passkey.ts:131', suggestedFix: 'Attach the original error as `cause`.' },
      { severity: 'minor', title: 'Migration has no down step', detail: '0042_user_credentials.sql cannot be rolled back.', location: 'migrations/0042_user_credentials.sql', suggestedFix: null },
      { severity: 'nit', title: 'PasskeyButton re-renders on every keystroke', detail: 'It reads the whole form context rather than the one field it needs.', location: 'web/src/auth/PasskeyButton.tsx:18', suggestedFix: null },
    ],
    criteriaCoverage: [
      { criterion: 'Existing password sign-in still works', outcome: 'FAIL', evidence: 'Fallback control is conditionally hidden.' },
      { criterion: 'Enrolment is covered by an end-to-end test', outcome: 'PASS', evidence: 'e2e/passkey.spec.ts covers enrolment and sign-in.' },
      { criterion: 'No new accessibility violations', outcome: 'PASS', evidence: 'axe reports 0 new violations.' },
    ],
    createdAt: iso(-min(41)),
  },
];

export const metricsByMission = {
  msn_checkout: { wallClockMs: min(185), runtimeActiveMs: min(121), humanWaitMs: min(41), retries: 1, failures: 0, filesChanged: 11, commits: 4, reviewFindings: 5, qaDefects: 0, inputTokens: 486_200, outputTokens: 91_400, costUsd: null, runtimeFallbacks: 1 },
  msn_billing: { wallClockMs: min(60 * 25), runtimeActiveMs: min(198), humanWaitMs: min(38), retries: 0, failures: 0, filesChanged: 6, commits: 3, reviewFindings: 1, qaDefects: 0, inputTokens: 212_800, outputTokens: 44_100, costUsd: null, runtimeFallbacks: 0 },
  msn_a11y: { wallClockMs: min(60 * 7), runtimeActiveMs: min(163), humanWaitMs: min(12), retries: 0, failures: 0, filesChanged: 5, commits: 2, reviewFindings: 0, qaDefects: 0, inputTokens: 158_000, outputTokens: 31_900, costUsd: null, runtimeFallbacks: 0 },
};

export const targets = [
  { id: 'tgt_impl', workspaceId: WORKSPACE_ID, missionId: 'msn_checkout', taskId: 'tsk_checkout_implement', kind: 'worktree', name: 'wt/passkey-impl', workingDirectory: '/Users/you/.tandemise/worktrees/passkey-impl', branch: 'tandemise/passkey-impl', baseBranch: 'main', status: 'IN_USE', detail: null, createdAt: iso(-min(147)), releasedAt: null },
];

export const decisions = [
  { id: 'dec_lib', workspaceId: WORKSPACE_ID, missionId: 'msn_checkout', title: 'Use @simplewebauthn/server', context: 'Server-side WebAuthn verification is needed.', decision: 'Adopt @simplewebauthn/server, pinned to one major version.', rationale: 'No native dependency, API maps onto the spec.', alternatives: [{ title: 'fido2-lib', summary: 'Richer attestation support.', rejectedBecause: 'Native crypto binding changes the deploy image.' }], consequences: ['One new server dependency', 'Only packed and none attestation formats supported'], status: 'accepted', owner: 'architecture', relatedArtifacts: ['art_arch'], supersedes: null, createdAt: iso(-min(148)), decidedAt: iso(-min(148)) },
];
