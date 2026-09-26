# Evidence: unmeasured checks never pass a preset gate

Branch `fix/unmeasured-checks-never-pass`, 2026-09-26.

## The change

The build step of the `feature-delivery` preset (`implement`) and the fix step of
the `bug-investigation` preset (`fix`) gated on `checks.tests != FAIL`. That is
also true when there is no test result at all, so a build whose tests were never
run could clear its gate. Now:

- a repository that declares a test command gets `checks.tests == PASS`;
- a repository with no test command keeps `checks.tests != FAIL`, because there
  nothing can be measured and SKIP is the honest answer.

The planner prompt carries the same rule for the repository in hand, and the
docs example gates now spell the fact `checks.tests` (they said `checks.test`,
which is not a fact the daemon measures, so it was always unmeasured).

## Offline check

`node scratch/gate-facts-check.mjs`: 40 checks, all pass. The new section
"an unmeasured test result never passes a preset gate" failed 8 of its checks
on the old presets (gate still `!= FAIL`, and a ChangeSet with no test result
read "All gate conditions met.") and passes with the change. With the change, an
unmeasured result reads `Not met: checks.tests is not measured, needs PASS`.

`npm run check:offline`: all 26 offline checks pass.

## Live daemon

Fresh `TANDEMISE_HOME` at `/tmp/tdm-gh`, daemon from this branch's build, the
acceptance project (test command `npm test`, which passes), a `bug-investigation`
mission driven through the API:

```
repository acceptance-project test command: npm test
  fix: artifact.ChangeSet.exists && checks.tests == PASS
fix task: SUCCEEDED {"expression":"artifact.ChangeSet.exists && checks.tests == PASS","passed":true,
  "detail":"All gate conditions met.","facts":{"artifact.ChangeSet.exists":true,"checks.tests":"PASS"}}
```

The gate cleared only on a measured PASS from the repository's own test command.

## Real-app suites (scripted agent, `--skip-claude --keep-going`)

| Suite | Result on this branch | Result on `main` (9c49f64) |
|---|---|---|
| P1 (B1-B14) | 14/14 scenarios PASS | not re-run |
| P2 (C1-C9, C11, C12) | 11/11 scenarios PASS | not re-run |
| P0 A1 | PASS (11/11) | PASS (11/11) |
| P0 s02-s08 | fail: `no clickable element labelled "Add person"`, then `no member Maria Lopez / Ana Ruiz / Bo Chen` | same failures, same messages |

The P0 team scenarios (s02, s03, s04, s05, s07, s04b, s08) already fail on
`main`. They add people through the "Add person" button that 0.4.0 removed
("focus the team on you + your agents"). This change touches no desktop code and
no team code. Those scenarios need rewriting for the agents-only team, which is
separate work.

No scripted scenario sets up a preset mission with a test command: the P0/P1/P2
suites run the project's own workflows (`scratch/acceptance/p0/workflows/`),
whose gates do not read `checks.tests`. The acceptance project's test command
exits 0, so any preset mission run on it still clears the stricter gate, as the
live run above shows. No scenario setup needed changing.
