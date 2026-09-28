# Score a change before it goes live

Every step with a completion gate already leaves behind a measured fact when
it finishes — its gate passed or not, how many criteria it left verified,
what it cost. Evals lets you save one of those steps as a case, then replay
it with a different model, a different skill version or a whole different
setup, and see the two side by side. Nothing about a mission's own run is
ever changed by a score, and nothing an eval run finds is applied to your
project for you.

Open **Evals** in the sidebar (or ⌘K → Evals).

## What gets scored, and when?

Any step whose executor is an agent and whose workflow gives it a completion
gate is scored the moment its gate is assessed — every attempt, in every
mission, whether it passes or not. You don't turn this on; it happens for
every gated step automatically. What is kept: whether the gate passed, the
criteria it left verified, failed and unverified, tokens, cost, wall time and
how many attempts it took.

A score is a measured fact, never a judgement, and the engine that runs your
missions never reads one back — nothing about how the next run goes changes
because an earlier one scored well or badly. Scoring started with this
update; nothing before it was recorded, so a step that ran before you
upgraded has no score to show.

## "From your runs"

The **From your runs** tab reads those scores back, by role and model, over
the last 7, 30 or 90 days:

| Column | What it means |
|---|---|
| Runs | How many scored attempts went into this row |
| First-attempt pass | Share of steps whose very first attempt, made on this model, passed the gate, no retry needed |
| Attempts to pass | Mean attempts a step needed before its gate passed, counting only steps that did pass |
| Criteria failed | Total criteria left failed across every scored run |
| Median cost | Median reported cost per run |
| Median time | Median reported wall time per run |

A step's first attempt and its attempts to pass belong to the model that made
its first attempt. When a retry escalates to a bigger model, that model's row
counts the run, but not the step's first attempt or its attempts to pass.

This is your project's own history — real missions only. An eval trial never
appears here, no matter how many you run: trying a candidate could otherwise
quietly move your own numbers.

## Saving a case

**Save as eval case** appears on a step's feed card, and in its task drawer,
but only once the step has actually finished: its status is `SUCCEEDED`, its
executor is an agent, and its workflow gave it a completion gate. The gate is
what scores a run, so a step with no gate has nothing an eval could measure —
Tandemise refuses it: "Only a step with a completion gate can be an eval
case, because the gate is what scores it." Because a case needs a gate and a
finished run, planning, refinement and intake — none of which write a scored
run — can never become one.

Saving pins everything a replay needs, frozen at that moment:

- the step's inputs, as bytes, in their own store so they outlive the
  mission or any cleanup of it;
- the commit its work started from — the newest live `ChangeSet` among the
  step's own upstream work if there is one, otherwise the branch the mission
  itself started from;
- the step itself: its objective, expected outputs, required capabilities,
  completion gate, retry policy and wall-time budget;
- the mission as it stood then: title, goal, constraints, the workspace's
  knowledge, its accepted decisions, its answered questions, and its active
  criteria.

If the base commit can no longer be found — the branch it started from is
gone — saving is refused: "The branch this step started from no longer
exists, so this step can't be saved as a case." Pick an existing suite or
name a new one; a case's name is 1–80 characters. Cases live under **Suites**
in Evals; deleting a case or a whole suite never touches the mission it came
from.

## Running a candidate

**New run**, on the **Runs** tab: pick a suite, then what to try —

| Try | What you set |
|---|---|
| **Models** | one model string per role the suite's cases use, prefilled with the role's model today |
| **Skills** | one version per skill a role pins — an exact version, or "latest" resolved when the run starts |
| **Setup** | a folder — a repository or its `.tandemise` folder; its roles are tried exactly as the folder has them |

Set **Repeats** (1 to 10, 3 by default) and a **Spend cap ($)** — required,
above zero. The baseline is today's setup for every role the suite's cases
use, frozen the moment the run starts; the candidate is that same baseline
with your one change laid over it. Only the roles you change go into the
candidate. If you leave every role as it is, the form says "This candidate
changes nothing." A role you leave alone also keeps any model its case's
step pinned for itself, on both sides. Nothing here is ever written back to your
project — a setup candidate reads the folder you point at and applies
nothing, the same way **Apply** on Setup as code is a separate, later step.

Only one eval run goes at a time per project — starting a second is refused
("Another eval run is still going in this project."), and within a run its
trials run one at a time too: case by case, repeat by repeat, baseline then
candidate, so a run you stop partway through still holds whole pairs to
score.

