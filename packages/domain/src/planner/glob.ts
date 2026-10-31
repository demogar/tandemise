/**
 * Path globs for factory areas and merge rules (#53 §3): `**`, `*`, `?` and
 * `{a,b}` over `/`-separated, repository-relative paths. Small and pure, so the
 * domain needs no matcher dependency. A pattern with no `/` matches only a
 * top-level path (`CODEOWNERS`); write `**\/CODEOWNERS` for any depth.
 */
const cache = new Map<string, RegExp>();

export function globToRegExp(pattern: string): RegExp {
  const cached = cache.get(pattern);
  if (cached !== undefined) return cached;
  let out = '';
  let i = 0;
  let braces = 0;
  while (i < pattern.length) {
    const ch = pattern[i]!;
    if (ch === '*' && pattern[i + 1] === '*') {
      const before = i === 0 || pattern[i - 1] === '/';
      const after = pattern[i + 2] === '/' ? 1 : pattern[i + 2] === undefined ? 0 : -1;
      if (before && after === 1) { out += '(?:.*/)?'; i += 3; continue; }
      if (before && after === 0) {
        // `docs/**` matches `docs` itself and everything under it.
        if (out.endsWith('/')) { out = `${out.slice(0, -1)}(?:/.*)?`; } else { out += '.*'; }
        i += 2;
        continue;
      }
      out += '.*';
      i += 2;
      continue;
    }
    if (ch === '*') { out += '[^/]*'; i++; continue; }
    if (ch === '?') { out += '[^/]'; i++; continue; }
    if (ch === '{') { out += '(?:'; braces++; i++; continue; }
    if (ch === '}' && braces > 0) { out += ')'; braces--; i++; continue; }
    if (ch === ',' && braces > 0) { out += '|'; i++; continue; }
    out += /[.+^$()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
    i++;
  }
  const re = new RegExp(`^${out}$`);
  cache.set(pattern, re);
  return re;
}

export function matchGlob(pattern: string, path: string): boolean {
  const clean = path.replace(/^\.\//, '').replace(/\\/g, '/');
  return globToRegExp(pattern.trim()).test(clean);
}

export function matchAnyGlob(patterns: readonly string[], path: string): boolean {
  return patterns.some((p) => matchGlob(p, path));
}
