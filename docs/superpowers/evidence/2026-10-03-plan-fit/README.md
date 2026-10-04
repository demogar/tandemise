# Plan fit: evidence

Found on a real mission ("Create a new job post for <Ashby role>"): the intake
agent stopped because the role is US-only, and said so in its handoff. The person
step after it had been planned as "read the questions in
`applications/23/questions.md` and paste your answers", a file that was never
written, and its drawer showed only that objective.

`node scratch/acceptance/plan-fit/run-all.mjs` (fresh `TANDEMISE_HOME`, the daemon
from this checkout, the real desktop window over CDP, the scripted agent) writes
`REPORT.md`, one JSON per scenario and the screenshots here.

| Scenario | What it proves |
|---|---|
| F1 | A person's step shows what the step before it handed over: "From “intake”", the headline, the points and the **Needs** line, above the objective that was planned before intake ran; **Full doc** opens the Evidence in place. |
| F2 | Intake's handoff says `stop`: intake succeeds, `draft` waits PENDING with "Waiting for you: 'intake' says the plan no longer fits.", one card ("Plan no longer fits") is in the Inbox and inline on intake's feed card with the reason; **Skip the steps after it** in the Inbox skips `draft` and `polish` with the reason, nothing after intake runs, and the mission completes. |
| F3 | **Send it back with a note**: intake runs round 2 briefed by the note; round 2 no longer says stop, so `draft` and `polish` run on it, and no second card is filed. |
| F4 | **Continue as planned**: `draft` and `polish` run on what intake wrote; intake stays round 1 and the card reads approved. |

Offline: `scratch/plan-fit-check.mjs` (the `stop` field and its template line; the hold, one card
however many ticks, the mission staying EXECUTING while it waits; skip, send back and continue) and
`scratch/handoff-check.mjs`, section "person step: what came in, and
questions go through ask_human" (the planner rule, and which artifacts a
person step lists: live, upstream, not a sibling's, with or without declared
inputs; none on an agent step).
