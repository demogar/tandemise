# P14 evidence: GitHub issues in and out

Headline: **4/4 real-app scenarios pass** (O1–O4, 33/33 checks) on a fresh install built from `feat/p14-github-issues` (base `feat/p13-skills-library`); REPORT.md is that run. Offline: `p14-issues-check` 113/113; `npm run ci` green.

## How it was run

```bash
npm run build
node scratch/acceptance/p14/run-all.mjs           # CDP 9349, home /tmp/tdm-p14
ACCEPTANCE_LINK=/tmp/tdm-p14r0 CDP_PORT=9379 node scratch/acceptance/p0/run-all.mjs [--p1|--p2] --skip-claude --keep-going
node scratch/acceptance/p11/run-all.mjs; node scratch/acceptance/p13/run-all.mjs
```

GitHub is a fake `gh` (`scratch/fake-gh.mjs`) installed first on the daemon's PATH: it serves the issues and comments of `example/hello-site` from `/tmp/tdm-p14/gh/state.json` and appends every call to `calls.jsonl`. Each scenario files its own issues into that file (the stand-in for a contributor using GitHub). The project's checkout gets the remote `https://github.com/example/hello-site.git`; nothing reaches the network.

Every setting and decision is made in the window: the GitHub repository, workflow and switches in Repositories → Issues, Check now, Plan in the mission header, and the plan approval in the Inbox. The API and the fake gh's record are read only as proof.

No real-model scenario: what reaches GitHub is decided by the daemon from the mission's state.

## Scenarios

| # | Scenario | Result |
|---|---|---|
| O1 | Repositories → Issues: type `example/hello-site`, workflow "P10 desk", switch on; issue #11 has a `## Done when` checklist; Check now → "Last checked just now · 1 linked"; Backlog row "#11 Offline mode for the hello page", Ready, Queued; header "From issue #11"; Done when U1–U3, each "From the GitHub issue"; goal "GitHub issue #11 in example/hello-site, opened by @sam"; fake gh has one "Queued in Tandemise — 3 criteria." comment | PASS 12/12 |
| O2 | Issue #12 with no criteria; Check now → "· 2 linked"; Backlog "#12", "Needs refinement", "Not queued"; nothing posted on #12 | PASS 4/4 |
| O3 | Switch on "Close the issue when the mission completes"; Plan, approve in the Inbox, mission COMPLETE; one completion comment "Done in Tandemise — N of N criteria verified." with U1–U3 Verified and "Closing this issue"; exactly one `gh issue close 11 --repo example/hello-site`; timeline "Closed GitHub issue #11: every criterion was verified."; nothing more written on later passes | PASS 9/9 |
| O4 | Check now again: GitHub read, no new mission; issue #13 (Acceptance criteria) → queued; closed upstream → Check now → "Not queued", timeline "Issue #13 was closed upstream, so this draft was taken off the queue."; still a DRAFT, link closed | PASS 8/8 |

## Found and fixed while proving it

- Criteria parsed from an issue showed "Added by you" on the mission's Done when. They now read "From the GitHub issue" (`RefinementCriterionView.origin = 'issue'`), and O1 asserts it.

## Regression (`--skip-claude`, same build)

| Suite | Result |
|---|---|
| p0 | ALL PASS 12/12 |
| p1 | ALL PASS 14/14 |
| p2 | ALL PASS 11/11 |
| p11 | ALL PASS 4/4 |
| p13 | ALL PASS 4/4 |
