# Hold and interact: acceptance report

Run: 2026-10-31T03:18:58.790Z · build 542683b · fresh install at /tmp/tdm-hold-run-mvvtp6mu
Result: **ALL PASS** (12/12 scenarios)

| Scenario | Result | Checks |
|---|---|---|
| H1 — Hold a running step: the panel shows its resumed session and takes your typing | PASS | 10/10 |
| H2 — Iterate: what you make in the terminal lands in the step's worktree | PASS | 4/4 |
| H3 — Continue: a resumed pass on the captured session, no attempt spent, output gated as usual | PASS | 12/12 |
| H3-claude — Continue on the real Claude Code: its own session in the panel, then a resumed pass | PASS | 10/10 |
| H4 — Close the panel mid-hold: the terminal keeps going, and reopening repaints it | PASS | 8/8 |
| H5 — Restart the daemon mid-hold: still HELD, and reopening resumes the captured session | PASS | 9/9 |
| H6 — Hold a step waiting on ask_human: its question leaves the Inbox | PASS | 10/10 |
| H7 — Hold a ready step: a fresh session in a worktree made for it | PASS | 9/9 |
| H8 — "Now": a running step says what it is doing, and the line follows its events | PASS | 9/9 |
| H9 — Refusals: Hold says why it is not offered, in the daemon's words | PASS | 8/8 |
| H10 — Hold an output under review: a new round, a new version, reviewed again | PASS | 8/8 |
| H11 — Profile pinning: Continue resumes on the profile the hold was made on | PASS | 5/5 |

## H1 — Hold a running step: the panel shows its resumed session and takes your typing

- note: dark: terminal background rgb(9, 9, 23), text rgb(238, 249, 236)
- note: light: terminal background rgb(255, 255, 255), text rgb(32, 30, 80)
- ✅ proof (API): the step is running, and the view offers a hold — `{"ok":true}`
- ✅ its in-progress card offers Hold, next to its other actions — `{"text":"Hold","disabled":false,"title":"Stop the agent and work with it in its own terminal"}`
- ✅ Hold opens the terminal panel, named for the step — `"Terminal: design"`
- ✅ the panel says who holds it: "Held by You" — `"designHeld by YouContinueReleaseClose terminalClaude Code may ask whether to trust this folder — choose “Yes, I trust this folder”. Tandemise created it for this task."`
- ✅ it offers Continue, Release and Close terminal — `"designHeld by YouContinueReleaseClose terminalClaude Code may ask whether to trust this folder — choose “Yes, I trust this folder”. Tandemise created it for this task."`
- ✅ proof (API): the step is HELD, its terminal open — `{"status":"HELD","hold":{"holdId":"hld_01m67z0phvnya17jq4ar","heldBy":"mem_01m67yyyc0gv4gmzpfn2","heldByName":"Demostenes Garcia","startedAt":"2026-10-31T03:10:56.060Z","terminalOpen":true}}`
- ✅ proof (DB): the run it stopped ended RESUMABLE — `{"id":"run_01m67yz5w94qqwvthfrr","attempt":1,"status":"RESUMABLE","round":1,"purpose":"round","sessionId":"sess-hold-run_01m67yz5w94qqwvthfrr","profileId":"rt_01m67yz0pwzr5a1jkdb8","startedAt":"2026-10-31T03:10:06.237Z",`
- ✅ proof (DB): the hold started from that run's session — `{"hold":{"id":"hld_01m67z0phvnya17jq4ar","heldBy":"mem_01m67yyyc0gv4gmzpfn2","fromStatus":"RUNNING","profileId":"rt_01m67yz0pwzr5a1jkdb8","sessionBefore":"sess-hold-run_01m67yz5w94qqwvthfrr","sessionAfter":null,"endedAt"`
- ✅ the terminal shows the session it resumed — `"Fake session sess-hold-run_01m67yz5w94qqwvthfrr\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n"`
- ✅ what you type reaches the session (it echoes it back) — `"Fake session sess-hold-run_01m67yz5w94qqwvthfrr\nhello from the panel\n> hello from the panel\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n"`
- screenshot: `H1-card-hold.png`
- screenshot: `H1-panel-dark.png`
- screenshot: `H1-panel-light.png`

## H2 — Iterate: what you make in the terminal lands in the step's worktree

