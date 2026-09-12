# ADR 0004 — Progression depends on measured facts, not on agent assertions

**Status:** accepted

## Context

"The developer says it is done" is the least reliable signal in the system, and
the most tempting one to use, because it is always available.

## Decision

Task completion is governed by a small boolean expression over facts Tandemise
*measured*: `checks.typecheck == PASS && review.blocking_findings == 0`. The
gate language is deliberately not arbitrary code — it must be renderable in the
UI, explainable when it fails, and impossible for an agent to satisfy by
claiming success.

A fact that was never measured resolves to `undefined` and compares false
against everything. A missing measurement never silently passes a gate.

When a gate fails, its `detail` names each unmet conjunct with the value that
was actually measured, and that string is fed verbatim into the next attempt's
prompt. This is the highest-value feedback loop in the system: the worker is told
precisely which condition it failed rather than being asked to try harder.

## Consequences

- Evaluation is a four-level hierarchy: deterministic checks, then rule-based
  artifact/criteria checks, then an independent evaluator role, then a human.
- The repository must expose real commands (typecheck, test, build). Where it
  does not, the relevant fact is `SKIP` and gates are written `!= FAIL` rather
  than `== PASS`, so a repository without tests is not permanently blocked.
- Some quality dimensions are genuinely not measurable and remain the evaluator
  role's and the human's judgement. The gate model does not pretend otherwise.
