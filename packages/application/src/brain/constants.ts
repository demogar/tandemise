/**
 * The brain's timing and size thresholds (#51 spec "Left to the builder").
 */

/** A pull older than this is refreshed before planning or starting a task (spec §4). */
export const BRAIN_PULL_STALE_MS = 5 * 60_000;
/** The background pull, so a teammate's push arrives even on an idle machine (spec §4). */
export const BRAIN_BACKGROUND_PULL_MS = 10 * 60_000;
/** Ledger writes are batched into one commit at most this often, plus at mission end (spec §4). */
export const BRAIN_LEDGER_COMMIT_MS = 2 * 60_000;
/** Rules load on every run; a file this long gets a warning so it stays short (spec §10). */
export const BRAIN_RULES_WARN_CHARS = 8_000;
/** Write-through of a person's edits waits this long so a burst of edits is one commit. */
export const BRAIN_WRITE_THROUGH_DEBOUNCE_MS = 2_000;
