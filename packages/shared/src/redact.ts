/**
 * Best-effort secret redaction for logs and event payloads (MVP.md §22.3).
 *
 * This is defence in depth, not the primary control - the primary control is
 * that Tandemise stores secret *references* rather than secret values
 * (MVP.md §P8). These patterns catch the accidental cases: a token echoed by a
 * CLI, an `Authorization` header in a tool input summary, a `.env` line printed
 * by a build script.
 */
const PATTERNS: Array<[RegExp, string]> = [
  [/\b(sk-ant-[A-Za-z0-9_-]{8,})/g, 'sk-ant-«redacted»'],
  [/\b(sk-[A-Za-z0-9]{20,})/g, 'sk-«redacted»'],
  [/\b(gh[pousr]_[A-Za-z0-9]{16,})/g, 'gh«redacted»'],
  [/\b(github_pat_[A-Za-z0-9_]{20,})/g, 'github_pat_«redacted»'],
  [/\b(figd_[A-Za-z0-9_-]{16,})/g, 'figd_«redacted»'],
  [/\b(xox[baprs]-[A-Za-z0-9-]{10,})/g, 'xox«redacted»'],
  [/\bAKIA[0-9A-Z]{16}\b/g, 'AKIA«redacted»'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, 'jwt«redacted»'],
  [/("(?:password|passwd|secret|token|api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|client[_-]?secret)"\s*:\s*")([^"]{4,})(")/gi, '$1«redacted»$3'],
  [/\b((?:PASSWORD|SECRET|TOKEN|API_KEY|ACCESS_TOKEN|CLIENT_SECRET)[A-Z_]*=)(\S{4,})/g, '$1«redacted»'],
  [/\b(Authorization:\s*(?:Bearer|Basic|token)\s+)(\S{6,})/gi, '$1«redacted»'],
  [/(https?:\/\/)([^/\s:@]+):([^/\s@]+)@/g, '$1$2:«redacted»@'],
];

export function redactSecrets(input: string): string {
  let out = input;
  for (const [re, replacement] of PATTERNS) out = out.replace(re, replacement);
  return out;
}

/** Additionally redacts any explicitly known secret values (exact substrings). */
export function redactWithKnownValues(input: string, knownSecrets: readonly string[]): string {
  let out = redactSecrets(input);
  for (const s of knownSecrets) {
    if (s.length >= 6) out = out.split(s).join('«redacted»');
  }
  return out;
}

/** Truncates while preserving a readable head, for event payload summaries. */
export function summarize(value: unknown, maxLength = 400): string {
  let text: string;
  if (typeof value === 'string') text = value;
  else {
    try { text = JSON.stringify(value) ?? String(value); } catch { text = String(value); }
  }
  text = redactSecrets(text.replace(/\s+/g, ' ').trim());
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}… (+${text.length - maxLength} chars)`;
}
