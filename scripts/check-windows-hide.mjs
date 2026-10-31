#!/usr/bin/env node
/**
 * Fails when shipped code starts a child process without `windowsHide: true`.
 *
 * On Windows, a console program started from a GUI app (the packaged desktop,
 * and the daemon it runs) gets a console window of its own unless the spawn
 * asks for it to be hidden: every `git`, agent CLI, MCP server and tool run
 * would flash a black window over the person's screen. Node ignores the
 * option elsewhere, so it costs nothing on macOS and Linux.
 *
 * Scans `apps/<app>/src` and `packages/<pkg>/src` (not tests, stories or
 * declarations). In every file that imports `node:child_process`, each call of
 * an imported function - or of a `promisify`d alias of one - must mention
 * `windowsHide` in its arguments.
 *
 *   node scripts/check-windows-hide.mjs
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(import.meta.url), '..', '..');
const SPAWNERS = new Set(['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']);

function* sourceFiles(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (entry === 'node_modules' || entry === 'dist' || entry === 'stories') continue;
    if (statSync(path).isDirectory()) yield* sourceFiles(path);
    else if (/\.(ts|tsx|mts|mjs)$/.test(entry) && !/\.(test|spec|stories)\.|\.d\.ts$/.test(entry)) yield path;
  }
}

/** The text between the parenthesis at `open` and its partner (strings and templates skipped). */
function argumentsAt(text, open) {
  let depth = 0;
  let quote = null;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\') { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
    if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return text.slice(open + 1, i);
  }
  return text.slice(open + 1);
}

export function findUnhiddenSpawns(text) {
  const names = new Set();
  for (const m of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"](?:node:)?child_process['"]/g)) {
    for (const part of m[1].split(',')) {
      const [imported, local] = part.replace(/\btype\b/, '').trim().split(/\s+as\s+/);
      if (imported && SPAWNERS.has(imported.trim())) names.add((local ?? imported).trim());
    }
  }
  if (names.size === 0) return [];
  for (const m of text.matchAll(/const\s+(\w+)\s*=\s*promisify\(\s*(\w+)\s*\)/g)) if (names.has(m[2])) names.add(m[1]);
  const problems = [];
  for (const name of names) {
    const call = new RegExp(`(?<![\\w.#$])${name}\\s*\\(`, 'g');
    for (const m of text.matchAll(call)) {
      const before = text.slice(Math.max(0, m.index - 30), m.index);
      if (/promisify\(\s*$/.test(before) || /import\s*\{[^}]*$/.test(before)) continue;
      const args = argumentsAt(text, m.index + m[0].length - 1);
      if (/^\s*\w+\s*\)?\s*$/.test(args) && /promisify\(\s*$/.test(text.slice(0, m.index))) continue;
      if (!/\bwindowsHide\b/.test(args)) problems.push({ line: text.slice(0, m.index).split('\n').length, name });
    }
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // The detector itself: it must catch what it exists to catch.
  const sample = [
    "import { execFile, spawn as start } from 'node:child_process';",
    'const run = promisify(execFile);',
    "start('git', ['status'], { cwd });",
    "await run('git', ['log'], { windowsHide: true });",
    "await run('git', ['log']);",
  ].join('\n');
  const caught = findUnhiddenSpawns(sample).map((p) => `${p.name}@${p.line}`).join(',');
  if (caught !== 'start@3,run@5') {
    console.error(`✗ the windowsHide detector is broken: on its sample it reported "${caught}", expected "start@3,run@5"`);
    process.exit(1);
  }

  const problems = [];
  let files = 0;
  for (const group of ['apps', 'packages']) {
    for (const name of readdirSync(join(root, group))) {
      const src = join(root, group, name, 'src');
      try { statSync(src); } catch { continue; }
      for (const file of sourceFiles(src)) {
        files++;
        for (const p of findUnhiddenSpawns(readFileSync(file, 'utf8'))) problems.push(`${relative(root, file)}:${p.line} ${p.name}(…) has no windowsHide`);
      }
    }
  }
  if (problems.length > 0) {
    console.error(`✗ ${problems.length} child process start(s) without windowsHide: true (a console window would flash on Windows):`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log(`✓ every child process is started with windowsHide (${files} files)`);
}
