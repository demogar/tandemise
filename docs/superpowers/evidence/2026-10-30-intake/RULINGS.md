# Intake build rulings

Decisions the builder made where the plan (`docs/superpowers/plans/2026-10-30-intake.md`)
was ambiguous or wrong, decided against the spec
(`docs/superpowers/specs/2026-10-30-intake-design.md`, which is binding).

- Ruling 1 (migration number, Task 2): the plan fixes migration 024 and says to stop
  unless 022 (hold-and-interact) and 023 (brain) are on `main`. Neither exists on any
  branch yet, and `assertOrdered` requires a contiguous list, so 024 cannot run without
  a placeholder, which the plan forbids. The spec allows "`022_intake.ts` or the next
  free number", so intake takes the next free number on its base: **022**
  (`022_intake.ts`). The migration depends on nothing from 022 or 023. At integration,
  whichever of #50, #51 and #52 merges later renumbers to the next free number. That is
  a file rename plus the `version` field, and no shipped database has the number yet.
  Checks read the expected version from the migration list instead of hard-coding 24.
- Ruling 2 (push body, Task 1): the plan's `intakePushBody = z.union([intakeSignalV1Raw, batch])`
  with `intakeSignalV1Raw` as the full signal schema would answer a single bad signal with
  a 400 union error, yet Task 3 records an invalid signal as `rejected` (202). So
  `intakeSignalV1Raw` is the envelope `{ schema: string }` with passthrough: the body only
  tells one signal from a batch, and every signal, single or batched, is then checked on
  its own by `validateIntakeSignal(input)`. That helper never throws and returns either
  the parsed signal or `{ reason, issues, fingerprint, title }` (issues in the router's
  `formatZodIssues` style, fingerprint and title kept when they could be read), which is
  what Task 3 needs to record the rejection. `pushedSignals(body)` lists the signals of
  either form.
- Ruling 3 (size limits stay on the shape, Task 1): the 1 MB per attachment and 5 MB per
  signal limits are refinements on the `attachments` field, not on the signal object, so
  `intakeSignalV1` stays a strict `ZodObject` with a `.shape` (the check compares it with
  the JSON Schema's properties). The JSON Schema says the per-signal total in its
  description, since JSON Schema cannot sum.
- Ruling 4 (config files, Task 1): the plan leaves these to the builder, decided from the
  spec: every config object is strict (a typo in a brain file is refused, not ignored);
  `tracker.url` follows the same rule as a source's `api` (https, or http on loopback
  only, for fakes and self-hosted); a youtrack tracker needs `url` and `project`, a
  github-issues tracker needs `repo`; `onComplete: in_review` needs a mapped `in_review`
  (spec §6.2); source ids are unique; `similarity.ask` must not exceed `similarity.link`.
  `occurredAt`, `impact.firstSeen` and `impact.lastSeen` are ISO 8601 with an offset, so
  `mergeImpact` can compare them as strings.
- Ruling 5 (views, Task 1): `IntakeSignalView` and `IntakeSourceView` have no fields in
  the plan. Task 1 gives them the fields the Intake tab and Settings need (Task 14) from
  the Task 2 table columns; later tasks may add fields, additively.
- Ruling 6 (the store's edge cases, Task 2): decided from the spec's "idempotent by key"
  and "a person's change wins":
  - `upsertSignal` takes `IntakeSignalInput`, a domain mirror of `IntakeSignalV1`
    (domain and persistence cannot import `api-contract`). `api-contract` asserts at
    compile time that a parsed signal is assignable to it.
  - `recordRejected` on a fingerprint already in the pipeline returns that signal
    unchanged: a bad repeat never undoes a good signal. A later valid push of a
    `rejected` fingerprint resets it to `received` with `firstTime: true`, keeping its
    occurrences. A rejected row stores `''` for the instance, key and url it could not
    read, and the kind from the fingerprint's prefix when that is a valid slug.
  - `intake_links.item_ref` is nullable: a pending link for a create has no ref until
    the tracker answers (`completeLink` sets it). `createdToday` counts pending creates
    too, so the cap holds across a crash.
  - `TrackerItem`, `TrackedItem`, `TrackerRef` (branded) and the comment markers live in
    `packages/domain/src/entities/tracker.ts` now, so Task 4 extends that file instead
    of moving them. `TrackerItem.createdAt` is stored as `upstream_created_at`.
  - `intake_attachments` also has `created_at`/`updated_at` ("every table unless noted").
  - The mailbox keeps acked rows (`done_at`) and has no stale-claim sweep yet; a claim
    left by a crash stays claimed until whoever owns the listener (Task 11) releases it.
