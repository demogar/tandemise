# P16: Reach me when it matters

Status: design, 2026-09-26. Builds on the Inbox as it stands after P6 (refinements), P8 (limit cards), P9 (stalled and quiet rows) and P10 (routes). Base: `main`.

## Problem

A person running their own agents finds out something needs them only by looking at the app.

- **The Inbox is complete but silent.** Every decision, refinement, limit stop, stalled mission and quiet agent reaches the Inbox (P6, P8, P9), and the sidebar badge counts them. None of that reaches a person whose window is hidden behind an editor or closed to the tray. A plan approval can sit for an hour while its agents wait.
- **Checking is the only way to know.** The daemon keeps working when the window is closed, so the one moment the person is not looking is the moment work is most likely to stop on them.

## Goal

When something new needs me and I am not already looking at the Inbox, I get **one** native notification per new Inbox item, never a flood, and clicking it takes me to the decision.

- The **Inbox projection** (`GET /v1/inbox`) is the single source of truth. A notification is only ever about an item that is in the Inbox for me at that moment.
- The set to announce is a **pure diff**: the ids in the Inbox now minus the ids already announced (or deliberately skipped). The ids already announced are persisted, so a restart does not repeat anything and an item that disappears and comes back with the same id is not announced twice.
- Several new items in one pass become **one** notification: "3 things need you".
- Per-kind switches, quiet hours with one summary when they end, and a test button live in **Settings → Notifications**.

## Not in P16

- Notifications to a phone, email or chat. The daemon has no outbound channel yet; this is the desktop only.
- Sounds, badges on the dock icon, or notification actions (buttons inside the notification). A click opens the item; the decision is made in the window, where its evidence is.
- Per-project preferences. Preferences are per install (one person, one machine).
- Reminding about an item that is still waiting after N minutes. An item is announced once.

## 1. What counts, and its id

The daemon maps the Inbox for the local person to notification items. Only items that are **for me** by the rule the Inbox already uses (`@tandemise/api-contract/for-me`) count; a check card (a non-blocking look at finished work) does not.

| Kind (setting) | Inbox source | Id | Title | Opens |
|---|---|---|---|---|
| Decisions and approvals | open approval that waits on me, not a limit card | approval id | "Decision needed" | the mission (`/missions/<id>`), else `/inbox` |
| Decisions and approvals | step parked for me (AWAITING_HUMAN) | task id | "Your step is waiting" | `/missions/<id>` |
| Refinements | draft with proposals or questions to decide (P6) | `refinement:<mission>` | "Decide before planning" | `/missions/<id>` |
| Stalled missions | stalled row (P9) | `stalled:<mission>` | "Mission stalled" | `/inbox/stalled` |
| Quiet agents | silent run (P9) | `quiet:<run>` | "Agent gone quiet" | `/inbox` |
| Limits | limit card (P8: intervention, no step, offers "Raise limit") | approval id | "Limit reached" | the mission, else `/inbox` |

The ids are the ones the desktop Inbox already uses, so "is it in the Inbox" and "was it announced" talk about the same thing. The body is one line from the row, e.g. "Approve the plan · Add CSV export".

## 2. The diff (pure, domain)

`planNotifications(input)` in `packages/domain/src/entities/notifications.ts` takes the current items, the persisted state `{ notified[], held[] }`, the preferences, the local minute of the day and `suppress`, and returns `{ notice | null, state }`. Nothing else decides what is shown.

- `fresh` = current items whose id is in neither `notified` nor `held`.
- A fresh item of a kind that is switched **off** is recorded as notified without a notice. Turning the kind on later does not announce old items.
- **Suppress** (the window is focused and showing the Inbox): every fresh and held item is recorded as notified; no notice. The person is looking at them.
- **Quiet hours** (now is inside `from`–`to`, wrapping midnight, `from == to` means off): fresh enabled items go to `held`; no notice. A held id that leaves the Inbox is dropped from `held`.
- **Otherwise**: the notice covers every held item still in the Inbox plus every fresh enabled item.
  - one item: its own title, body and route;
  - more than one: "N things need you", the first two bodies and "and N more", route `/inbox`;
  - any of them held: the title reads "After quiet hours: N things need you" (or "1 thing needs you") so the person knows why it came late.
- Every announced id moves to `notified`; `held` is cleared. `notified` keeps the last 500 ids, and never forgets an id that is still in the Inbox, so it cannot grow without bound and cannot repeat a live item.

Same state twice gives no notice the second time; an item that leaves and comes back with the same id is still in `notified`, so it is not announced again.

## 3. Where it runs

The desktop is a control surface and the daemon owns state, so the split is:

- **Daemon** (`NotificationService`, `services.notifications`): builds the items from `ProjectionService.inbox(ws)` for every project, runs the pure diff, and persists the preferences and the state in the existing `settings.json` (`SettingsStorePort`, keys `notifications` and `notificationState`). **No migration**: this is a handful of preferences and at most 500 ids, the same reason the settings store is a file.
- **Desktop main process** (`apps/desktop/src/main/notifier.ts`): every 5 s while the daemon is connected it calls `POST /v1/notifications/take { suppress }`, where `suppress` is "the window is visible, focused and its route is `/inbox`" (read from the window's URL hash; the renderer does not have to report anything). It shows each returned notice with Electron `Notification`. The main process keeps polling while the window is hidden or closed to the tray, so notifications work in the background.
- **Click**: shows and focuses the window, then sends the route (and the project, when all items share one) to the renderer, which switches project if needed and navigates.

`take` both computes and records, in one call: a notice is never announced twice even if the desktop crashes between two polls, at the cost of possibly missing one if it crashes after `take` answered and before the notice was shown.

## 4. API

- `GET /v1/notifications/preferences` → `NotificationPreferencesView { kinds: {decisions, refinements, stalled, quiet, limits}, quietHours: {from, to} | null, quietNow }`.
- `PUT /v1/notifications/preferences` with the same shape (partial `kinds` allowed; `quietHours: null` turns them off; times are `HH:MM`, 400 otherwise).
- `POST /v1/notifications/take { suppress?: boolean }` → `{ notices: NoticeView[] }` (zero or one notice; the array leaves room for per-project notices later).

## 5. Desktop

- **Settings → Notifications** (`screens/settings/Notifications.tsx`, one line in `Settings.tsx`): a section with one `Switch` per kind ("Decisions and approvals", "Refinements", "Stalled missions", "Quiet agents", "Limits"), a "Quiet hours" switch with two time inputs ("From", "To", "Save quiet hours"), and "Send a test notification". Copy says what happens: "Held during these hours and summarised once they end."
- **Test notification** goes through IPC to the main process ("Notifications are on" / "This is how Tandemise will tell you something needs you."). It does not touch the daemon's state.
- **Test hook**: with `TANDEMISE_NOTIFY_RECORD=<file>` the main process appends every notice it shows (and every test notice) as a JSON line to that file, and enables `window.tandemise.notificationsDebug(op)` for the acceptance suite: `list`, `click <n>` (runs the same click handler), `hide`, `focus true|false|clear` (overrides "is the window focused", since a CDP-driven window may not have OS focus), `pause`/`resume` and `poll`. Without the variable the debug call rejects. `TANDEMISE_NOTIFY_POLL_MS` changes the poll interval.

## Testing

**Offline** `scratch/p16-notify-check.mjs` (in OFFLINE_CHECKS):

- pure diff: same state gives nothing; disappear and reappear with the same id gives nothing; three new in one pass give one "3 things need you" to `/inbox`; one new item gives its own route; disabled kinds are recorded silently and not announced later; suppress records without a notice; quiet hours hold, wrap midnight, drop items that left, and summarise once when they end; the 500-id memory keeps live ids.
- preferences normalisation (bad times, unknown kinds, `from == to`).
- a real daemon (`startDaemon`, test clock): preferences round-trip in `settings.json`; an approval in the Inbox is announced once by `take`, not again after a daemon restart; a stalled mission and a refinement map to their kinds and routes; quiet hours move with `POST /v1/test/clock`.

**Real app** `scratch/acceptance/p16` (CDP 9351, `/tmp/tdm-p16`, `TANDEMISE_NOTIFY_RECORD`, poll 1 s):

| # | Scenario | Must observe in the window |
|---|---|---|
| R1 | One new decision while the window is hidden | Exactly one notice "Decision needed" naming the mission; nothing more on later polls; clicking it shows the window on the mission with the card; on the Inbox and focused, a second new decision records no notice, and leaving the Inbox does not announce it late |
| R2 | Several at once, and a kind switched off | Three new decisions in one pass give one notice "3 things need you"; its click opens the Inbox; with "Stalled missions" off in Settings a stalled mission gives no notice |
| R3 | Quiet hours and the test button | Quiet hours set in Settings covering now: a new decision gives nothing; after the (test) clock passes their end, one "After quiet hours: 1 thing needs you"; "Send a test notification" records "Notifications are on" |

## Rulings

1. **Diff in the daemon, delivery in the main process.** The state is the daemon's (it owns the Inbox and the settings file); the main process only asks "anything new?" and shows it. The renderer is not involved, so hidden and closed windows still notify.
2. **No migration.** Preferences and the announced-id memory live in `settings.json` (`notifications`, `notificationState`).
3. **Suppress = visible, focused, route `/inbox` or `/inbox/stalled`.** Items announced that way are recorded as seen; leaving the Inbox never announces them late.
4. **A switched-off kind is recorded as seen**, so turning it on is quiet about the past.
5. **Upgrade and first run are not special.** Whatever is already in the Inbox the first time becomes one coalesced notice, which is a fair "here is what is waiting".
6. **Only "for me" items, never check cards.** Same rule as the Inbox and Home's "Needs you now".
7. **One notice per poll**, across projects. When the items span projects the click opens the Inbox of the current project.
8. **Refinement ids are per mission.** A second refinement pass on the same draft is not announced again; the Inbox row is still there.
