#!/usr/bin/env node
/**
 * Stages the daemon a packaged desktop app carries in `resources/daemon`.
 *
 * The daemon is a plain Node program spread over the workspace packages it
 * imports (`@tandemise/*`, each a `dist/` folder) plus a few third-party
 * modules, two of them native (better-sqlite3, node-pty). A packaged app runs
 * it with Electron's own Node (`ELECTRON_RUN_AS_NODE`), so the result here is a
 * self-contained folder:
 *
 *   <out>/package.json            apps/daemon's, without dev fields
 *   <out>/dist/…                  apps/daemon/dist
 *   <out>/node_modules/@tandemise/<pkg>/{package.json,dist}
 *   <out>/node_modules/<dep>/…    exactly the installed copies the lockfile chose
 *
 * Only what the daemon reaches through `dependencies` (and installed optional
 * or peer dependencies) is copied, walked with Node's own resolution, so the
 * staged tree is the one the daemon already runs against in a checkout. Of
 * the native modules only the target's binaries are kept, and a load check
 * runs them under Electron's Node.
 *
 * Needs `npm ci && npm run build` first (it copies built `dist/` folders).
 *
 *   node apps/desktop/scripts/stage-daemon.mjs [--out <dir>] [--arch x64|arm64] [--platform linux|darwin|win32] [--no-smoke]
 *
 * electron-builder calls `stageDaemon` from its `afterPack` hook, once per
 * target arch, straight into the app's resources (see electron-builder.config.mjs).
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const desktop = dirname(dirname(fileURLToPath(import.meta.url)));
const root = dirname(dirname(desktop));

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

/** Source maps, declarations and compiled tests are build products the daemon never loads. */
function keepBuildFile(src) {
  const name = basename(src);
  return !(name.endsWith('.map') || name.endsWith('.d.ts') || name.endsWith('.test.js') || name.endsWith('.tsbuildinfo'));
}

/** Where `name` resolves from `fromDir`, the way Node would: the nearest node_modules up the tree. */
function resolvePackageDir(name, fromDir) {
  for (let dir = fromDir; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return candidate;
    if (dirname(dir) === dir) return null;
  }
}

/** A package.json reduced to what running the package needs. */
function runtimeManifest(manifest) {
  const { devDependencies: _dev, scripts: _scripts, ...rest } = manifest;
  return rest;
}

