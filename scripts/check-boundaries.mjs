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

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s+['"]([^'"]+)['"]|(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g;

for (const [name, spec] of Object.entries(PACKAGES)) {
  const root = `packages/${name}/src`;
  let files;
  try { files = walk(root); } catch { continue; }
  const allowed = new Set(spec.deps.map((d) => `@tandemise/${d}`));
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(IMPORT_RE)) {
      const mod = m[1] ?? m[2];
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