- ✅ the panel is still open on the held step — `"Terminal: design"`
- ✅ the session reports the file written — `"Fake session sess-hold-run_01m67yz5w94qqwvthfrr\nhello from the panel\n> hello from the panel\nwrite d.txt\n> write d.txt\nwrote d.txt\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n"`
- ✅ proof (disk): d.txt is in the step's worktree — `"/tmp/tdm-hold/home/workspaces/ws_01m67yyyc0gv4gmzpfn1/missions/msn_01m67yz2sddn8wh55a4h/worktrees/onboarding-hold-slow-now-mvvtp90k-design-n5mdahrn/d.txt"`
- ✅ proof (disk): with what the session wrote
- screenshot: `H2-wrote-file.png`

## H3 — Continue: a resumed pass on the captured session, no attempt spent, output gated as usual

- ✅ the panel is open on the held step
- ✅ Continue ends the hold and the panel closes
- ✅ the step finishes — `{"status":"SUCCEEDED","reason":null}`
- ✅ proof (API): continuing spent no attempt — `{"before":1,"after":1}`
- ✅ proof (DB): the hold ended as continued, and its continuation was taken — `{"id":"hld_01m67z0phvnya17jq4ar","heldBy":"mem_01m67yyyc0gv4gmzpfn2","fromStatus":"RUNNING","profileId":"rt_01m67yz0pwzr5a1jkdb8","sessionBefore":"sess-hold-run_01m67yz5w94qqwvthfrr","sessionAfter":"fake-session-17934163`
- ✅ proof (DB): one new pass ran — `{"id":"run_01m67z4x387endkdtw05","attempt":2,"status":"SUCCEEDED","round":1,"purpose":"retry","sessionId":"sess-hold-run_01m67z4x387endkdtw05","profileId":"rt_01m67yz0pwzr5a1jkdb8","startedAt":"2026-10-31T03:13:13.854Z",`
- ✅ proof (DB): that pass resumed the session the terminal captured — `{"sessionAfter":"fake-session-1793416362671","resumedOn":[{"type":"checkpoint","externalSessionId":"fake-session-1793416362671","label":"session.resumed"}]}`
- ✅ proof (API): task.hold_ended carries the diff stat (d.txt added) — `{"files":1,"insertions":1,"deletions":0}`
- ✅ proof (API): and who held it, from where, the sessions and how long — `{"type":"task.hold_ended","holdId":"hld_01m67z0phvnya17jq4ar","ending":"continued","endedBy":"mem_01m67yyyc0gv4gmzpfn2","sessionAfter":"fake-session-1793416362671","durationMs":137731,"diffStat":{"files":1,"insertions":1`
- ✅ proof (API): the continuation's DesignBrief was harvested — `[{"type":"DesignBrief","run":"run_01m67z4x387endkdtw05"}]`
- ✅ proof (API): and gated as usual — `null`
- ✅ proof (API): a finished step is no longer holdable, in words — `{"ok":false,"reason":"This step is done; request changes instead."}`
- screenshot: `H3-done.png`

## H3-claude — Continue on the real Claude Code: its own session in the panel, then a resumed pass

