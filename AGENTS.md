# Agent guide

Context for AI agents working in this repo. `CONTRIBUTING.md` is the full
human-facing guide; this file is the short list of rules that have actually
bitten agents before, loaded into every agent session.

## Pull request titles are Conventional Commits (non-negotiable)

`main` is squash-merged: **the PR title becomes the commit on `main`**, and
release-please reads that commit to decide the next version and write the
changelog. CI runs a `Conventional PR title` check and fails the PR otherwise.

```
<type>: <lowercase subject>
```

- `type` is one of: `feat`, `fix`, `perf`, `refactor`, `docs`, `test`, `build`,
  `ci`, `chore`, `revert`.
- The subject must start with a lowercase letter.
- Add `!` after the type (`feat(api)!: …`) for breaking changes.

Do not use a title like "Focus the team on you + agents" — it has no type and
capitalises the subject. Use `feat: focus the team on you + your agents`.

Set the title when you create the PR. `gh pr edit --title` can hit a GitHub
"Projects classic" deprecation error on some repos; if it does, patch it
through the REST API instead:

```bash
gh api -X PATCH repos/tandemise/tandemise/pulls/<n> -f title="feat: …"
```

## Before you open a pull request

- Run `npm run ci` and make it green. It builds every package, enforces the
  architecture boundaries, the design system rules, licenses, `windowsHide` on
  every child process, desktop typecheck, and the offline checks. A change to
  `packages/design` also needs `storybook:build` and `storybook:a11y` (CI runs
  them in its own job).
- Prove UI/behaviour changes in the **real app**, not just with typecheck and
  offline checks. Drive the desktop window (fresh `TANDEMISE_HOME`, daemon from
  this checkout, `electron-vite dev` over CDP) and assert the DOM. The
  `scratch/acceptance/` harness and `scratch/*-check.mjs` scripts show the
  pattern; `scratch/desktop-live-check.mjs` is the minimal example.
- Keep one concern per PR. The squash title is the only thing future readers
  see on `main`.

## Commit messages

Conventional Commits, same as PR titles. Write a `## What and why` and
`## How it was verified` body for anything non-trivial.

## Repo shape (one line each)

- `apps/desktop` (Electron + React) is a control surface only; the daemon
  `apps/daemon` owns state. That split is kept by design and review:
  `npm run check:boundaries` does not read the desktop's main process or the
  daemon. It checks the layering of `packages/*` (declared deps, strictly lower
  layers, no provider modules in core packages), that the renderer
  value-imports no `@tandemise/*` package except the pure subpaths it lists and
  UI packages, that `@tandemise/design` imports nothing outside itself (`react`
  only under `src/react/`), and what `apps/relay` may import.
- `apps/relay` is the optional team relay; it imports only
  `@tandemise/api-contract/relay`, `@tandemise/coordination`, `ws`,
  `better-sqlite3`, `zod` and `node:*` (enforced by `check:boundaries`).
- `packages/coordination` owns who works on which tracker item (claims,
  take-over, the webhook mailbox, solo mode); `packages/application` may import
  only its `/rules` subpath. `packages/coordination-relay` is the daemon's
  client for a relay.
- `packages/terminal` owns the pty (`node-pty`) behind a hold; only the daemon
  wires it, and the desktop reaches it through the daemon's WebSocket at
  `/v1/tasks/:id/terminal`.
- `packages/intake-runners` holds the built-in intake runners (Sentry, PostHog,
  Slack, Discord); `packages/integration-youtrack` and `integration-github` are
  the primary trackers. The intake contract is `docs/intake/`.
- `packages/design` (`@tandemise/design`) is the design system: tokens, theme,
  icons, React components, and the Storybook published at
  https://tandemise.github.io/tandemise/. WCAG 2.1 AA is the floor;
  `npm run check:design` and `storybook:a11y` enforce what a machine can. Rules
  are in `docs/DESIGN_SYSTEM.md`.
- Every workspace package ships at the app's version; a new package must be
  added to `release-please-config.json` (`version-check` fails otherwise).
- Design specs live in `docs/superpowers/specs/`, implementation plans in
  `docs/superpowers/plans/`, acceptance evidence in `docs/superpowers/evidence/`.
  `docs/README.md` maps the rest of the docs.
- Each sub-project is specced and planned before code is written, then proven
  in the real app.
- The factory's rules live in the brain's `factory/{planner,routing,merge}.yaml`
  (or a repository's `.tandemise/factory/` without a brain); see `docs/FACTORY.md`.
- The brain clone lives under `TANDEMISE_HOME/brains/`; the daemon owns it.
