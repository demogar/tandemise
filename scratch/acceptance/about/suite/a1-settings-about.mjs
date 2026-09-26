// A1 — Settings → About shows which code is running: the app and the daemon with
// their version and commit, the daemon's state and uptime, the database schema,
// the data folder with Show in Finder, Electron and the OS, and the links.
import { copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { context } from '../../p0/lib/ctx.mjs';
import { Evidence } from '../../p0/lib/evidence.mjs';
import { aboutRows, aboutText, appVersion, gitSha, openAbout, repoRoot } from '../common.mjs';

const c = await context();
const ev = new Evidence('A1', 'Settings → About shows versions, builds, schema and the data folder');
await openAbout(c);
const rows = await aboutRows(c);
const text = await aboutText(c);
const system = await c.api.get('/v1/system');
const migrated = c.sql('SELECT MAX(version) AS v FROM schema_migrations')[0].v;

ev.check('the section is titled About, with the app version in its header', text.startsWith('About') && text.includes(`${appVersion} (${gitSha})`), text.split('\n').slice(0, 2));
ev.check(`App reads "${appVersion} (${gitSha})"`, rows.App === `${appVersion} (${gitSha})`, rows.App);
ev.check(`Daemon reads "${system.daemonVersion} (${gitSha})"`, rows.Daemon === `${system.daemonVersion} (${gitSha})`, rows.Daemon);
ev.check('Daemon status reads Running, an uptime and the process id', /^Running · up (under a minute|\d+m|\d+h \d+m) · process \d+$/.test(rows['Daemon status'] ?? '') && rows['Daemon status'].endsWith(`process ${c.env.pid}`), rows['Daemon status']);
ev.check('Database schema reads the migration number', rows['Database schema'] === `Version ${migrated}`, { row: rows['Database schema'], migrated });
ev.check('proof (API + SQL): /v1/system agrees with the database', system.schemaVersion === migrated && system.daemonBuild === gitSha, { schemaVersion: system.schemaVersion, daemonBuild: system.daemonBuild });
ev.check('Data folder is this run\'s TANDEMISE_HOME, with Show in Finder', rows['Data folder'] === `${c.env.home} Show in Finder`, rows['Data folder']);
ev.check('Electron row has Electron, Chromium and Node versions', /^\d+\.\d+\.\d+ \(Chromium [\d.]+, Node [\d.]+\)$/.test(rows.Electron ?? ''), rows.Electron);
ev.check('Operating system names macOS and the architecture', /^macOS [\d.]+ \((arm64|x64)\)$/.test(rows['Operating system'] ?? ''), rows['Operating system']);
ev.check('no mismatch warning when both halves are this build', !text.includes('different code') && !text.includes('different versions'));
ev.check('links: Repository, Documentation, Report an issue, and Copy diagnostics', ['Repository', 'Documentation', 'Report an issue', 'Copy diagnostics'].every((l) => text.includes(l)), text);
ev.check('says what the copied text holds and that it has no tokens', text.includes('never tokens or settings'));
const shot = await c.page.screenshot(ev.shot('settings-about'));
copyFileSync(shot, join(repoRoot, 'apps/desktop/screenshots/31-settings-about.png'));
ev.note('screenshot copied to apps/desktop/screenshots/31-settings-about.png for the guide');
c.close(); ev.save();
