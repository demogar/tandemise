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
- Ruling 7 (push scope and refusals, Task 3): decided from spec §1 "Text is data" and §2 "Auth":
  - A push whose signal names a source (`source.kind`, `source.instance`) other than the
    scope's configured source is refused whole, before anything is recorded: with an
    intake token as `PERMISSION_DENIED` "This token can only push to '<id>'." (the plan's
    sentence), with the daemon token as `PERMISSION_DENIED` "Signals for '<id>' must name
    it as their source (<kind>, <instance>)." A token used with `?source=` or `?workspace=`
    naming anything else gets the token sentence. With the daemon token the push must name
    `?workspace=&source=` (400 otherwise); the CLI fills `workspace` itself.
  - Refusal order for a push: project, tracker (409), source (404), source named by a
    signal (403), rate limit (429). The rate limit counts signals and takes a batch all or
    none, so a refused batch uses none of the minute; it is keyed by the token id, and
    daemon-token pushes by `(project, source)`. The window is in memory (a restart forgets
    it).
  - The unreadable-signal fingerprint hashes `JSON.stringify` of the signal as pushed. A
    repeat push adds only attachments not already recorded (same name and blob or url).
  - `INTAKE_BLOBS` defaults to a working in-memory store (`MemoryBlobs`), as the plan says,
    unlike `EVAL_BLOBS`' failing default; the daemon rebinds it to `paths.intakeBlobs`.
  - The router gains a `status` route option so the push answers 202; nothing else changes
    status. `IntakeService.configure` and `ingestMany` take the body unparsed and parse it
    themselves, since the file schemas fill defaults (zod input and output differ).
  - `GET/PUT …/intake/config` answer `IntakeConfigView` (`origin`, `editable`, the config).
    A PUT when the source cannot write (the brain) is `PRECONDITION_FAILED` "This project's
    intake is set in its brain. Change it there." Minting needs a seat and a configured
    source (the 404 sentence). Revoking needs the daemon token only: the token port has no
    lookup by id to find the project's seat.
  - The CLI prints `<fingerprint>: <status>` per result, then the reason, indented, on its
    own line when there is one.
- Ruling 8 (the tracker port and the YouTrack adapter, Task 4): decided from spec §5, §6 and §6.1:
  - The port is spec §6's plus the plan's additions: `comment(ref, { marker, body, knownId? })`,
    `viewer()`, optional `assign?`, and optional `refFromUrl?(url): TrackerRef | null` for
    Task 7's "the source is the tracker" step (spec §5 step 2). `link` takes a `SourceEntry`
    `{ url, title, context }`. `AttachmentRef` is `{ name, mediaType, url?, content? }`: an adapter
    uploads only what has `content`; a URL-only attachment is the caller's to link in the
    description.
  - The sources comment's body is built by pure helpers in `entities/tracker.ts`:
    `sourcesCommentBody(entries)` and `sourcesCommentWith(existing, source)`. Each entry is
    `- <title> · <url>` with its context (at most 6 lines) indented as `  > …`; title and context
    are escaped with `escapeForComment`, so @mentions are broken. A URL already listed has its
    entry replaced in place. `parseSourcesSection` reads the last URL of each `- ` line under
    `## Sources`, in a description or in that comment alike.
  - `stateMappingProblem` checks every named state first (in the order ready, in_progress,
    in_review, done, wont_do), then the in-review rule. The tracker reads as "YouTrack" or
    "GitHub", the place as the project or the repo.
  - `titleTokens` lands now in `entities/similarity.ts`, exactly as Task 6 defines it, because
    the YouTrack text search sends those words; Task 6 adds the scorer to the same file.
  - The YouTrack module contributes its `PRIMARY_TRACKER_FACTORIES` entry now (the plan lists that
    under Task 5), so the new package is not an empty module; Task 5 only adds GitHub's. The
    factory refuses with `PRECONDITION_FAILED` when the URL, project or token is missing.
  - `board({ updatedSince })` filters on the client: the team's board query is sent as written.
    `search({ text })` with no words left after tokenising returns nothing rather than every item.
  - The fake marks an item `Duplicate` (resolved) when it receives `duplicates KEY`, as YouTrack's
    default workflow does.
