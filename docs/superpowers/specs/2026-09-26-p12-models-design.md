# P12: Model routing — the right model for each step, a stronger one on retry

Status: design, 2026-09-26. Builds on P8 (hard limits: the warning level) and P9 (retries, `SCRIPTED_FAIL_TIMES`). Base: `main` at v0.5.0.

## Problem

Every run of a runtime profile uses the same model: whatever the profile's `model` setting says, or the runtime's own default. So a one-line release note costs the same model as a hard refactor, a step that keeps failing retries on the model that just failed it, a project close to its monthly limit keeps spending at full price, and a review can be written by the very model that wrote the code it reviews. Nothing records which model a run used, so none of this can even be seen afterwards.

## Goal

I choose models per role and per workflow step, and Tandemise applies them the same way every time and tells me what it used and why.

- A **step** in a workflow file can name a `model:`; a **role** can name a model in Team → Roles; the **runtime profile's** model is the fallback. Step beats role beats profile.
- A step or role can name an **escalation ladder** (`escalate: [a, b]`): attempt 2 uses `a`, attempt 3 (and later) uses `b`.
- A role can name an **economy model**: once the mission's or the project's monthly limit is past its warning level (P8), new runs of that role use it.
- A review step can say **`independentOf: <step>`**: its gate then also needs `review.independent`, which is true only when the reviewing run's runtime or model differs from the reviewed run's.
- Every run records **`model`** and **`modelReason`** ("step override", "retry escalation (attempt 2)", "economy: 85% of limit"). The step drawer shows "Model: opus · retry escalation (attempt 2)"; the mission's Metrics show usage by model.

Model names are **plain strings the person types** ("sonnet", "opus", "gpt-5-codex", a full model id). Tandemise never ships a list of models; the fields only carry placeholder hints.

## Not in P12