- note: setup: the Design agent runs on Claude Code
- note: session before ff852bdd-9222-440e-9f5d-3fe0d5c01efa, captured ff852bdd-9222-440e-9f5d-3fe0d5c01efa (kept by --resume)
- ✅ proof (DB): the Claude run ended RESUMABLE and the hold starts from its session — `{"run":"RESUMABLE","hold":{"id":"hld_01m67zcsd1dsjj08ws6v","heldBy":"mem_01m67yyyc0gv4gmzpfn2","fromStatus":"RUNNING","profileId":"rt_01m67zcjd1kt6f5we8gq","sessionBefore":"ff852bdd-9222-440e-9f5d-3fe0d5c01efa","sessionA`
- ✅ while Claude asks to trust the folder, the panel says how to answer — `"designHeld by YouContinueReleaseClose terminalClaude Code may ask whether to trust this folder — choose “Yes, I trust this folder”. Tandemise created it for this task."`
- ✅ Enter on "No, exit": the panel says "The session ended." and repeats how to answer, next to "Open the terminal again" — `"designHeld by YouContinueReleaseClose terminalThe session ended.Claude Code may ask whether to trust this folder — choose “Yes, I trust this folder”. Tandemise created it for this task.Open the terminal again"`
- ✅ the panel shows Claude Code's own session, ready for you ("? for shortcuts") — `"          ◐ medium · /effort\n──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────\n❯\n──────────────────────────`
- ✅ proof (DB): the terminal's session was captured — `{"id":"hld_01m67zcsd1dsjj08ws6v","heldBy":"mem_01m67yyyc0gv4gmzpfn2","fromStatus":"RUNNING","profileId":"rt_01m67zcjd1kt6f5we8gq","sessionBefore":"ff852bdd-9222-440e-9f5d-3fe0d5c01efa","sessionAfter":"ff852bdd-9222-440e-`
- ✅ the step finishes — `{"status":"SUCCEEDED","reason":null}`
- ✅ proof (DB): the continuation ran on Claude Code and took the hold — `{"id":"run_01m67zd2c6ref8ykxb9b","attempt":2,"status":"SUCCEEDED","round":1,"purpose":"retry","sessionId":"ff852bdd-9222-440e-9f5d-3fe0d5c01efa","profileId":"rt_01m67zcjd1kt6f5we8gq","startedAt":"2026-10-31T03:17:41.400Z`
- ✅ proof (DB): the continuation spent no attempt (it ran as the attempt the hold stopped) — `{"before":1,"continuation":1}`
- ✅ proof (DB): it resumed the captured session — `{"pass":"ff852bdd-9222-440e-9f5d-3fe0d5c01efa","captured":"ff852bdd-9222-440e-9f5d-3fe0d5c01efa"}`
- ✅ proof (API): its DesignBrief was harvested — `"Onboarding note — first-run welcome"`
- screenshot: `H3-claude-claude-trust.png`
- screenshot: `H3-claude-claude-exited-at-trust.png`
- screenshot: `H3-claude-claude-in-panel.png`
- screenshot: `H3-claude-claude-done.png`

## H4 — Close the panel mid-hold: the terminal keeps going, and reopening repaints it

- ✅ Close terminal closes the panel
- ✅ proof (API): the step is still HELD, its terminal still open — `{"holdId":"hld_01m67z0phvnya17jq4ar","heldBy":"mem_01m67yyyc0gv4gmzpfn2","heldByName":"Demostenes Garcia","startedAt":"2026-10-31T03:10:56.060Z","terminalOpen":true}`
- ✅ proof (OS): the terminal process is still running — `{"pid":3652629,"alive":true}`
- ✅ the held step's drawer offers Open terminal, Release and Continue — `["Details","Open terminal","Continue","Release","Request changes","Close"]`
- ✅ and no Hold — `{"text":"Open terminal","disabled":false,"title":""}`
- ✅ the drawer steps aside for the panel
- ✅ the reopened panel repaints the scrollback: the greeting, your typing, the file — `"Fake session sess-hold-run_01m67yz5w94qqwvthfrr\nhello from the panel\n> hello from the panel\nwrite d.txt\n> write d.txt\nwrote d.txt\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n"`
- ✅ proof (DB): still the same hold
- screenshot: `H4-drawer-held.png`
- screenshot: `H4-reopened.png`

## H5 — Restart the daemon mid-hold: still HELD, and reopening resumes the captured session

- note: daemon 3650836 stopped
- ✅ the panel is open on the held step
- ✅ the window says the daemon is gone — `"The Tandemise daemon is not running"`
- ✅ proof: a new daemon is up — `{"old":3650836,"now":3656182}`
- ✅ proof (API): after the restart the step is still HELD — `{"status":"HELD","reason":"Held by Demostenes Garcia."}`
- ✅ proof (API): its terminal is not open — `{"holdId":"hld_01m67z0phvnya17jq4ar","heldBy":"mem_01m67yyyc0gv4gmzpfn2","heldByName":"Demostenes Garcia","startedAt":"2026-10-31T03:10:56.060Z","terminalOpen":false}`
- ✅ back on the mission, the panel says "The session ended." and offers "Open the terminal again" — `"designHeld by YouContinueReleaseClose terminalThe session ended.This step has no open terminal. Hold it, or open its terminal again.Open the terminal again"`
- ✅ with the daemon's own words for why: there is no terminal open for this step — `"designHeld by YouContinueReleaseClose terminalThe session ended.This step has no open terminal. Hold it, or open its terminal again.Open the terminal again"`
- ✅ the terminal opens again on the session the first terminal captured, not the run's — `{"resumed":"Fake session fake-session-1793416256221\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n","before":"sess-hold-run_01m67yz5w94qqwvthfrr"}`
- ✅ proof (API): its terminal is open again, same hold — `{"holdId":"hld_01m67z0phvnya17jq4ar","heldBy":"mem_01m67yyyc0gv4gmzpfn2","heldByName":"Demostenes Garcia","startedAt":"2026-10-31T03:10:56.060Z","terminalOpen":true}`
- screenshot: `H5-daemon-gone.png`
- screenshot: `H5-session-ended.png`
- screenshot: `H5-reopened.png`

