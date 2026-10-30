# Review and QA can run commands on Claude Code: evidence

Real missions in the desktop window on a fresh install (Linux, WSLg), with
Claude Code 2.1.295 as the only runtime and nothing scripted.

## What was wrong

A Quick change mission (`--top N` for a small word-count CLI) finished
Complete. The reviewer's handoff said:

> Every shell command was denied approval, so npm test and the CLI checks were not run by this reviewer

The mission's events show `npm test`, `node src/cli.js …` and a compound
`git` command each completed with `outcome: error` and "This command requires
approval". Only plainly read-only commands such as `git show` ran. Nothing
reached the person: Needs you stayed at 0.

`before-reviewer-could-not-run.png` is that mission.

## Root cause

`permissionMode()` in `packages/runtime-claude/src/cli-args.ts` derives the
headless mode from the grants:

- write and shell → `bypassPermissions`
- write only → `acceptEdits`
- otherwise → `default`

Review (`shell.exec` + `artifact.write`) and QA (`shell.exec`, `tests.run`,
`browser` + `artifact.write`) have shell but not `filesystem.write`, so they
fell to `default`. In that mode headless Claude Code refuses any shell command
that needs a prompt, and nobody is there to answer one.

Reproduced against the real CLI with the reviewer's exact flags:

```
$ claude -p 'Run npm test …' --model haiku --permission-mode default \
    --setting-sources project,local --allowed-tools 'Edit(.tandemise/out/**)' \
    --disallowed-tools NotebookEdit
DENIED
$ claude -p 'Run npm test …' --model haiku --permission-mode default \
    --setting-sources project,local --allowed-tools 'Edit(.tandemise/out/**),Bash' \
    --disallowed-tools NotebookEdit
PASSED
```

## After

| Mission | Shell calls (role:outcome) | Refused |
|---|---|---|
| Bug investigation: punctuation splits words | development ok 4 / error 1 (a failing test before the fix), review ok 5, qa ok 8 | none |
| Quick change: `--top N` (with the quick-change verify step) | development ok 4, review ok 8, qa ok 5 | none |

- `after-bug-fix-9-of-9.png`: QA verified 9 of 9 criteria. The evidence for
  each criterion is the command it ran and the output.
- `after-quick-change-review-ran-tests.png`: the reviewer reads "npm test
  passes 12/12. I ran it myself". QA checked that the tests catch a broken
  tie-break by removing it.
- `after-*-summary.json`: shell outcomes per role, from the mission's events.
