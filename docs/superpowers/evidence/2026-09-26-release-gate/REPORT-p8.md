# P8 acceptance report

Run: 2026-09-26T14:41:06.596Z · build 7ae5619 · fresh install at /var/folders/dh/glpvvh110393gdzjc_v2x1sr0000gn/T/tdm-p8-run-muihtt56
Result: **ALL PASS** (5/5 scenarios)

| Scenario | Result | Checks |
|---|---|---|
| H1 — A 12-minute limit warns at 80% and stops the mission at 100% | PASS | 11/11 |
| H2 — Keep paused leaves the mission stopped | PASS | 7/7 |
| H3 — Raise the limit to 30 and the mission resumes | PASS | 9/9 |
| H4 — Over 80% of the monthly limit, only urgent and high work is pulled | PASS | 6/6 |
| H5 — A USD limit that cannot be measured says so and never stops work | PASS | 6/6 |

## H1 — A 12-minute limit warns at 80% and stops the mission at 100%

- ✅ proof (API): the mission carries its own 12-minute limit, warning at 80%
- ✅ timeline: "Limit warning: 10 of 12 agent minutes used (83%). Work stops at 12 agent minutes." — `"Tandemise\nAcceptance\n1 repository\nHome\nMissions\nInbox\nArtifacts\nACCEPTANCE\nRepositories\nTeam\nRuntimes\nIntegrations\nAPP\nSettings\nDaemon connected · 51919\nmsn_01m3f2bv3skbmz84v3vq\nMissions\np8-steps\nH1 he`
- ✅ proof (SQL): the warning came after run 2 (soft incident at 10 minutes) — `{"afterTwo":2}`
- ✅ the mission reads "Paused" — `"Tandemise\nAcceptance\n1 repository\nHome\nMissions\nInbox\n1\nArtifacts\nACCEPTANCE\nRepositories\nTeam\nRuntimes\nIntegrations\nAPP\nSettings\nDaemon connected · 51919\nmsn_01m3f2bv3skbmz84v3vq\nMissions\np8-steps\nH1`
- ✅ and says "Limit reached: 15 of 12 agent minutes"
- ✅ the limit card is on the mission page: "Raise limit and resume" / "Keep paused" — `"Tandemise\nAcceptance\n1 repository\nHome\nMissions\nInbox\n1\nArtifacts\nACCEPTANCE\nRepositories\nTeam\nRuntimes\nIntegrations\nAPP\nSettings\nDaemon connected · 51919\nmsn_01m3f2bv3skbmz84v3vq\nMissions\np8-steps\nH1`
- ✅ Metrics → Limit: "15 / 12 agent min" — `"Limit\nSet on this mission\nChange limit\nAgent minutes\n15 / 12 agent min\n\nLimit reached: 15 of 12 agent minutes. Work is paused until the limit is raised.\n\nAgent minutes used\n15\nTokens used\n4,500\nCost\nnot rep`
- ✅ Home: a banner with the numbers — `"Tandemise\nAcceptance\n1 repository\nHome\nMissions\nInbox\n1\nArtifacts\nACCEPTANCE\nRepositories\nTeam\nRuntimes\nIntegrations\nAPP\nSettings\nDaemon connected · 51919\n1 request waiting on you\nAcceptance workspace\n`
- ✅ proof (SQL): one soft and one hard incident, the hard one open — `[["soft","open",12,10],["hard","open",12,15]]`
- ✅ proof (SQL): exactly three runs — `3`
- ✅ proof (SQL): nothing more runs while it is paused
- screenshot: `H1-warning-note.png`
- screenshot: `H1-paused-with-card.png`
- screenshot: `H1-metrics-limit.png`
- screenshot: `H1-home-banner.png`

## H2 — Keep paused leaves the mission stopped

- ✅ still "Paused"
- ✅ and says how to go on: "Kept paused at its limit: 15 of 12 agent minutes. Raise the limit to resume." — `"Tandemise\nAcceptance\n1 repository\nHome\nMissions\nInbox\nArtifacts\nACCEPTANCE\nRepositories\nTeam\nRuntimes\nIntegrations\nAPP\nSettings\nDaemon connected · 51919\nmsn_01m3f2bv3skbmz84v3vq\nMissions\np8-steps\nH1 he`
- ✅ the card is gone from the mission page
- ✅ proof (API): the card was answered "Keep paused" — `{"status":"REJECTED","option":"keep_paused"}`
- ✅ proof (SQL): the hard incident is resolved
- ✅ Resume is refused and says why: "Limit reached: 15 of 12 agent minutes. Raise the limit to resume this mission." — `"Tandemise\nAcceptance\n1 repository\nHome\nMissions\nInbox\nArtifacts\nACCEPTANCE\nRepositories\nTeam\nRuntimes\nIntegrations\nAPP\nSettings\nDaemon connected · 51919\nmsn_01m3f2bv3skbmz84v3vq\nMissions\np8-steps\nH1 he`
- ✅ proof (SQL): no run after "Keep paused" — `{"before":3,"after":3}`
- screenshot: `H2-kept-paused.png`
- screenshot: `H2-resume-refused.png`

## H3 — Raise the limit to 30 and the mission resumes

