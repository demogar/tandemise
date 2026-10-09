# A quick change verifies what done means: evidence

The same request run twice through the desktop window, on a fresh install
with Claude Code 2.1.295:

> Add a --top N option to the tally CLI so it prints only the N most frequent words.

with three Done-when lines (U1 the output, U2 the tie order, U3 the tests).

## Before

`before-complete-0-of-3.png`: the plan was implement → review. The mission
reached **Complete** at **0 of 3 verified**, and every line still read "The
spec will cover this", though Quick change has no spec step. Planning
requires Done-when lines, but only a QAReport verifies one, and this workflow
had no QA step.

## After

- `after-plan-implement-review-verify.png`: the plan is now implement →
  review → verify.
- `after-complete-3-of-3.png`: **3 of 3 verified**, each line reading
  "Reported by QA" with QA's evidence. For example, U2: "Ties sorted a→z
  (banana, mango, pear at count 2); 20 runs of full output all had md5 …".
- `after-feed.txt`: the feed as rendered.

This run also carried the fix from the review/QA shell PR, which the verify
step needs in order to run anything on Claude Code.
