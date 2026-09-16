You are a research subagent working in /Users/you/projects/tandemise. Do NOT modify any files. Use only read/grep/find/ls/bash to investigate.

Goal: produce a concise, precise summary of the artifact + handoff + evidence/snapshot system, to feed a design spec about "outside contributions" (uploads and external hand-backs with snapshots).

Investigate:
1. packages/artifacts/src/* — especially schemas.ts, templates.ts, handoff.ts, store.ts, index.ts. List every artifact type, its zod schema, and whether it requires a `handoff` block. Summarize the handoff block fields and their validation rules.
2. How artifacts are versioned, superseded, and stored (store.ts + persistence repositories). What columns exist (handoff, word_count, over_budget, supersedes, etc.), and how versions chain.
3. What "Evidence" is: grep the whole repo (packages/* and apps/*) for "Evidence" and "snapshot". Summarize how external links / workspace links and snapshots are represented today, if at all.
4. How the handoff `links` array works (kind, url, label) and how the UI renders it (apps/desktop/src/renderer/src — grep for "links", "handoff", "kind: workspace", "Open").

Write your findings to stdout as a Markdown summary with headings and file-path citations. Keep it under ~1500 words. End with a short "Implications for P3 (uploads + hand-backs)" section.
