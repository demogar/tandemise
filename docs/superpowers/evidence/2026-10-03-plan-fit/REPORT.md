# Plan fit acceptance report

Run: 2026-10-04T02:00:17.562Z · build f066dbd · fresh install at /var/folders/dh/glpvvh110393gdzjc_v2x1sr0000gn/T/tdm-pf-run-mut6alen
Command: `node scratch/acceptance/plan-fit/run-all.mjs`
Result: **ALL PASS** (1/1 scenarios)

| Scenario | Result | Checks |
|---|---|---|
| F1 — A person's step shows what the step before it handed over | PASS | 7/7 |

## F1 — A person's step shows what the step before it handed over

- ✅ proof (API): intake wrote Evidence whose handoff needs a decision — `{"headline":"The role is US-only, so I stopped before the CV","points":["All 14 listed cities and all 4 pay tiers are in the US","No questions file was written"],"needs":"Decide: skip it, or ask whether Panama counts as Americas","changed":[],"links":[]}`
- ✅ proof (API): the person step's view carries that Evidence as what came in — `[{"id":"art_01m42a6wzpn576b0yt7r","headline":"The role is US-only, so I stopped before the CV"}]`
- ✅ the drawer names the step it came from — `"answer\nThis one is yours\nFROM “INTAKE”\n\nThe role is US-only, so I stopped before the CV\n\nAll 14 listed cities and all 4 pay tiers are in the US\nNo questions file was written\nNeeds Decide: skip it, or ask whether Panama counts as Americas\nFull doc\n\nRead the questions in applications/23/qu`
- ✅ the drawer shows the intake headline and points — `"answer\nThis one is yours\nFROM “INTAKE”\n\nThe role is US-only, so I stopped before the CV\n\nAll 14 listed cities and all 4 pay tiers are in the US\nNo questions file was written\nNeeds Decide: skip it, or ask whether Panama counts as Americas\nFull doc\n\nRead the questions in applications/23/qu`
- ✅ the drawer shows what it needs from the person — `"answer\nThis one is yours\nFROM “INTAKE”\n\nThe role is US-only, so I stopped before the CV\n\nAll 14 listed cities and all 4 pay tiers are in the US\nNo questions file was written\nNeeds Decide: skip it, or ask whether Panama counts as Americas\nFull doc\n\nRead the questions in applications/23/qu`
- ✅ what came in reads before the objective planned ahead of it — `{"headline":40,"objective":248}`
- ✅ "Full doc" opens the Evidence in the drawer — `"answer\nThis one is yours\nFROM “INTAKE”\n\nThe role is US-only, so I stopped before the CV\n\nAll 14 listed cities and all 4 pay tiers are in the US\nNo questions file was written\nNeeds Decide: skip it, or ask whether Panama counts as Americas\nHide full doc\n\nRead the questions in applications/`
- screenshot: `F1-person-step-what-came-in.png`
- screenshot: `F1-person-step-full-doc.png`