## H6 — Hold a step waiting on ask_human: its question leaves the Inbox

- ✅ setup: the run's MCP gateway config is on disk
- ✅ proof (API): the step waits on its question, a question card pending — `{"status":"AWAITING_INPUT","card":"Which layout should onboarding use (mvvtva3b)?"}`
- ✅ the question waits on you in the Inbox — `"Inbox\nWhat is waiting on a person.\nWhich layout should onboarding use (mvvtva3b)?\nFor you·Ask about onboarding mvvtv5fa\nQuestion\njust now"`
- ✅ Hold from its drawer opens the terminal panel
- ✅ the session is resumed in the terminal, to answer there — `"Fake session sess-hold-run_01m67z7jpfr6n9dg1nfz\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n"`
- ✅ proof (API): the step is HELD — `"HELD"`
- ✅ proof (API): the question card was withdrawn — `"CANCELLED"`
- ✅ the question no longer waits on you in the Inbox — `"Inbox\nWhat is waiting on a person.\nNothing is waiting on you\n\nApprovals, questions, tasks for a person, work to hand back, stalled missions and quiet agents land here, one line each.\n"`
- ✅ it is listed as decided: withdrawn because the work moved on — `"va3b)?\nWithdrawn — the work ended first · “Held by Demostenes Garcia.”\nAsk about onboarding mvvtv5fa\nApprove the plan fo"`
- ✅ Release in the drawer ends the hold
- screenshot: `H6-inbox-question.png`
- screenshot: `H6-inbox-after.png`

## H7 — Hold a ready step: a fresh session in a worktree made for it

- note: setup: both steps go to one fake runtime with a single slot
- ✅ proof (API): one step runs and the other waits ready, never started — `{"status":"READY","reason":"Waiting for a runtime slot. 'Hold fake one slot': saturated: 1/1 runs in flight","holdable":{"ok":true}}`
- ✅ proof (API): it has no worktree yet
- ✅ its card offers Hold — `{"text":"Hold","disabled":false,"title":"Stop the agent and work with it in its own terminal"}`
- ✅ Hold opens the terminal panel on it
- ✅ a fresh session starts (nothing to resume) — `"Fake session new\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n"`
- ✅ proof (DB): a hold from READY, with no session before it — `{"id":"hld_01m67z93zqx4nsgnk6gd","heldBy":"mem_01m67yyyc0gv4gmzpfn2","fromStatus":"READY","profileId":"rt_01m67z8semarhqfq8cv4","sessionBefore":null,"sessionAfter":null,"endedAt":null,"ending":null,"consumedAt":null,"dif`
- ✅ proof (API): its worktree was provisioned — `"/tmp/tdm-hold/home/workspaces/ws_01m67yyyc0gv4gmzpfn1/missions/msn_01m67z8vh09y52sh6sqv/worktrees/two-pages-mvvtw44b-settings-45etarg1"`
- ✅ proof (disk): the session works in that worktree
- ✅ Release ends the hold and the panel closes
- screenshot: `H7-fresh-session.png`

## H8 — "Now": a running step says what it is doing, and the line follows its events

- note: setup: the Design agent runs on a fake runtime that resumes and opens an interactive session on a PTY
- ✅ proof (API): the step runs on the fake runtime — `"Hold fake"`
- ✅ the Plan card shows a "Now" line while the step runs — `["Now Reading the onboarding flow","Now Running npm test","Now Editing .tandemise/out/DesignBrief.md"]`
- ✅ the line changes as events arrive (at least three different lines) — `["Now Reading the onboarding flow","Now Running npm test","Now Editing .tandemise/out/DesignBrief.md"]`
- ✅ it says what it does in words: "Running npm test" for a shell command — `["Now Reading the onboarding flow","Now Running npm test","Now Editing .tandemise/out/DesignBrief.md"]`
- ✅ a file it edits reads relative to its worktree: "Editing .tandemise/out/DesignBrief.md" — `["Now Reading the onboarding flow","Now Running npm test","Now Editing .tandemise/out/DesignBrief.md"]`
- ✅ no raw tool names in it — `["Now Reading the onboarding flow","Now Running npm test","Now Editing .tandemise/out/DesignBrief.md"]`
- ✅ the feed card shows the same "Now" line — `{"feedNow":"Now Editing .tandemise/out/DesignBrief.md","last":"Now Editing .tandemise/out/DesignBrief.md"}`
- ✅ the task drawer shows it at the top — `"Now Editing .tandemise/out/DesignBrief.md"`
- ✅ proof (API): the view says the same — `"Editing .tandemise/out/DesignBrief.md"`
- screenshot: `H8-plan-card-now.png`
- screenshot: `H8-feed-card-now.png`
- screenshot: `H8-drawer-now.png`

