I've completed the review. Here is my report.

---

# Code Review: "you + your agents" + P3 outside-contributions docs/scripts

**Verdict: REQUEST CHANGES** — builds clean and the core removal is type-safe, but two should-fix issues remain: a blank-dropdown UI regression for stored `person`/`pool` staffing, and a direct spec↔plan contradiction over migrations.

Build/test gates I ran (all pass): `npm run typecheck` in `apps/desktop`, `npx tsc -b tsconfig.build.json` from root, `npm run check:boundaries`, `npm run check:design`.

---

## P1 — should-fix

### 1. Stored `person`/`pool` presets render an empty `<select>`
`apps/desktop/src/renderer/src/screens/team/Team.tsx:243-267`, `apps/desktop/src/renderer/src/screens/team/StaffingEditor.tsx:82-121`

The picker now offers only `STAFFING_PRESET_OPTIONS` (person/pool filtered out), but the controlled select's `value` is still derived from the *stored* staffing:

- `Team.tsx:250` → `value={recognised}` where `recognised = presetOf(...).preset` can still be `'person'` or `'pool'`.
- `StaffingEditor.tsx:119` → `value={preset}` where `preset` can resolve to `'person'`/`'pool'` (via `recognised.preset` or the `pending`/`startPreset` path).

When a role has a persisted `person`/`pool` staffing (P0 shipped "people + staffing", so this is legitimate existing data), React sets `select.value = 'person'` with no matching `<option value="person">`, which yields `selectedIndex === -1`: the dropdown renders **blank**. The summary text still says "Ana does it", but the picker looks broken, and any interaction silently overwrites the stored staffing.

This contradicts the explicit promise in `lib/staffing.ts:18-19` that stored staffing "keeps round-tripping."

**Fix:** give the dropdown a display value that always exists in the options. E.g. in `Team.tsx` compute `const shown = STAFFING_PRESET_OPTIONS.includes(recognised) ? recognised : 'custom'` and bind the select to `shown`; in `StaffingEditor`, separate the *field-rendering* preset (`person`/`pool`/agent/custom) from the *dropdown* value, mapping hidden presets to `'custom'`. Alternatively, keep person/pool `<option>`s in the list but `disabled` so legacy rows still show their true value while remaining unselectable.

### 2. Spec and plan contradict each other on "migration 011"
- `docs/superpowers/specs/2026-09-16-p3-outside-contributions-design.md:208, 229, 251` say P3 introduces **migration 011** (and §8 tests "migration 011 over a P2 database").
- `docs/superpowers/plans/2026-09-16-p3-outside-contributions.md:11, 21, 250` say **"No new migration"** (Ruling 1) and explicitly instruct the implementer that a new migration is "a finding to escalate, not a migration to invent."

The plan tells the reader to "Read [the spec] first," so an implementer will hit three "migration 011" references and then a hard "no migration" ruling. I spot-checked the persistence layer and the plan is correct on the facts: `feedback.attachments` is migration `010`, `artifacts`/`artifact_links` already exist, and migrations currently end at `010`. The spec's "migration 011" wording (which itself hedges with "no table change … schema-level") must be reconciled — reword §5/§7/§8 to "no migration; schema-level `path` on the existing `handoff` JSON," or have the plan note it is overriding those spec lines.

---

## P2 — nits

### 3. Dead daemon client methods after removing the add-person flow
`apps/desktop/src/renderer/src/lib/daemon.ts:278, 282, 291` — `listPeople()`, `createPerson()`, `removePerson()` are no longer called anywhere in the renderer (only `updatePerson` remains, used by the person-edit path at `MemberForm.tsx:78`). They're exported, so `noUnusedLocals` won't catch them. Leave them if the daemon routes stay, but they're now dead surface on the renderer client; consider dropping `listPeople`/`createPerson`/`removePerson` or a comment marking them reserved.

### 4. Vacuous assertion in the P3 baseline script
`scratch/p3-baseline-check.mjs:122` — `ok('UI reports the daemon as connected', true)` always passes; the preceding `waitForText('Daemon connected')` result is discarded and never asserted. `team-ui-check.mjs` does this correctly (`body.includes('Daemon connected')`). Change to assert on the returned body.

### 5. Noise files committed to `scratch/p3-research/`
`scratch/p3-research/review-report.md` and all seven `*.err` files are **0 bytes**; `review-prompt.md` is a copy of this review prompt. These add nothing and will be committed as-is. Delete the empty files and (ideally) the prompt copy before merging.

