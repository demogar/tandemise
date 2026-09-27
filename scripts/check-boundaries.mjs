#!/usr/bin/env node
// Mechanically enforces MVP.md §26.1: dependency direction and the §6.1
// boundary rule (domain/application must not import provider-specific modules).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { LAYERS, PACKAGES, PROVIDER_PACKAGES } from './packages.mjs';

const FORBIDDEN_IN_CORE = [
  /^electron$/, /^playwright/, /^better-sqlite3$/, /^@octokit/, /^ws$/,
  /^node:child_process$/, /^child_process$/,
];
const CORE = new Set(['kernel', 'domain', 'application', 'policy', 'context', 'evaluation',
  'runtimes-core', 'execution-core', 'integrations-core']);

const errors = [];

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts') && !p.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

// Matches only statement-position import/export-from. `[^;]` stops the match
// crossing a statement boundary, which previously let a string literal inside a
// function body be mistaken for a module specifier.
const IMPORT_RE = /^\s*(?:import|export)\s[^;]*?\sfrom\s+['"]([^'"]+)['"]/gm;
const SIDE_EFFECT_IMPORT_RE = /^\s*import\s+['"]([^'"]+)['"]/gm;

for (const [name, spec] of Object.entries(PACKAGES)) {
  const root = `packages/${name}/src`;
  let files;
  try { files = walk(root); } catch { continue; }
  const allowed = new Set(spec.deps.map((d) => `@tandemise/${d}`));
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    const specifiers = [
      ...[...src.matchAll(IMPORT_RE)].map((m) => m[1]),
      ...[...src.matchAll(SIDE_EFFECT_IMPORT_RE)].map((m) => m[1]),
    ];
    for (const mod of specifiers) {
      if (!mod || mod.startsWith('.')) continue;
      if (mod.startsWith('@tandemise/')) {
        const dep = mod.slice('@tandemise/'.length);
        if (!allowed.has(mod)) {
          errors.push(`${file}: imports ${mod} which is not a declared dependency of @tandemise/${name}`);
        } else if ((LAYERS[dep] ?? 99) >= (LAYERS[name] ?? 99)) {
          errors.push(`${file}: layer violation - ${name}(L${LAYERS[name]}) -> ${dep}(L${LAYERS[dep]})`);
        }
        continue;
      }
      const bare = mod.startsWith('@') ? mod.split('/').slice(0, 2).join('/') : mod.split('/')[0];
      if (CORE.has(name) && FORBIDDEN_IN_CORE.some((re) => re.test(bare))) {
        errors.push(`${file}: core package '${name}' must not import provider/runtime module '${mod}' (MVP.md §6.1)`);
      }
      const declared = { ...(spec.ext ?? {}), ...(spec.dev ?? {}) };
      if (!mod.startsWith('node:') && !declared[bare] && !PROVIDER_PACKAGES.has(name)) {
        errors.push(`${file}: undeclared external dependency '${mod}' in @tandemise/${name}`);
      }
    }
  }
}

// The renderer is a sandboxed browser context (MVP.md §7.1). Every
// `@tandemise/*` package's runtime entry reaches `@tandemise/shared`, which
// imports `node:os` and `node:path`, so a single value import blanks the whole
// app at load - and the type checker cannot see it, because the types are
// fine. Types cost nothing and are allowed; runtime values the renderer needs
// are mirrored in `lib/domain.ts`.
{
  const renderer = 'apps/desktop/src/renderer/src';
  const TYPE_ONLY_RE = /^\s*(?:import|export)\s+type\s/;
  // Subpaths whose compiled module has no runtime imports at all, so the Team
  // screen and the daemon share one preset mapping instead of a mirrored copy.
  // Each maps to its source; the allowance holds only while that source has no
  // value imports or re-exports of any kind (type-only ones are erased).
  const PURE_SUBPATH_SOURCES = new Map([
    ['@tandemise/domain/staffing-presets', 'packages/domain/src/staffing-presets.ts'],
    // The artifact reader hides YAML front matter with the same rule the daemon uses.
    ['@tandemise/artifacts/strip-front-matter', 'packages/artifacts/src/strip-front-matter.ts'],
    // The Inbox and the daemon's mission feed judge "for me" with one rule.
    ['@tandemise/api-contract/for-me', 'packages/api-contract/src/for-me.ts'],
    // Settings → About and the offline check build the copied diagnostics with one function.
    ['@tandemise/api-contract/about', 'packages/api-contract/src/about.ts'],
  ]);
  const PURE_SUBPATHS = new Set(PURE_SUBPATH_SOURCES.keys());
  const ANY_IMPORT_RE = /^\s*(?:import|export)\b[^;]*?\bfrom\s+['"]([^'"]+)['"]|^\s*import\s+['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|\brequire\s*\(/gm;
  for (const [subpath, source] of PURE_SUBPATH_SOURCES) {
    let src;
    try {
      src = readFileSync(source, 'utf8');
    } catch {
      errors.push(`${subpath}: allowlisted as pure but ${source} does not exist`);
      continue;
    }
    for (const match of src.matchAll(ANY_IMPORT_RE)) {
      if (TYPE_ONLY_RE.test(match[0])) continue;
      errors.push(`${source}: allowlisted for the renderer as pure, but has a value import (${match[0].trim().slice(0, 80)}); keep it type-only or drop the allowance`);
    }
  }
  const STATEMENT_RE = /^\s*(?:import|export)\s[^;]*?\sfrom\s+['"](@tandemise\/[^'"]+)['"]/gm;
  let files = [];
  try {
    files = readdirSync(renderer, { recursive: true })
      .map((e) => join(renderer, String(e)))
      .filter((p) => (p.endsWith('.ts') || p.endsWith('.tsx')) && !p.endsWith('.d.ts'));
  } catch { /* no renderer in this checkout */ }
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    for (const match of src.matchAll(STATEMENT_RE)) {
      if (TYPE_ONLY_RE.test(match[0]) || PURE_SUBPATHS.has(match[1])) continue;
      errors.push(`${file}: renderer value-imports ${match[1]}, which pulls Node built-ins into the browser bundle; use \`import type\` or lib/domain.ts`);
    }
  }
}

if (errors.length) {
  console.error('Architecture boundary violations:\n' + errors.map((e) => '  ✗ ' + e).join('\n'));
  process.exit(1);
}
console.log('✓ architecture boundaries ok');
