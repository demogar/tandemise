# About and diagnostics: which code is running, and a report that is safe to paste

## Problem

The macOS About panel (app menu → About Tandemise) said little: in development
it read "Tandemise, Version 0.5.0 (33.4.11)", where the number in brackets is
Electron's own bundle version, not anything about Tandemise, and there was no
copyright, license or link. The owner reported it as showing only the name.
The Help menu was Electron's default and opened Electron's documentation and
forums.

Inside the app there was no single place that answered "is the daemon I am
talking to the code I just built?", which is the most common cause of a
confusing bug for one person running Tandemise from their own checkout, and
there was no safe way to hand those facts to an issue.

## Why the About panel looked like that

`setAboutPanelOptions({ applicationName, applicationVersion, iconPath })`
works; `app.getVersion()` returns `0.5.0` in development because
`electron-vite dev` runs Electron against `apps/desktop`, whose `package.json`
is 0.5.0. macOS prints `Version <applicationVersion> (<version>)`, and with
`version` unset it takes `CFBundleVersion` from the running bundle, which in
development is `node_modules/electron/dist/Electron.app` (33.4.11). The
copyright and credits were never set. `iconPath` is ignored on macOS (the
bundle icon is used).

There is no packaged build configuration in the repository (no
electron-builder or forge config), so there is no packaged `Info.plist` to
check. The fix does not depend on one: `version` is set explicitly.

## Goal

- The About panel reads `Version 0.5.0 (<commit>)`, with the copyright from
  NOTICE, the Apache-2.0 license and the repository link.
- **Help** has **Documentation** and **Report an Issue** (and **Tandemise on
  GitHub**) instead of Electron's items.
- **Settings → About**, appended at the bottom: app version and commit, daemon
  version and commit, a mismatch warning that says what to do, daemon status,
  uptime and process id, database schema number, data folder with **Show in
  Finder**, Electron/Chromium/Node and OS versions, and links to the
  repository, the docs and a new issue.
- **Copy diagnostics** puts a plain-text block of all of that on the
  clipboard. It never contains a token or a secret.

## Not in this change

- Packaging (electron-builder, signing). The About panel is correct either way.
- Fixing the app's own daemon auto-start (see Rulings): the advice tells the
  person to start the daemon by hand, which works.
- Merging Settings' existing **Daemon** section into About. Other slices are
  editing Settings at the same time, so this change only appends a section.

## Design

**Build identifier.** A short git commit (`git rev-parse --short=7 HEAD`),
`dev` when git is unavailable.

- App: `electron.vite.config.ts` computes it and injects
  `__TANDEMISE_BUILD__` into the main bundle with `define`.
- Daemon: `npm run build` ends with `scripts/write-build-info.mjs`, which
  writes `apps/daemon/dist/build-info.json`. `loadConfig` reads it into
  `config.build` (anything that is not a hex commit reads as `dev`).
  `TANDEMISE_BUILD` overrides it; it exists for the real-app suite.
- `GET /v1/system` gains `daemonBuild` (through `SystemEnvironmentPort`).

**Shared rules.** `packages/api-contract/src/about.ts` has no imports and is
exposed as the pure subpath `@tandemise/api-contract/about` (allowlisted in
`check:boundaries`, like `for-me`). It holds the links, `versionMismatch`,
`mismatchAdvice`, `uptimeText`, `versionWithBuild` and `diagnosticsText`. The
renderer, the main process and the offline check use the same functions.

**Mismatch.** Different versions, or the same version with two known and
different commits. `dev` on either side is never a mismatch.

**Diagnostics text.** Built line by line from named fields only; it never
serialises an object, so the daemon handshake (which carries the token) cannot
leak by being passed along. Newlines inside values are flattened so a value
cannot forge a line. The person's home folder is shown as `~`.

**Desktop.**
- `src/main/about.ts`: `appAboutFacts()` (served on a new `app:info` IPC as
  `window.tandemise.getAppInfo()`), `aboutPanelOptions()`,
  `installApplicationMenu()`.
