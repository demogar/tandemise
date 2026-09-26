# About acceptance report

Run: 2026-09-26T23:02:11.270Z · build d9141a8 · fresh install at /var/folders/dh/glpvvh110393gdzjc_v2x1sr0000gn/T/tdm-about-run-muizsgt8
Result: **ALL PASS** (5/5 scenarios)

| Scenario | Result | Checks |
|---|---|---|
| A1 — Settings → About shows versions, builds, schema and the data folder | PASS | 12/12 |
| A2 — Copy diagnostics copies versions and the data folder, never the token | PASS | 8/8 |
| A3 — The About panel shows version, build, copyright, license and the repository | PASS | 12/12 |
| A4 — A stale daemon shows a mismatch warning that says to restart it | PASS | 7/7 |
| A5 — Following the warning (kill the pid, npm run daemon) brings the app and daemon back in step | PASS | 4/4 |

## A1 — Settings → About shows versions, builds, schema and the data folder

- note: screenshot copied to apps/desktop/screenshots/31-settings-about.png for the guide
- ✅ the section is titled About, with the app version in its header — `["About","0.5.0 (d9141a8)"]`
- ✅ App reads "0.5.0 (d9141a8)" — `"0.5.0 (d9141a8)"`
- ✅ Daemon reads "0.5.0 (d9141a8)" — `"0.5.0 (d9141a8)"`
- ✅ Daemon status reads Running, an uptime and the process id — `"Running · up under a minute · process 92807"`
- ✅ Database schema reads the migration number — `{"row":"Version 17","migrated":17}`
- ✅ proof (API + SQL): /v1/system agrees with the database — `{"schemaVersion":17,"daemonBuild":"d9141a8"}`
- ✅ Data folder is this run's TANDEMISE_HOME, with Show in Finder — `"/tmp/tdm-about/home Show in Finder"`
- ✅ Electron row has Electron, Chromium and Node versions — `"33.4.11 (Chromium 130.0.6723.191, Node 20.18.3)"`
- ✅ Operating system names macOS and the architecture — `"macOS 15.0.1 (x64)"`
- ✅ no mismatch warning when both halves are this build
- ✅ links: Repository, Documentation, Report an issue, and Copy diagnostics — `"About\n0.5.0 (d9141a8)\nCopy diagnostics\nApp\t0.5.0 (d9141a8)\nDaemon\t0.5.0 (d9141a8)\nDaemon status\tRunning · up under a minute · process 92807\nDatabase schema\tVersion 17\nData folder\t\n/tmp/tdm-about/home\nShow `
- ✅ says what the copied text holds and that it has no tokens
- screenshot: `A1-settings-about.png`

## A2 — Copy diagnostics copies versions and the data folder, never the token

- note: clipboard:
Tandemise diagnostics
Generated: 2026-09-26T23:00:22.763Z

App
  Version: 0.5.0 (d9141a8)
  Electron: 33.4.11
  Chromium: 130.0.6723.191
  Node (app): 20.18.3
  OS: macOS 15.0.1 (x64)

Daemon
  Status: Running
  Version: 0.5.0 (d9141a8)
  API: v1
  Database schema: 17
  Uptime: under a minute (since 2026-09-26T22:59:46.753Z)
  Process id: 92807
  Node (daemon): v22.23.1
  Platform: darwin-x64
  Data folder: /tmp/tdm-about/home

Mismatch: none

- ✅ the button says Copied — `"Copied"`
- ✅ the clipboard changed and starts with "Tandemise diagnostics" — `"Tandemise diagnostics\nGenerated: 2026-09"`
- ✅ it has the app version and commit
- ✅ it has the daemon version and commit
- ✅ it has the schema, status, uptime and data folder
- ✅ it has Electron, Chromium, Node and the OS
- ✅ it has no bearer token (the one in daemon.json) — `43`
- ✅ it records no mismatch
- screenshot: `A2-copied.png`

## A3 — The About panel shows version, build, copyright, license and the repository

- note: setAboutPanelOptions received: {"applicationName":"Tandemise","applicationVersion":"0.5.0","version":"d9141a8","copyright":"Copyright 2026 Demostenes Garcia G. and the Tandemise contributors\nLicensed under the Apache License, Version 2.0","credits":"Source, documentation and issues:\nhttps://github.com/demogar/tandemise","website":"https://github.com/demogar/tandemise","iconPath":"/Users/demogar/projects/tandemise/tandemise-about/apps/desktop/build/icon.png"}
- note: About panel text (Accessibility):
Tandemise
Version 0.5.0 (d9141a8)

