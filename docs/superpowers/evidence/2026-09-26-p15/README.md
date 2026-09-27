# P15 evidence: setup as code, and gates that can pass

Build `0f1389c` (branch `feat/p15-setup-as-code`, base `main` 73280cc). **4/4 real-app scenarios pass**; offline check **123/123**; `npm run ci` green.

## How it was run

```bash
npm run build
node scratch/p15-setup-check.mjs                 # offline, also in OFFLINE_CHECKS
node scratch/acceptance/p15/run-all.mjs          # fresh /tmp/tdm-p15, CDP 9350, window 1360x900
```

The window runs with `TANDEMISE_TEST_PICK_DIRECTORY` so the import folder can be chosen without a native dialog.

## Scenarios

| # | Scenario | Result |
|---|---|---|
| Q1 | Export from Project → Setup as code: files and content hash in the window, "Last exported <hash>", files on disk (model, limits, routines, workflows), a second export has the same hash, git does not ignore the files | PASS 13/13 |
| Q2 | `model:` edited in `roles/development.md` → preview shows exactly one Change (Developer, "model: base-model → better-model") → Apply → Team → Roles shows the new model | PASS 8/8 |
| Q3 | Routine added to `routines.yaml` → Add, "Arrives off" → Apply → Missions → Routines shows it Off with "Imported — review and turn on"; no mission created | PASS 8/8 |
| Q4 | Workflow files whose gate reads `mission.stalled` / misses `artifact.ChangeSet.exists` → New mission shows each reason | PASS 4/4 |

Details in `REPORT.md` and `Q*.json`; screenshots `Q*-*.png`.

## Offline

`offline-check.txt` is the passing run of `scratch/p15-setup-check.mjs`. `offline-check-red.txt` is the same check run on `main` before the change (fails: the setup folder adapter and the new exports do not exist).

## Regression (real app, --skip-claude, separate homes and ports)

p0 14/14, p0 --p1 14/14, p0 --p2 11/11, p5 5/5, p6 6/6, p7 5/5, p8 5/5, p9 4/4, p10 3/3, p11 4/4, p12 4/4 — all pass.

## Found and fixed while building it

- `.tandemise/.gitignore` (`*`) and the `.tandemise/` exclude line hid every workflow file and the exported setup from git. Now only `.tandemise/out/` is ignored, and export repairs the old lines.
- `docs/examples/build-feature.yaml`'s build gate never checked its ChangeSet; the validator refused it, and the example now reads `artifact.ChangeSet.exists`.