## H9 — Refusals: Hold says why it is not offered, in the daemon's words

- note: an eval trial's step is refused with "Eval trials can't be held." — proven offline (scratch/hold-check.mjs); trial missions never appear in the window
- ✅ a finished step: Hold is disabled, and says why — `{"text":"Hold","disabled":true,"title":"This step is done; request changes instead."}`
- ✅ proof (API): holding it is refused in the same words — `{"status":409,"message":"This step is done; request changes instead."}`
- ✅ proof (API): the step is running, its agent finished, its checks going — `"SUCCEEDED"`
- ✅ while it checks its work: Hold on its card is disabled, and says why — `{"text":"Hold","disabled":true,"title":"It's checking its work. You can hold it once that's done."}`
- ✅ proof (API): holding it is refused in the same words — `{"status":409,"message":"It's checking its work. You can hold it once that's done."}`
- ✅ proof (API): the view says why — `{"ok":false,"reason":"Only Claude Code steps can be held for now."}`
- ✅ a runtime with no terminal: Hold is disabled, and says why — `{"text":"Hold","disabled":true,"title":"Only Claude Code steps can be held for now."}`
- ✅ proof (API): holding it is refused in the same words, and it keeps running — `{"status":409,"message":"Only Claude Code steps can be held for now."}`
- screenshot: `H9-done-step.png`
- screenshot: `H9-checking.png`
- screenshot: `H9-no-terminal.png`

## H10 — Hold an output under review: a new round, a new version, reviewed again

- ✅ proof (API): its output waits for your review — `{"card":"Approve the output of design?","briefs":1,"holdable":{"ok":true}}`
- ✅ Hold from its drawer opens the terminal panel
- ✅ the step's last session is resumed — `"Fake session sess-quick-run_01m67za86ffvb3amj4jr\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n"`
- ✅ proof (API): HELD, in a new round — `{"status":"HELD","round":2}`
- ✅ proof (API): the review card is no longer waiting — `"REJECTED"`
- ✅ Continue produces a new version of the output, replacing the reviewed one — `[{"id":"art_01m67zad7xpd4zsh5h0a","supersedes":"art_01m67za87dhz56sw5xzb"}]`
- ✅ which goes through review again: a new review card waits for you — `{"status":"AWAITING_APPROVAL","card":"Approve the output of design?"}`
- ✅ its card reads Round 2, in review — `"PRODUCT DESIGNER\ndesign\nIn review\nRound 2\njust now\nby\nDesign agent\n·\nresponsible\nYou\nFull doc\n\nOnboarding designed\n\nNeeds Approve the output of design?\nApplies immediately.\nReject without changes\nRequ"`
- screenshot: `H10-held-for-changes.png`
- screenshot: `H10-round-2-review.png`

## H11 — Profile pinning: Continue resumes on the profile the hold was made on

- note: setup: the Design agent runs on two runtime profiles, A then B
- ✅ proof (API): it runs on one of the two — `{"on":"rt_01m67zbchjmhx7ptvn55","a":"rt_01m67zbchjmhx7ptvn55","b":"rt_01m67zbchq693fasjv28"}`
- ✅ proof (DB): the hold is pinned to that profile — `{"id":"hld_01m67zbkhktv37xc38qy","heldBy":"mem_01m67yyyc0gv4gmzpfn2","fromStatus":"RUNNING","profileId":"rt_01m67zbchjmhx7ptvn55","sessionBefore":"sess-hold-run_01m67zbhpy0a2q816037","sessionAfter":null,"endedAt":null,"e`
- ✅ setup: the Design agent now lists the other profile first
- ✅ the continuation finishes — `{"status":"SUCCEEDED","reason":null}`
- ✅ proof (DB): Continue resumed on the hold's profile, not the one routing would pick now — `{"pass":"rt_01m67zbchjmhx7ptvn55","pinned":"rt_01m67zbchjmhx7ptvn55","other":"rt_01m67zbchq693fasjv28"}`
- screenshot: `H11-continued.png`
