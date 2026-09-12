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

if (errors.length) {
  console.error('Architecture boundary violations:\n' + errors.map((e) => '  ✗ ' + e).join('\n'));
  process.exit(1);
}
console.log('✓ architecture boundaries ok');