- Ruling 9 (YouTrack command values, Task 5): a YouTrack command reads a space as the start of
  its next word, so every value the adapter puts in a command (state, type, field values,
  assignee) is braced when it holds a space: `State {In Progress}`, `Subsystem {Web App}`; a
  single word stays bare (`Type Bug`, `Assignee ana`). The fake parses braced values and refuses
  an unbraced multi-word value (`State In Progress`), as YouTrack would misread it. The observable
  result is unchanged: the item's state reads `In Progress`.
- Ruling 10 (GitHub Issues and the resolver, Task 5): decided from spec §6 and §6.2:
  - `GhPrimaryTracker` ignores a draft's `type` and `fields` (GitHub has none; `describe()` reports
    `types: []`, `fields: []`) and its attachments (`capabilities.attachments` is false; the caller
    links them). `stateLabels` are the mapped states but `open`/`closed`, once each, in the
    mapping's order (ready, in_progress, in_review, done, wont_do). `transition` to a state that is
    neither `open`, `closed` nor a mapped label is refused (`VALIDATION`); labels are sent one flag
    each, since `gh` splits a comma-joined value. `search({ url })` asks `gh search issues` for the
    same fields as every read (not only `number,url,title,state`) so it returns whole items;
    `search({ text })` lists `--state open` only with `unresolvedOnly`, `all` otherwise; `board`
    sends the team's query with `--state all` so the query decides. `assign` is
    `gh issue edit --add-assignee`. A missing issue (gh's "Could not resolve to an issue") is
    `NOT_FOUND`. `refFromUrl` matches `https://<host or github.com>/<repo>/issues/<n>`, the repo
    compared case-insensitively. The factory needs `repo` (`PRECONDITION_FAILED` otherwise) and no
    credential: `gh`'s sign-in is it, as in P14.
  - The secret store hands back opaque refs (`<backend>:<name>:<id>` in every daemon backend) and
    intake keeps no table for one ref per project, so `TrackerResolver` finds the credential by
    name among `list()`'s refs (`:intake:<ws>:tracker:`), the last one listed winning.
    `saveCredential(ws, value)` stores a new one, removes the older refs and drops the cached
    tracker. The cache key is the config's JSON plus the credential's sha256.
  - An unknown kind is `PRECONDITION_FAILED` "Tandemise can't use '<kind>' as a tracker yet."
  - `PUT …/intake/config` (now async) checks a tracker it is given with
    `TrackerResolver.problemWith(ws, tracker)` before saving: a mapping naming a state the tracker
    lacks, or an unknown kind, is refused as `PRECONDITION_FAILED` with that sentence and nothing is
    saved. When the tracker cannot be asked yet (no credential saved, unreachable) the config is
    saved unchecked and the reason is logged (`intake.tracker_unchecked`): the credential is saved
    on its own, so a person must be able to set the tracker first. `validate(ws)` checks the saved
    config and throws what the tracker throws.
- Ruling 11 (the noise filter's edges and the scorer, Task 6): the plan's table is pinned row by
  row; where it is silent, decided from spec §4.1 ("a source with no `filter` passes everything",
  reasons "in plain words"):
  - A rule the signal carries no data for (no `impact.level`, `impact.users` or `impact.lastSeen`,
    or a `lastSeen` that does not parse) does not hold it back: the filter holds back only what it
    can show is under the bar. `minEvents` always applies, since events fall back to the
    occurrences Tandemise counted.
  - An `ignoreTitles` substring ignores case. `/re/flags` is a regular expression; one that does
    not compile matches nothing instead of failing the pipeline (the rules are the team's
    configuration, never a signal's text).
  - Reasons: `N events; this source needs M` when the source sets no window (`in 24 h` only with
    one); `1 event` and `1 person affected` in the singular; the window reads `1 h`, `24 h`,
    `7 days`; an age reads in whole days past a day, whole hours past an hour, else minutes.
  - The table's `0.84` is consistent with the formula (tokens `typeerror read id undefined` vs the
    same plus `checkout`: Jaccard 4/5 = 0.8, same error type: 0.8 × 0.8 + 0.2 = 0.84), so neither
    changed. Two titles with no tokens score 0, and an empty signal URL never matches a
    description. `titleTokens` from Task 4 already matched the plan and is unchanged.
  - `IntakeSimilarity.score` takes the signal's `title`, `description` and `url`, and the
    candidate `TrackerItem`; `lexicalSimilarity` reads only the candidate's title and description,
    so it also scores the board cache's `TrackedItem`.
