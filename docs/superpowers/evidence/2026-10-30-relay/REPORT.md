# Relay acceptance report

Run: 2026-10-31T00:32:18.203Z · build 33a00cd · fresh installs at /tmp/tdm-relay-run-mvvo1znz
Result: **ALL PASS** (1/1 scenarios)

| Scenario | Result | Checks |
|---|---|---|
| R1 — Solo: who is working on what, and a held item is refused | PASS | 9/9 |

## R1 — Solo: who is working on what, and a held item is refused

- ✅ approving the plan starts the issue-linked mission
- ✅ Home: "Who's working on what" has a row for acme/app#7 — `"Who's working on what\nYou\nacme/app#7\nFix the hello page header\nsince 19:32"`
- ✅ …and it is yours — `"Who's working on what\nYou\nacme/app#7\nFix the hello page header\nsince 19:32"`
- ✅ a second mission on the same issue is refused in a dialog — `"Someone is working on this\n\nYou're already working on this on demogar-ubuntu.\n\nNot now"`
- ✅ …in plain words: "You're already working on this on demogar-ubuntu." — `"Someone is working on this\n\nYou're already working on this on demogar-ubuntu.\n\nNot now"`
- ✅ …with Not now and no Take over (it is yours) — `["Not now"]`
- ✅ the second mission did not start; its plan still waits — `"AWAITING_PLAN_APPROVAL"`
- ✅ finishing the first mission clears its row within 2 s — `"Who's working on what\n\nNobody is working on a tracker item right now."`
- ✅ …and Home says nobody is working on a tracker item — `"Who's working on what\n\nNobody is working on a tracker item right now."`
- screenshot: [R1-home-row.png](R1-home-row.png)
- screenshot: [R1-refused.png](R1-refused.png)
- screenshot: [R1-home-empty.png](R1-home-empty.png)
