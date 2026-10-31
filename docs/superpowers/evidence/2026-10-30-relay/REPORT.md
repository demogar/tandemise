# Relay acceptance report

Run: 2026-10-31T01:30:15.599Z · build 4f422f5 · fresh installs at /tmp/tdm-relay-run-mvvq3kit and /tmp/tdm-relay-b-run-mvvq3l3t
Result: **ALL PASS** (6/6 scenarios)

| Scenario | Result | Checks |
|---|---|---|
| R1 — Solo: who is working on what, and a held item is refused | PASS | 9/9 |
| R2 — Connect window A to the relay and bring its local data | PASS | 7/7 |
| R3 — Invite someone from the Team screen; window B joins | PASS | 4/4 |
| R4 — A's claim shows in B live, and B is refused the same item | PASS | 4/4 |
| R5 — A stale claim is taken over; the holder sees Unclaimed and keeps working | PASS | 7/7 |
| R6 — The relay goes away and comes back; window A follows | PASS | 4/4 |

## R1 — Solo: who is working on what, and a held item is refused

- ✅ approving the plan starts the issue-linked mission
- ✅ Home: "Who's working on what" has a row for acme/app#7 — `"Who's working on what\nYou\nacme/app#7\nFix the hello page header\nsince 20:29"`
- ✅ …and it is yours — `"Who's working on what\nYou\nacme/app#7\nFix the hello page header\nsince 20:29"`
- ✅ a second mission on the same issue is refused in a dialog — `"Someone is working on this\n\nYou're already working on this on demogar-ubuntu.\n\nNot now"`
- ✅ …in plain words: "You're already working on this on demogar-ubuntu." — `"Someone is working on this\n\nYou're already working on this on demogar-ubuntu.\n\nNot now"`
- ✅ …with Not now and no Take over (it is yours) — `["Not now"]`
- ✅ the second mission did not start; its plan still waits — `"AWAITING_PLAN_APPROVAL"`
- ✅ finishing the first mission clears its row within 2 s — `"Who's working on what\n\nNobody is working on a tracker item right now."`
- ✅ …and Home says nobody is working on a tracker item — `"Who's working on what\n\nNobody is working on a tracker item right now."`
- screenshot: [R1-home-row.png](R1-home-row.png)
- screenshot: [R1-refused.png](R1-refused.png)
- screenshot: [R1-home-empty.png](R1-home-empty.png)

## R2 — Connect window A to the relay and bring its local data

- ✅ Settings → Team relay starts local — `"local"`
- ✅ …"Only this computer knows what you're working on." — `"Team relay\n\nOnly this computer knows what you're working on.\n\nA team relay tells everyone's Tandemise who is working on which tracker item, and holds webhooks for you to pick up. Your work stays on this computer.\n\`
- ✅ after the address and the code it is connected — `"Team relay\n\nConnected to 127.0.0.1:42007\n· Acceptance team\n\nThis relay is new. Bring what this computer knows: what you're working on, your webhook addresses and unread webhooks.\nBring my local data\nDisconnect\nD`
- ✅ …"Connected to 127.0.0.1:42007" with the team name — `"Team relay\n\nConnected to 127.0.0.1:42007\n· Acceptance team\n\nThis relay is new. Bring what this computer knows: what you're working on, your webhook addresses and unread webhooks.\nBring my local data\nDisconnect\nD`
- ✅ …offering "Bring my local data" — `"Team relay\n\nConnected to 127.0.0.1:42007\n· Acceptance team\n\nThis relay is new. Bring what this computer knows: what you're working on, your webhook addresses and unread webhooks.\nBring my local data\nDisconnect\nD`
- ✅ the relay now holds acme/app#7 for Ana — `[{"id":"cc_7f97c510-30df-4ec7-888c-862be60a3ba8","projectKey":"github.com/acme/app","itemRef":"github:acme/app#7","itemTitle":"Fix the hello page header","itemUrl":"https://github.com/acme/app/issues/7","memberId":"cm_cb`
- ✅ Home still says you are on acme/app#7, now through the relay — `"Who's working on what\nYou\nacme/app#7\nFix the hello page header\nsince 20:29"`
- screenshot: [R2-local.png](R2-local.png)
- screenshot: [R2-connected.png](R2-connected.png)