Each trial is a hidden mission: the case's inputs are seeded as already-
finished upstream work, and its frozen knowledge, decisions, answers and
criteria are replayed exactly. What is *not* frozen is the role itself and
the engine driving it — a trial runs its step through today's workflow
engine and gate vocabulary, and the baseline uses whatever the role's own
setup is today, which is the whole point: you're comparing what the role
would do now, and with your change, on the same starting point. Nobody is
asked anything mid-trial. A worker's `ask_human` is answered "nobody" and it
continues on its own judgement; any tool approval it would otherwise wait
on is denied outright. A trial that would need a person to unblock it simply
fails instead of waiting.

## Reading the scorecard

The scorecard fills in as trials finish: one table for the whole suite, and
one row per case that expands to the same table.

| Measure | What it means |
|---|---|
| Trials | "N ran · P passed · F failed · B blocked": N trials ran to a score (the rates below are over these), P of them passed their gate and F didn't. B were blocked. "· E errored" is added when E trials failed with no score, from a setup or infrastructure error |
| Gate pass rate | share of completed trials whose gate passed |
| First-attempt pass rate | share of completed trials that passed with no retry |
| Criteria | verified / failed / unverified, summed over completed trials |
| Mean attempts | average attempts a trial's step took to settle |
| Over-budget outputs | artifacts produced over their word budget, summed |
| Tokens / Cost / Time | mean and total over completed trials; "not reported" when the runtime never said, never read as zero |

**Difference** is candidate minus baseline for each measure, coloured by
whether that direction is the better one (up for pass rates, down for
attempts, tokens, cost, time and over-budget outputs) — "no change" when it's
exactly zero, "—" when either side has nothing to compare. With fewer than 3
repeats the scorecard carries "few repeats, differences may be noise". None
of this says which variant "won" — it hands you the numbers and leaves the
call to you.

A trial's gate reads the same facts a real mission's would, which has one
sharp edge: a gate that only checks that an artifact of some type exists
can't tell your step's own output from a case input of that same type
already sitting there before the step ran. If a case's gate is a bare
existence check and its input already provides that type, the trial can pass
without the step doing anything. Write — or check — a case's gate with that
in mind.

## Cost, and the cap

Every run needs its own spend cap; there is no shared or default cap the
daemon applies for you. A run stops itself once its finished trials have
spent the cap, with the reason "Stopped at your $5.00 cap" (the cap you set,
formatted like the Limits screen) — the trials that already finished still
make a scorecard. If any finished trial in the run reports no cost at all,
the run's spend is unknown rather than treated as zero, exactly as with a
[mission or monthly limit](limits.md): an unknown cost can never satisfy a
cap, so the cap can't stop that run, and it says so: "This runtime doesn't
report cost, so your cap can't stop this run."

Eval spend is real spend. It counts toward the project's monthly total the
same as any other run, and once any has accrued this month, **Repositories →
Limits** shows it broken out as "of which evals" beside the month's cost.
Trying a candidate is not free, and it is not kept apart from what the same
work would have cost for real.

## What this does not do

- **No judge.** Every number on a scorecard is measured, not scored by
  opinion — nothing here reads a transcript and says "good" or "bad".
- **No CI runner.** A trial replays one saved step, once per repeat, side by
  side with today's setup — it is not a build or test pipeline.
- **No runtime comparison.** A candidate changes a model, a skill version or
  a whole setup for the roles a suite uses, never which agent runtime a role
  is routed to.
- **No auto-apply.** "Try on evals" — from a role's skill on the Skills
  screen, or from a setup preview on Setup as code — only seeds a run with
  that model, skill or folder; nothing it finds is ever written back to your
  project. On Skills, it only helps once you've imported the skill's update:
  a role keeps pinning its old version until you move it yourself, so
  comparing needs the newer version already sitting in your library.
- **No planning, refinement or intake cases.** Only a finished, gated agent
  step can be saved.
- **No sharing across projects.** Suites, cases, runs and their scorecards
  all live in one workspace.

## Not yet

- Only one eval run per project at a time, and its trials run one at a time
  within it.
- A daemon restart fails whatever run was going — "The daemon stopped during
  this run." — and cleans up the trial's worktree, but the run itself is not
  resumed; start it again.
- Scores began recording with this update; there is no history before it to
  draw "From your runs" from.
