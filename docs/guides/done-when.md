# Done when: say what finished means, and see it verified

Every mission carries a short list of lines that say what "done" means. Tandemise
numbers them, makes the spec cover each one, makes QA verify each one by name,
and will not let the release step pass while any of them is unverified. You see
the whole chain as a checklist at the top of the mission.

![A mission's "Done when" checklist: two of your lines, three spec criteria, one verified](../../apps/desktop/screenshots/22-mission-done-when.png)

## How do I write the Done-when lines?

On **New mission**, fill in **Done when (one per line)**. Each line becomes a
numbered criterion: the first is `U1`, the second `U2`, and so on.

Write things you could check yourself by looking at the result:

- Good: "Any report can be downloaded as a CSV file"
- Good: "The CSV opens in a spreadsheet with one row per task"
- Not a criterion: "Exports are better"

If you do not know yet what done means, leave the field empty. The button then
reads **Create and refine** and a product agent proposes lines for you (see
[Refine a rough request](refine.md)).

## What happens to my lines?

1. **The spec covers them.** The spec step writes its own acceptance criteria
   (`AC1`, `AC2`, …) and each one says which of your lines it covers. If the
   spec leaves one of your lines uncovered, its step fails with, for example,
   `Not met: criteria.uncovered_user is 1, needs 0`, and the retry is told which
   line is missing.
2. **QA verifies them by id.** QA reports one result per criterion (`PASS`,
   `FAIL` or `SKIP`). A report that names an id the mission does not have is
   refused.
3. **The release step checks the count.** The built-in release gate needs
   `qa.criteria_unverified == 0`: nothing ships while a criterion is failed,
   skipped, never reported, or not covered.

A result only counts for the spec it was reported against. If the spec is
rewritten after QA ran, its criteria read **Not verified** until QA runs again.

## How do I read the checklist?

Open the mission. **Done when** sits at the top of the **Feed** tab, with
"N of M verified" next to the heading. Each row shows the id, the statement,
what traces it ("Covered by AC1", "Covers U1, U2"), QA's evidence, and a status:

| Status | Meaning |
|---|---|
| **Verified** | QA passed it |
| **Failed** | QA failed it; the QA step fails too |
| **Not verified** | no pass yet: QA skipped it, has not run, or ran before the spec changed |
| **Not covered** | none of the spec's criteria covers this line of yours |

Your own line takes the combined result of the spec criteria that cover it:
all passed is Verified, any failure is Failed.

A row QA reported on opens the QA report; a spec row QA has not reached opens
the spec.

The same count appears on each row of **Missions** ("1 of 3 verified") and,
summed over the missions in progress, on the **Criteria verified** card on Home
(see [The desk and the status report](desk-and-status-report.md)).

## What counts towards "N of M"?

Every live spec criterion, plus every one of your lines that nothing in the spec
covers. Before a spec exists, that is just your lines. So a spec that silently
drops a line does not make the mission look finished: the line still counts,
and it stays unverified until something covers it and QA passes it.

## Can I use this in my own workflow?

Yes. The facts behind the checklist can be used in any step's gate in a
[workflow file](../WORKFLOWS.md#gate-facts):

```yaml
  - key: qa
    role: qa
    outputs: [QAReport]
    gate: artifact.QAReport.exists && qa.criteria_failed == 0
  - key: release
    role: release
    outputs: [ReleaseCandidate]
    gate: artifact.ReleaseCandidate.exists && qa.criteria_unverified == 0 && qa.blocking_defects == 0
```

A mission with no Done-when lines and no spec has an empty checklist, and its
QA facts keep their older meaning. Every mission planned from the window has at
least one line, because planning needs one (see [Refine](refine.md)).
