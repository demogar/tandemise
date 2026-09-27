# Daemon retry: evidence

Retry on the "daemon is not running" screen, and the desktop's own start on
launch, now run the daemon with a real Node 22+ instead of Electron's bundled
Node 20.

## Root cause

`DaemonConnector` spawned `process.execPath` with `ELECTRON_RUN_AS_NODE=1`, so
the daemon ran on Electron 33's Node 20.18.3 (`NODE_MODULE_VERSION` 130).
`better-sqlite3` is compiled by `npm install` for the system Node 22
(`NODE_MODULE_VERSION` 127), so the first `new Database()` threw and the daemon
printed `tandemd failed to start: Cannot open database at <home>/tandemise.db`
to a stderr nobody read. The window then waited 15 s and said "did not report a
connection". Reproduced by hand:

```
$ ELECTRON_RUN_AS_NODE=1 Electron -e 'require("better-sqlite3")(":memory:")'
The module '.../better_sqlite3.node' was compiled against a different Node.js
version using NODE_MODULE_VERSION 127. This version of Node.js requires
NODE_MODULE_VERSION 130.
$ TANDEMISE_HOME=/tmp/tdm-repro ELECTRON_RUN_AS_NODE=1 Electron apps/daemon/dist/main.js
tandemd failed to start: Cannot open database at /tmp/tdm-repro/tandemise.db
```

`scratch/daemon-node-check.mjs` re-proves this premise on every CI run where
Electron is installed.

## Files

| File | What it shows |
| --- | --- |
| `REPORT.md` | Scenario table from the last run |
| `R1.json`, `R1-home-connected.png` | Launch with no daemon: the window starts one on `~/.nvm/.../node` v22 and Home renders |
| `R2.json`, `R2-not-running.png`, `R2-after-retry.png` | Daemon stopped under the window: not-running screen, Retry, new pid, `/v1/system` 200 |
| `R3.json`, `R3-no-node.png` | `TANDEMISE_NODE_SEARCH_PATH=""`: the plain "needs Node.js 22" message, no stack |
| `R4.json`, `R4-bad-override.png` | `TANDEMISE_NODE=/nonexistent/bin/node`: the message names the setting |
| `baseline-main-R1.json` | The same R1 against `origin/main`'s `daemon-connection.ts`: not-running screen, "did not report a connection within 15s" |

## Rerun

```
npm run build
node scratch/daemon-node-check.mjs
node scratch/acceptance/daemon-retry/run-all.mjs   # CDP 9365, TANDEMISE_HOME under /tmp/tdm-retry
```
