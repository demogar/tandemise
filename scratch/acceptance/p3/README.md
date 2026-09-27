# P3a real-app acceptance suite: handing work in and back

```
npm run build
node scratch/acceptance/p3/run-all.mjs [--keep-going] [--only=d1,d3] [--hold]
```

Each run starts from a fresh install: a new `TANDEMISE_HOME` behind `/tmp/tdm-p3` (a short
symlink, for macOS socket-path limits), the daemon built from this checkout (`p0/setup.mjs`), and
the real desktop window (`electron-vite dev`, its own `--user-data-dir`, CDP on 9337). The
scenarios run in order and drive the window; the daemon's API and database are read only as proof.
Evidence (per-scenario JSON, screenshots, `REPORT.md`) is written to
`docs/superpowers/evidence/2026-09-27-p3a/` (or `$ACCEPTANCE_EVIDENCE_DIR`). `--hold` leaves the
window and daemon up; the next run stops them.

The model is the scripted agent (`p0/scripted-agent.mjs`); everything else is the product.

| File | ID | What it proves |
|---|---|---|
| `d1-upload-covers-spec.mjs` | D1 | A spec uploaded on New Mission (plan now, with Done-when) goes through intake before planning; the planner leaves the spec stage out, and the Plan tab shows it covered by the upload. Approved, the next stage's run reads the intake spec. |
| `d2-continue-elsewhere.mjs` | D2 | Continue elsewhere on a running design: "Waiting for your work in Figma", `task.parked_external` on the timeline, one more on the Desk, a row in the Inbox. On a second mission, Take it back returns the design to the agent. |
| `d3-hand-back-pr.mjs` | D3 | Hand back a GitHub pull request link whose head is only on the remote: fetched into `tandemise/pr-7`, a human round-2 ChangeSet on that commit, Evidence with `github.pr`, `git.commit` and that branch, the build's worktree retired, the review downstream cut from that branch, and a later agent round (Request changes) built on the PR. |
| `d4-unreadable-link.mjs` | D4 | A bare Figma link is refused ("Nothing here can read that link. Attach an export of it."); with an export attached, the export becomes the Evidence. |
| `d5-held-until-hand-back.mjs` | D5 | Parking a finished design holds the build waiting to start ("Waiting for 'design' from Figma."); after the hand-back the build runs on the handed-back version. |
| `d6-workspace-link.mjs` | D6 | "Open workspace ↗" on a hand-back and on an agent's handoff resolves through the daemon to the local file; a path out of the project is refused. |
| `d7-attribution.mjs` | D7 | A hand-back card reads "by You" (the responsible person left out); recording it for a teammate shows "recorded by You" on the card and in the reader. |
| `d8-feedback-file.mjs` | D8 | A file attached to Request changes is pinned, referenced from the note, and an input of the next round. |

D2, D4 and D8 share one mission (P2 chain); D5, D6 and D7 share another (`P3 hold`); D1 and D3
have their own. Scenarios hand state on through `/tmp/tdm-p3/state.json`, so run them in order.

## Scripted-agent modes this suite adds

Both are named in a mission goal, like the other `SCRIPTED_*` modes, so no other suite sees them.

- `SCRIPTED_PLAN_SKIP`: a planner prompt that lists a preexisting upload of type `ProductSpec` is
  answered with the preset the prompt offers, as JSON, minus the stage that writes the ProductSpec,
  which is named under `skipped` with the upload's id. It keeps only the capabilities the prompt
  says the installation can satisfy. Without the mode a planner prompt gets no JSON, as before.
- `SCRIPTED_WORKSPACE_LINK`: every handoff links `README.md` by path (`kind: workspace`).

Intake prompts list the person's Done-when lines as "Done when (the person's own lines; …)"; the
scripted spec now covers those, as it covers a product step's ledger.

## The fake `gh` (D3)

The daemon reads a handed-back pull request with `gh pr view <url> --json …` and `gh pr diff <url>`.
The run writes `/tmp/tdm-p3/bin/gh`, a shell wrapper around `fake-gh.mjs`, and puts that folder
first on the daemon's `PATH` (the daemon runs tools with an allowlisted environment that keeps
`PATH`, so the wrapper names its own state file). It knows one pull request: the one D3 writes to
`/tmp/tdm-p3/gh-pr.json` (`https://github.com/acme/app/pull/7`, whose head is a real commit D3 pushes
only to a bare "GitHub" remote as `refs/pull/7/head`; the project reaches it as
`https://github.com/acme/app.git` through an `insteadOf` rewrite, and the daemon fetches it into
`tandemise/pr-7`). For anything else it prints real gh's
"GraphQL: Could not resolve to a PullRequest with the number of N. (repository.pullRequest)" and
exits 1. Every call is appended to `/tmp/tdm-p3/gh-pr.json.calls`. The real `gh` is covered by the
offline stub-port test and by hand.

## Revealing a workspace link without opening Finder (D6)

"Open workspace ↗" asks the daemon to resolve the path, then reveals the answer in Finder. D6 wraps
the window's `fetch` to record the daemon's answer and passes the renderer an empty path, which the
main process ignores, so no Finder window opens during a run. The page is reloaded afterwards.

## A teammate for D7

Since 0.4.0 the window cannot add a person, and a solo project never shows "recorded by" (the
recorder is you, the author). D7's second half adds "Dana Reyes" through the daemon, hands back
recording it for her in the window's "Recording for", and removes her again at the end.
