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
gh api -X PATCH repos/demogar/tandemise/pulls/<n> -f title="feat: …"
```

## Before you open a pull request

- Run `npm run ci` and make it green. It builds every package, enforces the
  architecture boundaries, the design tokens, licenses, desktop typecheck, and
  the offline checks.
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
  `apps/daemon` owns state. Boundary rule enforced by `npm run check:boundaries`.
- Design specs live in `docs/superpowers/specs/`, implementation plans in
  `docs/superpowers/plans/`, acceptance evidence in `docs/superpowers/evidence/`.
- Each sub-project is specced and planned before code is written, then proven
  in the real app.
