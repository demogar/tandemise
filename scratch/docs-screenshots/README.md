# Docs screenshots

Every picture in `apps/desktop/screenshots/` comes from the real app, running on
seeded demo data: a project called **Taskly**, owned by **Sam**, with four agents
on a scripted demo runtime. No model is called and nothing leaves the machine.
These scripts rebuild that state from nothing and take every picture again, so
refreshing the screenshots after a UI change is one repeatable step.

## Regenerate all screenshots

From the repository root, on a clean build:

```bash
npm run build                                   # the daemon runs from apps/daemon/dist
node scratch/docs-screenshots/seed.mjs          # fresh home, daemon + desktop, demo data (~3 min)
node scratch/docs-screenshots/capture.mjs       # writes apps/desktop/screenshots/*.png
node scratch/docs-screenshots/stop.mjs          # stops the daemon, the window and the demo agents
node scratch/docs-screenshots/offline.mjs       # 21-daemon-down.png, from a window with no daemon
node scratch/docs-screenshots/stop.mjs
```

Retake only some of them by naming them:

```bash
node scratch/docs-screenshots/capture.mjs 03-mission-plan,10-team
```

Then open every changed image before committing. None may show a personal name,
an email address, a hostname, a path under a home directory, or a token.

## What each script does

| Script | Does |
| --- | --- |
| `seed.mjs` | Deletes and recreates `DOCS_ROOT`, makes the Taskly git repository with three project workflows, starts the daemon (`TANDEMISE_OWNER_NAME=Sam`) and `electron-vite dev` with CDP, and seeds missions in every state the screenshots need: one stalled, one waiting on a release card with QA partly verified, one whose agent went quiet, one stopped at its limit, drafts in the backlog, one being refined, a monthly limit, a full work-in-progress limit, three routines, a status report and four agents. Writes `state.json` with the mission ids. |
| `make-demo-agent.mjs` | Called by `seed.mjs`. Copies `scratch/acceptance/p0/scripted-agent.mjs` to `DOCS_ROOT/demo-agent.mjs` with neutral, Taskly-flavoured text, so no screenshot says "scripted". |
| `capture.mjs` | Connects over CDP, sets the window to 1360x900, and takes each shot in the list, dark unless the name ends in `-light`. |
| `offline.mjs` | Opens a window whose daemon cannot start and takes `21-daemon-down.png`. |
| `stop.mjs` | Kills everything the other scripts started. |

## Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `DOCS_ROOT` | `/tmp/tdm-docs2` | Where the demo home, repository and logs live. It is deleted on every seed. |
| `DOCS_CDP_PORT` | `9352` | The remote-debugging port of the desktop window. |
| `DOCS_OUT` | `apps/desktop/screenshots` | Where `capture.mjs` and `offline.mjs` write. Point it at a scratch folder to look before you replace anything. |

Times on screen ("2m ago", "Quiet for 2 min") and the daemon's port and process
id change on every run; everything else is the same each time.

## Adding a screenshot

Add a `[name, prepare]` entry to the list in `capture.mjs` (take the next free
number), seed whatever state it needs in `seed.mjs`, and reference the file from
the README or the guide it illustrates.
