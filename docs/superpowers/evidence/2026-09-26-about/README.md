# About and diagnostics: evidence

Headline: **5/5 real-app scenarios pass** (A1–A5, 43/43 checks) on a fresh install, built from `feat/about-and-diagnostics` (d9141a8, merged with main at 044fb92). Offline: `about-check` 43/43; `npm run ci` green.

## How it was run

```bash
npm run build
node scratch/acceptance/about/run-all.mjs --keep-going     # CDP 9364, home /tmp/tdm-about, TANDEMISE_TEST_HOOKS=1
ACCEPTANCE_LINK=/tmp/tdm-about-reg CDP_PORT=9364 node scratch/acceptance/p0/run-all.mjs [--p1|--p2] --skip-claude --keep-going
```

Every action is taken in the window (real CDP mouse clicks on Copy diagnostics; Settings navigation) or the way a person would outside it (`kill <pid>`, `npm run daemon`). The macOS clipboard is read with `pbpaste` and restored afterwards. The native About panel cannot be read over CDP: A3 reads the options passed to `setAboutPanelOptions` through the test-only `window.tandemiseTest` bridge (present only with `TANDEMISE_TEST_HOOKS=1`), and also reads the open panel and the Help menu through macOS Accessibility (System Events).

## Scenarios

| # | Scenario | Result |
|---|---|---|
| A1 | Settings → About: App and Daemon `0.5.0 (d9141a8)`, "Running · up … · process n", "Version N" = `MAX(version)` of `schema_migrations`, data folder with Show in Finder, Electron/macOS rows, links, no warning | PASS 12/12 |
| A2 | Copy diagnostics (real click) → "Copied"; clipboard has both versions, schema, status, uptime, data folder; not the token from `daemon.json`, no "Bearer"/"token" | PASS 8/8 |
| A3 | Panel options: version = commit, NOTICE copyright + Apache-2.0, credits/website = repository; open panel reads "Version 0.5.0 (d9141a8)", the copyright and the link; Help = Documentation, Report an Issue, Tandemise on GitHub | PASS 12/12 |
| A4 | Daemon restarted with `TANDEMISE_BUILD=0000000` → warning names both commits and `kill <pid>`; copied text records the mismatch; restarted normally → warning gone | PASS 7/7 |
| A5 | Following the warning literally (`kill <pid>`, `npm run daemon`) → the window reconnects by itself, commits match, no warning | PASS 4/4 |

Before the fix, on the same machine, the open panel read "Tandemise / Version 0.5.0 (33.4.11)" (Electron's bundle version in the brackets), with no copyright or credits, and Help listed Learn More, Documentation, Community Discussions, Search Issues (Electron's).

## Regression (same build)

| Suite | Result |
|---|---|
| p0 | A1 PASS; stops at s02, which fails on `main` already ("Add person" was removed in 0.4.0; recorded in earlier evidence) |
| p1 | ALL PASS 14/14 |
| p2 | ALL PASS 11/11 |

See `REPORT.md` for every check with its observed value.