export async function stageDaemon({
  out = join(desktop, '.daemon-stage', `${process.platform}-${process.arch}`),
  platform = process.platform,
  arch = process.arch,
  smoke = true,
  log = (line) => console.log(`[stage-daemon] ${line}`),
} = {}) {
  const daemonDir = join(root, 'apps/daemon');
  if (!existsSync(join(daemonDir, 'dist/main.js'))) {
    throw new Error('apps/daemon/dist/main.js is missing. Run `npm ci && npm run build` at the repository root first.');
  }

  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  // Workspace packages are copied by name into <out>/node_modules; everything
  // under a workspace (or the root) keeps its place relative to it, so nested
  // node_modules resolve exactly as they do in the checkout.
  const realRoot = realpathSync(root);
  const workspaceTargets = new Map([[realpathSync(daemonDir), out], [realRoot, out]]);
  const targetOf = (realDir) => {
    let best = null;
    for (const [base, target] of workspaceTargets) {
      if ((realDir === base || realDir.startsWith(base + sep)) && (best === null || base.length > best[0].length)) best = [base, target];
    }
    if (best === null) throw new Error(`${realDir} is outside the repository; cannot stage it.`);
    return join(best[1], relative(best[0], realDir));
  };
  const isWorkspace = (realDir) => {
    const rel = relative(realRoot, realDir);
    return !rel.startsWith('..') && !rel.split(sep).includes('node_modules');
  };

  const daemonManifest = readJson(join(daemonDir, 'package.json'));
  writeFileSync(join(out, 'package.json'), `${JSON.stringify(runtimeManifest(daemonManifest), null, 2)}\n`);
  cpSync(join(daemonDir, 'dist'), join(out, 'dist'), { recursive: true, filter: keepBuildFile });

  const seen = new Set([realpathSync(daemonDir)]);
  const queue = [{ dir: daemonDir, manifest: daemonManifest }];
  let workspaceCount = 0;
  let thirdPartyCount = 0;
  while (queue.length > 0) {
    const { dir, manifest } = queue.shift();
    const peers = manifest.peerDependencies ?? {};
    const optional = new Set([
      ...Object.keys(manifest.optionalDependencies ?? {}),
      ...Object.keys(peers),
    ]);
    const names = new Set([...Object.keys(manifest.dependencies ?? {}), ...optional]);
    for (const name of names) {
      const found = resolvePackageDir(name, dir);
      if (found === null) {
        if (optional.has(name)) continue;
        throw new Error(`${manifest.name} depends on ${name}, which is not installed. Run \`npm ci\`.`);
      }
      const real = realpathSync(found);
      if (seen.has(real)) continue;
      seen.add(real);
      const depManifest = readJson(join(real, 'package.json'));
      if (isWorkspace(real)) {
        const target = join(out, 'node_modules', name);
        workspaceTargets.set(real, target);
        mkdirSync(target, { recursive: true });
        writeFileSync(join(target, 'package.json'), `${JSON.stringify(runtimeManifest(depManifest), null, 2)}\n`);
        if (existsSync(join(real, 'dist'))) cpSync(join(real, 'dist'), join(target, 'dist'), { recursive: true, filter: keepBuildFile });
        workspaceCount++;
      } else {
        // The whole installed package, minus its own node_modules: those are
        // reached (or not) through the walk like everything else.
        cpSync(real, targetOf(real), {
          recursive: true,
          filter: (src) => src === real || !relative(real, src).split(sep).includes('node_modules'),
        });
        thirdPartyCount++;
      }
      queue.push({ dir: real, manifest: depManifest });
    }
  }
  log(`staged apps/daemon with ${workspaceCount} workspace packages and ${thirdPartyCount} third-party packages into ${relative(root, out)}`);

  selectNativeBinaries(out, platform, arch, log);
  if (smoke && platform === process.platform && arch === process.arch) smokeTest(out, log);
  else if (smoke) log(`skipped the load check: ${platform}-${arch} binaries cannot run on this ${process.platform}-${process.arch} machine`);
  return out;
}

/**
 * Keeps the one native binary each module loads on the target, and drops the rest.
 *
 * Both native modules are N-API addons (better-sqlite3 from 13, node-pty from
 * 1.0), so a binary is tied to an OS and a CPU, not to a Node ABI: the build
 * that runs under the system Node in a checkout also runs under Electron's
 * Node, and nothing has to be recompiled for Electron. What does have to be
 * right is the platform and arch, and the packages ship binaries for several:
 *
 * - better-sqlite3 loads `prebuilds/<platform>-<arch>.node`.
 * - node-pty loads `build/Release` first, then `prebuilds/<platform>-<arch>`.
 *   It has prebuilds for macOS and Windows; on Linux `npm ci` compiles it, so
 *   only a Linux build for the machine's own arch can be staged.
 */
