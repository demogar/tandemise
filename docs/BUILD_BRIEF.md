# Tandemise — Build Brief for Contributors

Read this before writing any code. `MVP.md` at the repo root is the product and
architecture specification; this file is the engineering contract.

## Non-negotiables

1. **Staff-engineer quality.** Someone reading this code should think "this is
   good code". Small focused modules, names that carry meaning, comments that
   explain *why* (never *what*). No dead abstractions, no speculative
   generality, no framework soup (MVP.md §32 names this as a risk).
2. **Dependency direction is enforced mechanically.** `node scripts/check-boundaries.mjs`
   must pass. A package may only import what it declares in `scripts/packages.mjs`,
   and only from a strictly lower layer. Core packages may never import a
   provider module (electron, playwright, better-sqlite3, child_process…).
3. **Ports inward, implementations outward.** `@tandemise/domain` defines the
   ports. `@tandemise/application` orchestrates against ports only. Concrete
   providers implement them. `apps/daemon` is the single composition root and
   the only place that names a concrete provider.
4. **Every provider is a module.** Export a `TandemiseModule` from
   `@tandemise/kernel` that registers bindings. Adding a new runtime, execution
   target, or integration must be: write the adapter, export a module, append it
   to the composition list. Nothing else changes.
5. **Type safety is not optional.** `strict` + `noUncheckedIndexedAccess` are on.
   Do not use `any`. Do not use non-null `!` to paper over a real optional.
   `unknown` + a narrowing check is the correct tool at trust boundaries.
6. **No secrets in the database, in logs, or in events.** Store references
   (`SecretStorePort`). Everything written to a log or event body passes through
   `redactSecrets` / `summarize` from `@tandemise/shared`.

## Toolchain

- Node **22.23.1** — `export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH"`.
- ESM everywhere (`"type": "module"`). **Relative imports must carry the `.js`
  extension** (NodeNext resolution) — `import { x } from './thing.js'`.
- Build a package: `npx tsc -b packages/<name>`. Build all: `npm run build`.
- Boundary check: `npm run check:boundaries`.

## What already exists (do not redefine these)

- `@tandemise/shared` — branded ids (`ids.mission()`, `asId`), `TandemiseError`
  + `ErrorCode`, `Result`/`Ok`/`Err`, `Clock`/`Timestamp`, `createLogger`
  (structured JSON with correlation fields), `redactSecrets`/`summarize`,
  `createPaths`/`isPathInside`/`expandPath`/`slugify`.
- `@tandemise/kernel` — `token`/`multiToken`, `Container` (bind/rebind/
  contribute/resolve/resolveAll/createScope/dispose), `defineModule`/`compose`,
  `Registry<Descriptor>` (id-keyed, `providing(...caps)`), `LifecycleHost`.
- `@tandemise/domain` — all entities, the canonical `AgentEvent` /
  `OrchestrationEvent` vocabulary, the gate expression engine
  (`evaluateGate`/`validateGate`/`gateDependencies`), `MissionPlan` +
  `validateMissionPlan`/`topologicalOrder`/`planLevels`, the capability model,
  and **every persistence / artifact-store / event-bus / secret port**.

Read the actual `.d.ts` or source before assuming a shape. Do not invent a
parallel type for something domain already defines.

## Conventions

- **Errors**: throw `TandemiseError` with a specific `ErrorCode`. Use `Result`
  for expected failures (gate outcomes, policy decisions, validation).
- **Time**: inject `Clock`. Never call `Date.now()` inside domain/application.
- **Ids**: always `ids.<entity>()`. Never hand-roll a uuid.
- **Async**: repositories are synchronous (better-sqlite3 is sync — embrace it,
  it removes a whole class of interleaving bug). I/O-bound ports are async.
- **Logging**: accept a `Logger` by injection; `log.child({ runId })` to
  correlate. Never `console.log`.
- **Comments**: a comment that restates the code is noise. A comment that
  explains a non-obvious constraint, a trade-off, or why the obvious approach is
  wrong is valuable. Prefer the second; delete the first.

## Definition of done for your task

- `npx tsc -b <your packages>` is clean.
- `node scripts/check-boundaries.mjs` passes.
- Every exported symbol is reachable from the package `index.ts`.
- You verified behaviour by actually running something — a scratch script under
  `scratch/` is fine. Report what you ran and what it printed.
- You did **not** edit files outside the packages assigned to you. If you need a
  change in `domain`, `shared`, or `kernel`, say so in your report instead of
  making it.

## Reporting

Return a concise report: what you built, the key design decisions and why,
anything you had to stub, anything you believe is wrong in the contracts, and
the exact verification output. Do not paste whole files.