- Clipboard: the session permission handler denied every permission, which
  also made `navigator.clipboard.writeText` fail ("Write permission denied"),
  so the existing copyable ids never copied either. It now allows
  `clipboard-sanitized-write` only; reading the clipboard stays denied.
- Test hook: with `TANDEMISE_TEST_HOOKS=1` the main process passes
  `--tandemise-test-hooks` to the renderer and the preload exposes
  `window.tandemiseTest.aboutPanelOptions()`. Without it there is no such
  object.
- `screens/SettingsAbout.tsx`, appended to `Settings.tsx` with one line.

## Words

- Warning, versions differ: "The app and the daemon run different versions.
  The app is 0.5.0 but the daemon is 0.4.0. Restart the daemon: run `kill
  4242` in a terminal, then `npm run daemon` in the repository. The window
  reconnects by itself."
- Warning, commits differ: "The daemon was built from different code than the
  app. The app was built from commit 92f0f03 but the daemon from 0000000. Run
  `npm run build`, then restart the daemon: …"
- Under the links: "Reporting a problem? Press Copy diagnostics and paste the
  text into the issue. It holds versions, the data folder and the daemon's
  state, never tokens or settings."

## Testing

Offline, `scratch/about-check.mjs` (in OFFLINE_CHECKS): the copied text has
every fact and none of a planted token, API key or `Bearer`, even when the
input objects carry them; the version rules; uptime; the build stamp and its
fallback; the `TANDEMISE_BUILD` knob; the About source matches NOTICE; a real
daemon's `/v1/system` reports version and build, and text built from it with
the real token in reach does not contain the token.

Real app, `scratch/acceptance/about/` (CDP 9364, home `/tmp/tdm-about`):

| # | Scenario |
|---|---|
| A1 | Settings → About shows app and daemon `0.5.0 (<commit>)`, Running with uptime and pid, `Version <n>` equal to `MAX(version)` in `schema_migrations`, the data folder with Show in Finder, Electron and macOS rows, the links, no warning |
| A2 | A real click on Copy diagnostics: "Copied"; the macOS clipboard has both versions, schema, status, data folder, and not the token from `daemon.json` |
| A3 | `setAboutPanelOptions` received version = commit, NOTICE copyright + license, credits and website; the open panel (read through macOS Accessibility) reads `Version 0.5.0 (<commit>)`, the copyright and the link; Help has Documentation / Report an Issue |
| A4 | Daemon restarted with `TANDEMISE_BUILD=0000000`: the warning names both commits and the pid; copied text records the mismatch; restarted normally, the warning goes |
| A5 | Following the warning literally (kill the pid, `npm run daemon`): the window reconnects by itself and the warning goes |

## Rulings

- **The About panel is verified two ways.** CDP cannot read a native window,
  so the options object is read through a test-only bridge; the panel itself
  is also read through macOS Accessibility (System Events) when the machine
  allows it.
- **Commit mismatch counts.** Same version, different commit is the usual
  stale-daemon case for someone running from a checkout, so it warns too,
  with "run `npm run build`" first.
- **The advice says `npm run daemon`, not Retry.** Retry on the daemon-down
  screen spawns the daemon with Electron's bundled Node (20), which cannot
  open the database ("Cannot open database"), so Retry alone does not bring a
  daemon back in development. That is a separate defect; this change does not
  promise something that fails.
- **Clipboard write allowed, read denied.** Needed for Copy diagnostics; it
  also fixes the copyable ids.
- **Home shown as `~` in the copied text.** Less personal detail in a public
  issue; the screen shows the full path.
- **Menu labels use macOS title case** ("Report an Issue"); the Settings link
  reads "Report an issue" like the app's other buttons.
- **The existing Daemon section stays.** It overlaps (version, schema, home);
  folding it into About is a follow-up once the parallel Settings changes land.