function selectNativeBinaries(out, platform, arch, log) {
  const target = `${platform}-${arch}`;
  const sqlite = findStaged(out, 'better-sqlite3');
  if (sqlite === null) throw new Error('better-sqlite3 was not staged.');
  if (!existsSync(join(sqlite, 'prebuilds', `${target}.node`))) {
    throw new Error(`better-sqlite3 has no prebuilt binary for ${target} (looked in ${relative(out, join(sqlite, 'prebuilds'))}).`);
  }
  keepOnly(join(sqlite, 'prebuilds'), [`${target}.node`]);
  for (const dir of ['deps', 'src', 'build']) rmSync(join(sqlite, dir), { recursive: true, force: true });

  const pty = findStaged(out, 'node-pty');
  if (pty === null) throw new Error('node-pty was not staged.');
  const ptyPrebuild = join(pty, 'prebuilds', target);
  if (existsSync(ptyPrebuild)) {
    // A local compile (build/) would win over the prebuild and may be for another arch.
    rmSync(join(pty, 'build'), { recursive: true, force: true });
    keepOnly(join(pty, 'prebuilds'), [target]);
    // npm unpacks it without its execute bit; node-pty execs it for every PTY on macOS.
    if (existsSync(join(ptyPrebuild, 'spawn-helper'))) chmodSync(join(ptyPrebuild, 'spawn-helper'), 0o755);
  } else {
    if (platform !== process.platform || arch !== process.arch) {
      throw new Error(`node-pty has no prebuilt binary for ${target}, and the one \`npm ci\` compiled is for ${process.platform}-${process.arch}. Build ${target} on a ${target} machine.`);
    }
    if (!existsSync(join(pty, 'build', 'Release', 'pty.node'))) throw new Error('node-pty was not compiled (no build/Release/pty.node). Run `npm ci`.');
    rmSync(join(pty, 'prebuilds'), { recursive: true, force: true });
    keepOnly(join(pty, 'build'), ['Release']);
    keepOnly(join(pty, 'build', 'Release'), ['pty.node', 'spawn-helper']);
  }
  for (const dir of ['deps', 'src', 'third_party', 'scripts', 'bin', 'typings']) rmSync(join(pty, dir), { recursive: true, force: true });
  // Debug symbols for the Windows binaries: tens of megabytes nobody loads.
  removeMatching(pty, (name) => name.endsWith('.pdb'));
  log(`kept the ${target} binaries of better-sqlite3 and node-pty`);
}

/**
 * Loads both native modules from the staged tree with Electron's own Node -
 * the runtime the packaged daemon uses - and opens a database and a PTY.
 */
function smokeTest(out, log) {
  const electron = createRequire(join(desktop, 'package.json'))('electron');
  const sqlite = findStaged(out, 'better-sqlite3');
  const pty = findStaged(out, 'node-pty');
  const win = process.platform === 'win32';
  const script = `
    const Database = require(${JSON.stringify(sqlite)});
    const v = new Database(':memory:').prepare('select sqlite_version() as v').get().v;
    const pty = require(${JSON.stringify(pty)});
    const term = pty.spawn(${JSON.stringify(win ? 'cmd.exe' : '/bin/sh')}, ${JSON.stringify(win ? ['/c', 'echo pty-ok'] : ['-c', 'echo pty-ok'])}, {});
    let text = '';
    term.onData((d) => { text += d; });
    term.onExit(() => {
      if (!text.includes('pty-ok')) { console.error('the pty said ' + JSON.stringify(text)); process.exit(2); }
      console.log('Node ' + process.versions.node + ' (ABI ' + process.versions.modules + '), SQLite ' + v + ', a PTY ran');
      process.exit(0);
    });
    setTimeout(() => { console.error('the pty timed out'); process.exit(3); }, 15000);
  `;
  const run = spawnSync(electron, ['-e', script], { encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 30_000 });
  if (run.status !== 0) throw new Error(`the staged native modules did not load under Electron's Node: ${(run.stderr || run.stdout || String(run.error)).trim()}`);
  log(`load check under Electron's Node: ${run.stdout.trim()}`);
}

/** The staged copy of a third-party package, wherever the lockfile nested it. */
function findStaged(out, name) {
  const stack = [join(out, 'node_modules')];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!existsSync(dir)) continue;
    if (existsSync(join(dir, name, 'package.json'))) return join(dir, name);
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const child = join(dir, entry.name);
      if (entry.name.startsWith('@')) stack.push(child);
      else if (existsSync(join(child, 'node_modules'))) stack.push(join(child, 'node_modules'));
    }
  }
  return null;
}

function keepOnly(dir, names) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) if (!names.includes(entry)) rmSync(join(dir, entry), { recursive: true, force: true });
}

function removeMatching(dir, test) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) removeMatching(path, test);
    else if (test(entry.name)) rmSync(path, { force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  const option = (name) => {
    const at = args.indexOf(name);
    return at >= 0 ? args[at + 1] : undefined;
  };
  const out = option('--out');
  stageDaemon({
    out: out === undefined ? undefined : resolve(out),
    platform: option('--platform') ?? process.platform,
    arch: option('--arch') ?? process.arch,
    smoke: !args.includes('--no-smoke'),
  }).catch((error) => {
    console.error(`[stage-daemon] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