## R3 — Invite someone from the Team screen; window B joins

- ✅ Invite someone shows a code — `"TRI-0QP3C-STH5C-95XKC-5MBZJ-V3PVE7"`
- ✅ …that "works once and expires on" a date, shown only now — `"TRI-0QP3C-STH5C-95XKC-5MBZJ-V3PVE7\n\nThis code works once and expires on Nov 6, 2026, 8:29 PM. It is shown only now.\n\nCopy\nDone"`
- ✅ window B connects with it
- ✅ B's Team screen lists Ana, online — `"online"`
- screenshot: [R3-invite.png](R3-invite.png)
- screenshot: [R3-b-connected.png](R3-b-connected.png)
- screenshot: [R3-b-team.png](R3-b-team.png)

## R4 — A's claim shows in B live, and B is refused the same item

- ✅ B's Home shows Ana on acme/app#11 within 2 s — `{"row":"Who's working on what\nAna\nacme/app#11\nOffline mode for the hello page\nsince 20:29","ms":3}`
- ✅ B is refused: "Ana is working on acme/app#11 since …" — `"Someone is working on this\n\nAna is working on acme/app#11 since 20:29.\n\nNot now"`
- ✅ …with Not now and no Take over — `["Not now"]`
- ✅ B's mission did not start — `"AWAITING_PLAN_APPROVAL"`
- screenshot: [R4-b-home.png](R4-b-home.png)
- screenshot: [R4-b-refused.png](R4-b-refused.png)

## R5 — A stale claim is taken over; the holder sees Unclaimed and keeps working

- note: relay clock now 2026-11-01T02:30:05.826Z
- ✅ after 25 h away, B is offered Take over — `{"dialog":"Someone is working on this\n\nAna is working on acme/app#11 since 20:29.\n\nNot now\nTake over","buttons":["Not now","Take over"]}`
- ✅ B's mission starts once B holds the item
- ✅ A's mission shows Unclaimed: "Bruno took over acme/app#11." — `"Unclaimed. Bruno took over acme/app#11. This mission keeps running until you decide.\nStop\nTake it back\nKeep going without a claim"`
- ✅ …with Stop, Take it back and Keep going without a claim — `["Stop","Take it back","Keep going without a claim"]`
- ✅ …and A's mission is still running — `"EXECUTING"`
- ✅ Keep going without a claim hides the banner
- ✅ …and the mission is untouched
- screenshot: [R5-b-take-over.png](R5-b-take-over.png)
- screenshot: [R5-a-unclaimed.png](R5-a-unclaimed.png)
- screenshot: [R5-a-kept-going.png](R5-a-kept-going.png)

## R6 — The relay goes away and comes back; window A follows

- ✅ connected before — `"Team relay\n\nConnected to 127.0.0.1:42007\n· Acceptance team\n\nDisconnect\nDisconnecting keeps what you're working on, on this computer.\nWebhooks\n\nNo webhook addresses yet.\n\nWebhook name\nSource\nHandshake\nNo ha`
- ✅ with the relay stopped, Settings says offline — `"Team relay\n\nOffline since Oct 30, 2026, 8:30 PM\n\nYour work carries on. The team hears from you again when the relay is back.\n\nDisconnect\nDisconnecting keeps what you're working on, on this computer.\nWebhooks\n\n`
- ✅ …"Offline since …" — `"Team relay\n\nOffline since Oct 30, 2026, 8:30 PM\n\nYour work carries on. The team hears from you again when the relay is back.\n\nDisconnect\nDisconnecting keeps what you're working on, on this computer.\nWebhooks\n\n`
- ✅ after it is back, A reconnects by itself — `"Team relay\n\nConnected to 127.0.0.1:42007\n· Acceptance team\n\nDisconnect\nDisconnecting keeps what you're working on, on this computer.\nWebhooks\n\nNo webhook addresses yet.\n\nWebhook name\nSource\nHandshake\nNo ha`
- screenshot: [R6-offline.png](R6-offline.png)
- screenshot: [R6-reconnected.png](R6-reconnected.png)