- Choosing models for planning and refinement (they have no Run row; they keep the profile's model).
- Cost tables per model, automatic "cheapest model that passes" search, or switching runtimes on retry.
- Picking a different model automatically to make a review independent (the gate reports; escalation or a setting change fixes it).
- A model list fetched from a vendor.

## 1. Resolution (pure, in `@tandemise/domain`)

`resolveModel(context) → { model: string | null, reason: string, source }`, one pure function holding the whole precedence. Its input:

| Field | Meaning |
|---|---|
| `step` | the step's `{ model?, escalate? }` (from the workflow file), or null |
| `role` | the role's `{ model, escalate, economyModel }`, or null |
| `profileModel` | the runtime profile's `model` setting, or null |
| `attempt` | the attempt this run belongs to (1 = first) |
| `pressure` | `{ percent, scope: 'mission' \| 'month' }` when a limit is at or past its warning level, else null |
| `runtimeTakesModel` | whether the chosen runtime can be given a model at all |

The rules, first match wins:

| # | When | Model | Reason |
|---|---|---|---|
| R1 | the runtime cannot be given a model | none | `runtime default` |
| R2 | attempt ≥ 2 and a ladder exists (the step's, else the role's) | `ladder[min(attempt − 2, last)]` | `retry escalation (attempt N)` |
| R3 | pressure is set and the role has an economy model | the economy model | `economy: 85% of limit` / `economy: 85% of monthly limit` |
| R4 | the step names a model | step model | `step override` |
| R5 | the role names a model | role model | `role model` |
| R6 | the profile names a model | profile model | `runtime profile default` |
| R7 | otherwise | none | `runtime default` |

Percent is rounded down. Blank strings count as "not set". The executor calls it once per run, just before the run row is written, with the attempt the run belongs to; the answer goes on the run row and into the `RunRequest` the adapter receives.

## 2. Runtimes

`RunRequest` gains `model?: string | null` (undefined = old behaviour: the adapter reads its own settings). `AgentRuntimeAdapter` gains `acceptsModel?(profile): boolean`.

| Runtime | Takes a model | How |
|---|---|---|
| Claude Code | yes | `--model <model>` |
| Codex | yes | `<modelFlag> <model>` (default `-m`) |
| Generic CLI | when its settings name a `modelFlag` | `<modelFlag> <model>` after the argument template, before an appended prompt |
| Fake | no | recorded as `runtime default` |

## 3. Review independence

A workflow step may set `independentOf: <step key>`; the key must be a step it depends on, directly or through others (a compile error otherwise). Compiling the workflow appends `&& review.independent` to the step's gate (or makes it the gate when the step has none), so the requirement cannot be forgotten.

Fact `review.independent` (boolean), computed by `GateService.factsFor` only for a task with `independentOf`:

- the reviewing run = this task's newest run; the reviewed run = the newest SUCCEEDED run of the named step in the same mission;
- **true** when their runtimes' adapters differ, or both models are known and differ;
- **false** otherwise — including a model of "runtime default" on the same runtime, because then nobody can show they differ;
- absent (so the gate fails as unmeasured) when either run does not exist.

Pure helper `modelsIndependent(a, b)` in domain.

## 4. Data (migration 017)

Additive:

```sql
ALTER TABLE runs ADD COLUMN model TEXT;             -- null = runtime default
ALTER TABLE runs ADD COLUMN model_reason TEXT;      -- null for runs from before P12
ALTER TABLE role_templates ADD COLUMN models TEXT;  -- JSON {model, escalate[], economyModel} or NULL
ALTER TABLE mission_tasks ADD COLUMN model_policy TEXT; -- JSON {model?, escalate?, independentOf?} or NULL
```

`Run.model`, `Run.modelReason`; `RoleTemplate.models`; `MissionTask.modelPolicy`; `PlannedTask.modelPolicy`. A role's models count as part of its definition: editing them makes the role "edited", so a built-in refresh never overwrites them.

## 5. Workflow YAML

```yaml
steps:
  - key: implement
    role: development
    model: sonnet            # this step always uses it (unless a retry escalates)
    escalate: [opus]         # attempt 2 and later
  - key: review
    role: review
    dependsOn: [implement]
    independentOf: implement # gate also needs review.independent
    gate: artifact.ReviewReport.exists
```

Validation: a model is 1–100 characters without spaces; a ladder has at most 5 entries; `independentOf` must name an upstream step.

## 6. API

- `PUT /v1/roles/:id` accepts `models: { model, escalate, economyModel } | null`; omitted keeps what the role has.
- `Run` in every view carries `model` and `modelReason` (TaskView.latestRun).
- `MissionMetrics.byModel[]`: `{ model (null = runtime default), label, runs, agentMs, tokens (null = not reported), costUsd (null = not reported) }`, most runs first.
- Fact `review.independent` in the vocabulary.

## 7. Desktop

- **Team → Roles** editor, section "Models" (aria-label "Models"): **Model** (placeholder "Runtime default"), **On retry, use** (comma-separated, placeholder "e.g. a stronger model, then the strongest"), **Economy model** (placeholder "Used once a limit passes its warning level"). Hint under the section: "Model names are passed to the runtime as you type them. A workflow step's `model:` wins over these."
- **Step drawer**: chip (aria-label "Model") "Model: opus · retry escalation (attempt 2)"; "Model: runtime default" when none. When the step has a policy, a muted line says it: "This step: model sonnet · retries use opus · must differ from implement".
- **Mission → Metrics**: section "Usage by model" (aria-label "Usage by model"): one row per model — "opus · 2 runs · 6 agent min · 12,400 tokens".

## 8. Words

| Where | Text |
|---|---|
| Step drawer | "Model: sonnet · step override", "Model: opus · retry escalation (attempt 2)", "Model: haiku · economy: 85% of limit", "Model: runtime default" |
| Gate (failed) | the evaluator's own line for `review.independent` (false) |
| Metrics | "Usage by model"; "runtime default" as the name of runs with no model |

## Testing

**Offline:** `scratch/p12-models-check.mjs`, added to OFFLINE_CHECKS, written first and seen failing:

- **table-driven `resolveModel`**: every row R1–R7, precedence between each pair (step vs role vs profile; escalation vs economy vs step), ladder beyond its end, blank strings, month vs mission wording, percent rounding.
- **`modelsIndependent`**: different adapter; same adapter different models; same model; null model on the same adapter.
- **workflow compile**: `model`/`escalate`/`independentOf` reach `PlannedTask.modelPolicy`; the gate gains `review.independent`; an `independentOf` that is not upstream, a model with a space and a 6-rung ladder are refused.
- **adapters**: Claude argv carries `--model` from the request over the profile setting; Codex `-m`; Generic with and without `modelFlag`; `acceptsModel` for each.
- **real daemon** (`startDaemon`, a generic runtime that records its argv): migration 017 columns; a two-step mission records model + reason on each run (step override, role model, profile default); a step that writes nothing once → attempt 2 escalates and its argv has `--model <rung>`; a mission past its warn level runs the economy model; `review.independent` false with the same model, true after the role model changes; metrics `byModel`; `PUT /v1/roles/:id` without `models` keeps them.

**Real app** (`scratch/acceptance/p12/`, CDP 9347, home `/tmp/tdm-p12`, scripted agent with `modelFlag: --model`, argv recorded per run):

| # | Scenario | Must observe in the window |
|---|---|---|
| M1 | Set the Developer role's model to `role-dev` in Team → Roles; run the "P12 models" workflow whose `implement` step says `model: step-model` | the implement drawer reads "Model: step-model · step override" and "This step: model step-model · retries use strong-model"; the review drawer reads "Model: profile-model · runtime profile default"; Metrics "Usage by model" lists both; the agent's argv has `--model step-model` then `--model profile-model` |
| M2 | A mission with `SCRIPTED_FAIL_TIMES=1` on a step with `escalate: [strong-model]` | the first run failed, the drawer reads "Model: strong-model · retry escalation (attempt 2)"; argv of run 2 has `--model strong-model`, run 1 did not |
| M3 | Set the Product Manager role's economy model in the window; a mission with a 20-minute limit warning at 25% whose runs report 6 minutes | step 2's drawer reads "Model: economy-model · economy: N% of limit"; Metrics "Usage by model" lists both models |
| M4 | A review step `independentOf: implement` whose model equals the implement run's | the review step blocks on its gate (`review.independent`); after setting the Reviewer role's model in Team → Roles and clicking Retry it passes and the mission completes |

## Rulings

1. **Escalation beats economy.** A retry exists because the cheaper answer failed; retrying on the economy model repeats the failure and spends the budget twice. The hard limit (P8) still stops everything at 100%.
2. **Economy beats the step and role models.** Past the warning level the person asked to save; a step that must never downgrade can omit the role's economy model or run under a role without one.
3. **Economy is role-only; ladders and models exist on both.** As scoped; a step `economyModel` can be added later without a migration (it is JSON).
4. **Unknown means not independent.** Two runs on the same runtime where either used the runtime's default model cannot be shown to differ, so `review.independent` is false. Deterministic and conservative.
5. **`independentOf` adds `review.independent` to the gate at compile time.** Setting the option and forgetting the gate would give a false sense of independence.
6. **Attempt, not run number.** Escalation reads the task's attempt counter (resumes and tighten passes do not advance it); manual retries keep counting, so a step retried by hand stays escalated.
7. **Runtimes that cannot take a model record "runtime default"**, whatever was asked, so the record never claims a model that was not passed.
8. **No model list.** Fields are free text with placeholder hints only; a name is passed through verbatim (no spaces, ≤ 100 characters).
9. **Planning and refinement are out of scope**: they have no Run row to record a model on; they keep using the profile's model.
10. **Fixed while proving M1:** saving a role never re-read it (the save invalidated `workspaces`, the editor reads `roles`), so the editor kept saying "Unsaved changes" after a successful save. The `workspaces` topic now also refreshes roles.
11. **Generic CLI profiles take `modelFlag` from their settings JSON** (no new form field on the Runtimes screen in P12); the acceptance setup sets it through the API, as P8's setup does for `outputFormat`.
