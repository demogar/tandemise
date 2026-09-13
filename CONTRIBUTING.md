# Contributing to Tandemise

Thanks for your interest in Tandemise. This guide covers how changes get from a
branch to a release.

## Ground rules

- Be kind. Everyone taking part is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
- Report security problems privately. See [SECURITY.md](SECURITY.md) and never open a public issue for them.
- For anything bigger than a small fix, open an issue first so the design can be agreed before you write code.
  `MVP.md` and `docs/adr/` explain how the system is meant to work.

## Development setup

Tandemise needs **Node 22** (see `.nvmrc`) and macOS for the desktop app and native helper.

```bash
nvm use
npm ci
npm run build
npm run daemon    # tandemd
npm run desktop   # Electron app
```

## Before you open a pull request

Run what CI runs:

```bash
npm run ci
```

That builds every package, enforces the architecture boundaries
(`npm run check:boundaries`), rejects dependencies whose license
does not fit Apache-2.0 (`npm run check:licenses`), typechecks the desktop app, and runs the offline
end-to-end checks (`npm run check:offline`). The checks that need a signed-in
runtime, a browser or macOS permissions are listed in `docs/QUICKSTART.md`.
Run the ones that cover your change by hand.

## Branches, pull requests and commits

- `main` is protected. Every change lands through a pull request that passes CI.
- Pull requests are **squash-merged**. The PR title becomes the commit on `main`,
  so it must follow [Conventional Commits](https://www.conventionalcommits.org/):

  ```
  <type>(<optional scope>): <lowercase subject>
  ```

  | Type | Use it for | Release effect |
  |---|---|---|
  | `feat` | a user-visible capability | minor bump (patch while < 1.0) |
  | `fix` | a bug fix | patch bump |
  | `perf` | a performance improvement | patch bump |
  | `refactor`, `docs`, `test`, `build`, `ci`, `chore` | everything else | no release on its own |

  Add `!` after the type (`feat(api)!: ...`) or a `BREAKING CHANGE:` footer for
  breaking changes.
- Keep pull requests focused. One concern per PR makes review and the changelog clearer.
- Keep the branch up to date with `main` before merging.

## Repository settings

`main` is guarded by the ruleset in `.github/rulesets/main.json`: no direct
pushes, force pushes or deletion; changes arrive by squash-merged pull request
with resolved conversations and passing `Build & typecheck`, `Offline checks` and
`Conventional PR title` checks. Admins can bypass only through a pull request.
To change it, edit the file and re-apply it:

```bash
gh api -X PUT repos/demogar/tandemise/rulesets/<id> --input .github/rulesets/main.json
```

## Releases

Releases are automated with [release-please](https://github.com/googleapis/release-please).

1. Every merge to `main` updates an open **release PR** (`chore(main): release x.y.z`)
   that bumps the version and writes `CHANGELOG.md` from the commit history.
2. Merging that PR tags `vx.y.z` and publishes a GitHub Release.

The whole monorepo shares one version. All `@tandemise/*` packages, the daemon
and the desktop app move together. Never edit versions or `CHANGELOG.md` by hand.

## License

By contributing, you agree that your contributions are licensed under the
[Apache License 2.0](LICENSE).