### 6. Plan's `HandoffLink` interface doesn't exist yet
`docs/superpowers/plans/2026-09-16-p3-outside-contributions.md` (Task 1) shows `export interface HandoffLink { … path?: string }` as a *modify* to `entities/artifact.ts`, but today the links are an **inline** type inside `ArtifactHandoff` (`packages/domain/src/entities/artifact.ts:39`); there is no named `HandoffLink`. The plan should say "extract `HandoffLink` from the inline `ArtifactHandoff.links` type," otherwise the implementer will look for a type that isn't there.

### 7. `agentsOnly` flag scope is narrower than its name/description
`apps/desktop/src/renderer/src/lib/flags.ts:11-17` describes the flag as "The team is you + your agents," but `flag('agentsOnly')` is consulted in exactly one place (`lib/staffing.ts:23`) and only hides `person`/`pool` presets. Flipping it to `false` will **not** restore the removed "Add person" button/drawer (those were deleted unconditionally in `Team.tsx`/`MemberForm.tsx`). Worth a one-line comment so nobody assumes the flag fully toggles the feature.

### 8. `evalJs` has no timeout (both scripts)
`scratch/team-ui-check.mjs` / `scratch/p3-baseline-check.mjs` — if the CDP WebSocket drops mid-run, pending `evalJs` promises never resolve and the script hangs past the catch. This matches the existing `desktop-live-check.mjs` pattern, so it's not new, but a small `Promise.race` timeout (or `ws.on('close')` → reject-all) would make failures fail fast.

### 9. File-input assertion is document-global
`scratch/p3-baseline-check.mjs:129` — `document.querySelectorAll('input[type=file]').length` scans the whole document, not the `.page` form. The adjacent controls check is correctly scoped to `.page`. Scope this to the mission form so a future global file input elsewhere doesn't make the baseline flake.

---

## Things I verified as correct (no action)

- **TypeScript/clean build:** desktop `typecheck`, root `tsc -b`, boundaries, and design-system checks all pass; `noUnusedLocals` is on, so the removed `useQuery`/`useDaemon`/`STAFFING_PRESETS` imports were cleaned up correctly.
- **Discriminated union:** `MemberTarget` now correctly narrows to `new-agent | edit`; `MemberForm.tsx:70-89` narrows `target` to the `edit` variant and the person edit branch (`updatePerson` → `updateMember`) is intact and type-safe.
- **No dangling `new-person`/`needsName`/`unseated`/`seated`** anywhere in `apps/`/`packages/` (only in the prompt copy under `scratch/p3-research/`). Remaining `createPerson`/`listPeople`/`personId` references are the daemon/domain/API surface for the still-supported "you" person.
- **Feature flag mechanics:** `STAFFING_PRESET_OPTIONS` is computed once at module load; `flag()` is typed and used correctly; no renderer site still maps over full `STAFFING_PRESETS`.
- **Doc file map / function names:** all 19 file paths in the plan's File map exist; `ExternalRef`, `Evidence`, `AWAITING_EXTERNAL`, `PARKED_TASK_STATUSES`, `downstreamConsumers`, `run_inputs`, `recordedBy`/`authorId`, `preexistingArtifacts`, `PlanValidationContext`, `completeTask`, `deriveHandoff`, `RUNTIME_ACTOR`, `SYSTEM_ACTOR`, `actorFor`, `onBehalfOf` all exist as cited. Migration numbers cited in research (010 for `feedback.attachments`, 001/008/009/010 for `artifacts`) are accurate.
- **Copy:** "You & agents" tab label, count=agents-only, "AI drafts, responsible checks later", and "Add agent" are internally consistent; no stale "Add person"/"person checks later" UI copy remains.

---

## Must fix before merge

1. **Blank `<select>` for stored `person`/`pool` staffing** — add a display-value fallback (or disabled legacy options) in `Team.tsx` and `StaffingEditor.tsx` so legacy staffing still renders in the picker. *(P1)*
2. **Reconcile "migration 011" (spec) vs "no migration" (plan)** — reword the spec's §5/§7/§8 to match the plan's ruling (no migration; `path` is a schema-level change on existing JSON). *(P1)*

Recommended but not blocking: fix the vacuous assertion (`p3-baseline-check.mjs:122`) and delete the 0-byte research files before committing.