Source, documentation and issues:
https://github.com/demogar/tandemise
Copyright 2026 Demostenes Garcia G. and the Tandemise contributors
Licensed under the Apache License, Version 2.0
- ✅ test hook present (TANDEMISE_TEST_HOOKS=1)
- ✅ applicationName is Tandemise — `"Tandemise"`
- ✅ applicationVersion is 0.5.0 — `"0.5.0"`
- ✅ version (the build) is the commit d9141a8, not Electron's version — `"d9141a8"`
- ✅ copyright is NOTICE's line plus the Apache-2.0 license — `"Copyright 2026 Demostenes Garcia G. and the Tandemise contributors\nLicensed under the Apache License, Version 2.0"`
- ✅ credits and website point at the repository — `{"credits":"Source, documentation and issues:\nhttps://github.com/demogar/tandemise","website":"https://github.com/demogar/tandemise"}`
- ✅ the bridge has no test hook for anything else
- ✅ Help menu: Documentation, Report an Issue, Tandemise on GitHub — `"Documentation, Report an Issue, missing value, Tandemise on GitHub"`
- ✅ the app menu has About Tandemise — `"About Tandemise, missing value, Services, missing value, Hide Tandemise, Hide Others, Show All, missing value, Quit Tandemise, Quit and Keep Windows"`
- ✅ the open panel reads "Version 0.5.0 (d9141a8)" — `["Tandemise","Version 0.5.0 (d9141a8)","Source, documentation and issues:","https://github.com/demogar/tandemise","Copyright 2026 Demostenes Garcia G. and the Tandemise contributors","Licensed under the Apache License, V`
- ✅ the open panel shows the copyright and license
- ✅ the open panel shows the repository in its credits

## A4 — A stale daemon shows a mismatch warning that says to restart it

- note: daemon restarted with TANDEMISE_BUILD=0000000 (pid 96922)
- note: daemon restarted from this build (pid 97376)
- ✅ the warning says the daemon was built from different code — `"About\n0.5.0 (d9141a8)\nCopy diagnostics\nThe daemon was built from different code than the app. The app was built from commit d9141a8 but the daemon from 0000000. Run `npm run build`, then restart the daemon: run `kill`
- ✅ it names both commits (d9141a8 and 0000000) — `"About\n0.5.0 (d9141a8)\nCopy diagnostics\nThe daemon was built from different code than the app. The app was built from commit d9141a8 but the daemon from 0000000. Run `npm run build`, then restart the daemon: run `kill`
- ✅ it says what to do: build, kill the daemon's pid, start it again — `"About\n0.5.0 (d9141a8)\nCopy diagnostics\nThe daemon was built from different code than the app. The app was built from commit d9141a8 but the daemon from 0000000. Run `npm run build`, then restart the daemon: run `kill`
- ✅ the Daemon row shows the other commit — `"0.5.0 (0000000)"`
- ✅ the copied diagnostics record the mismatch — `["Mismatch: build (app d9141a8, daemon 0000000)",""]`
- ✅ and still no token
- ✅ after restarting the daemon from this build the warning is gone — `"About\n0.5.0 (d9141a8)\nCopy diagnostics\nApp\t0.5.0 (d9141a8)\nDaemon\t0.5.0 (d9141a8)\nDaemon status\tRunning · up under a minute · process 97376\nDatabase schema\tVersion 17\nData folder\t\n/tmp/tdm-about/home\nShow `
- screenshot: `A4-mismatch-warning.png`

## A5 — Following the warning (kill the pid, npm run daemon) brings the app and daemon back in step

- note: ran `npm run daemon` in the repository with the run's TANDEMISE_HOME
- ✅ the warning names the stale daemon's process id — `{"named":98738,"pid":98738}`
- ✅ the window notices the daemon stopped
- ✅ npm run daemon started a new daemon — `99095`
- ✅ without pressing anything, About shows the new daemon at d9141a8 and no warning — `{"App":"0.5.0 (d9141a8)","Daemon":"0.5.0 (d9141a8)","Daemon status":"Running · up under a minute · process 99095","Database schema":"Version 17","Data folder":"/tmp/tdm-about/home Show in Finder","Electron":"33.4.11 (Chr`
- screenshot: `A5-daemon-stopped.png`
- screenshot: `A5-matching-again.png`