- note: setup: cancelled 1 mission(s) left by earlier scenarios, limit off
- ✅ the Inbox card: "reached its limit: 15 of 12 agent minutes", with a number to raise to — `"Tandemise\nAcceptance\n1 repository\nHome\nMissions\nInbox\n1\nArtifacts\nACCEPTANCE\nRepositories\nTeam\nRuntimes\nIntegrations\nAPP\nSettings\nDaemon connected · 51919\nInbox\nWhat is waiting on a person.\n“H3 greetin`
- ✅ raising to 14 is refused: "Raise it above 15 agent minutes" — `"Tandemise\nAcceptance\n1 repository\nHome\nMissions\nInbox\n1\nArtifacts\nACCEPTANCE\nRepositories\nTeam\nRuntimes\nIntegrations\nAPP\nSettings\nDaemon connected · 51919\nInbox\nWhat is waiting on a person.\n“H3 greetin`
- ✅ proof (API): still paused after the refusal
- ✅ Metrics → Limit reads against 30: "15 / 30 agent min" — `"Limit\nSet on this mission\nChange limit\nAgent minutes\n15 / 30 agent min\nAgent minutes used\n15\nTokens used\n4,500\nCost\nnot reported"`
- ✅ it is working again (Executing) — `"EXECUTING"`
- ✅ proof (API): the mission now has a 30-minute limit
- ✅ proof (SQL): the incident at 12 is resolved
- ✅ proof (API): resumed exactly once, "Limit raised to 30 agent minutes; resumed." — `["Limit raised to 30 agent minutes; resumed."]`
- ✅ it finishes under the raised limit: "25 / 30 agent min" — `"Limit\nSet on this mission\nAgent minutes\n25 / 30 agent min\n\nOver 80%: work stops at 30 agent minutes.\n\nAgent minutes used\n25\nTokens used\n7,500\nCost\nnot reported"`
- screenshot: `H3-inbox-card.png`
- screenshot: `H3-resumed-15-of-30.png`

## H4 — Over 80% of the monthly limit, only urgent and high work is pulled

- note: this month so far: 40 agent minutes; monthly limit set to 48
- note: teardown: limit off, monthly limit removed
- ✅ Repositories → Limits: "40 / 48 agent min" this month, over 80% — `"Limits\nThis month (September 2026) so far\nAgent minutes this month\n40\nTokens this month\n12,000\nCost this month\nnot reported\nAgent minutes this month\n40 / 48 agent min\n\nOver 80%: work stops at 48 agent minutes`
- ✅ Home: "Monthly limit warning: this project used … this month (85%). Only urgent and high missions are pulled …" — `"Tandemise\nAcceptance\n1 repository\nHome\nMissions\nInbox\nArtifacts\nACCEPTANCE\nRepositories\nTeam\nRuntimes\nIntegrations\nAPP\nSettings\nDaemon connected · 51919\nNothing needs you\nAcceptance workspace\nNew missio`
- ✅ the High mission is pulled — `"AWAITING_PLAN_APPROVAL"`
- ✅ the Normal mission waits, and its row says "Held: this project is over 80% of its monthly limit" — `{"title":"H4 normal: tidy the footer muihx3ya","priority":"Normal","chip":"Normal","readiness":"Ready","queue":"Queued · 1/1","subtitle":"Held: this project is over 80% of its monthly limit (40 of 48 agent minutes). Only`
- ✅ with the slot free, Normal is still held (setup shortcut: High cancelled via API)
- ✅ proof (API): the backlog item carries the held reason — `["Held: this project is over 80% of its monthly limit (40 of 48 agent minutes). Only urgent and high missions are pulled."]`
- screenshot: `H4-project-limits.png`
- screenshot: `H4-home-month-warning.png`
- screenshot: `H4-normal-held.png`

## H5 — A USD limit that cannot be measured says so and never stops work

- note: setup: cancelled 1 mission(s) left by earlier scenarios, limit off
- ✅ Metrics → Limit: "not reported / $5.00" — `"Limit\nSet on this mission\nCost (USD)\nnot reported / $5.00\n\nCost: not reported. This runtime does not report cost, so this limit cannot be measured and never stops work.\n\nAgent minutes used\n1\nTokens used\n1,500\`
- ✅ and "Cost: not reported" — `"Limit\nSet on this mission\nCost (USD)\nnot reported / $5.00\n\nCost: not reported. This runtime does not report cost, so this limit cannot be measured and never stops work.\n\nAgent minutes used\n1\nTokens used\n1,500\`
- ✅ timeline: "USD limit cannot be measured for this runtime" — `"Tandemise\nAcceptance\n1 repository\nHome\nMissions\nInbox\nArtifacts\nACCEPTANCE\nRepositories\nTeam\nRuntimes\nIntegrations\nAPP\nSettings\nDaemon connected · 51919\nmsn_01m3f2j0tvkmmzby9g1p\nMissions\np2-solo\nH5 cos`
- ✅ the mission ran to the end
- ✅ proof (SQL): no incident
- ✅ proof (API): cost stays null (never 0), tokens are measured — `{"agentMinutes":1,"tokens":1500,"costUsd":null,"runs":1}`
- screenshot: `H5-usd-not-reported.png`
- screenshot: `H5-timeline-note.png`
