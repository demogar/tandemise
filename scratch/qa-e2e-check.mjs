/**
 * The QA role's real path (MVP.md acceptance criterion 11): start the
 * repository's dev server, drive the running application through the browser
 * tools, and produce the evidence a QAReport would cite.
 *
 * Runs against the Taskly demo repository, which is a real app with a real
 * server and a real UI - not a fixture page.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

const APP = '/Users/you/projects/tandemise-demo-app';
const PORT = 4399;
const URL = `http://localhost:${PORT}`;
const out = mkdtempSync(join(tmpdir(), 'tandemise-qa-'));

let bad = 0;
const ok = (n, c, d='') => { if (c) console.log(`  ok   ${n}${d?'  '+d:''}`); else { bad++; console.log(`  FAIL ${n}${d?'  '+d:''}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('── start the application under test');
const server = spawn('node', ['src/server.js'], {
  cwd: APP, env: { ...process.env, PORT: String(PORT) }, stdio: 'pipe',
});
let ready = false;
const deadline = Date.now() + 20_000;
while (Date.now() < deadline && !ready) {
  try { const r = await fetch(`${URL}/api/tasks`); ready = r.ok; } catch { await sleep(250); }
}
ok('dev server is serving', ready, URL);

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

try {
  console.log('\n── acceptance criterion: a user can see their tasks');
  const res = await page.goto(URL, { waitUntil: 'networkidle' });
  ok('the page loads', res?.status() === 200, `HTTP ${res?.status()}`);
  ok('the app renders its title', (await page.textContent('h1'))?.trim() === 'Taskly');
  await page.waitForSelector('#tasks li', { timeout: 5000 });
  const initial = await page.locator('#tasks li').count();
  ok('seeded tasks are listed', initial === 2, `${initial} tasks`);
  ok('the stats line reports progress', /0 of 2 done/.test((await page.textContent('#stats')) ?? ''), await page.textContent('#stats'));

  console.log('\n── acceptance criterion: a user can add a task');
  await page.fill('#title', 'Verified by Tandemise QA');
  await page.click('button[type="submit"]');
  await page.waitForFunction((n) => document.querySelectorAll('#tasks li').length === n, initial + 1, { timeout: 5000 });
  ok('the new task appears', (await page.locator('#tasks li').count()) === initial + 1);
  ok('it shows the text the user typed', (await page.textContent('#tasks li:last-child span')) === 'Verified by Tandemise QA');

  console.log('\n── acceptance criterion: a user can complete a task');
  await page.click('#tasks li:last-child input[type="checkbox"]');
  await page.waitForFunction(() => /1 of 3 done/.test(document.getElementById('stats')?.textContent ?? ''), null, { timeout: 5000 });
  ok('stats update after completing', /1 of 3 done/.test((await page.textContent('#stats')) ?? ''), await page.textContent('#stats'));
  ok('the completed task is struck through', await page.locator('#tasks li:last-child').evaluate((el) => el.classList.contains('done')));

  console.log('\n── evidence capture');
  const shot = await page.screenshot({ fullPage: true });
  const shotPath = join(out, 'taskly-after-complete.png');
  writeFileSync(shotPath, shot);
  ok('screenshot captured as artifact evidence', shot.length > 5000, `${shot.length} bytes → ${shotPath}`);

  const aria = await page.locator('body').ariaSnapshot();
  writeFileSync(join(out, 'taskly.aria.txt'), aria);
  ok('accessibility snapshot is semantic, not pixels', aria.includes('button') && aria.includes('textbox'));
  console.log('\n  --- accessibility tree ---');
  console.log(aria.split('\n').slice(0, 12).map((l) => '  ' + l).join('\n'));

  console.log('\n── accessibility checks the QA role would run');
  const a11y = await page.evaluate(() => {
    const findings = [];
    for (const img of document.querySelectorAll('img')) if (!img.alt) findings.push('image without alt text');
    for (const c of document.querySelectorAll('input,select,textarea')) {
      const labelled = c.getAttribute('aria-label') || c.getAttribute('aria-labelledby')
        || (c.id && document.querySelector(`label[for="${c.id}"]`));
      if (!labelled) findings.push(`form control without a label: ${c.outerHTML.slice(0, 60)}`);
    }
    for (const b of document.querySelectorAll('button')) {
      if (!b.textContent?.trim() && !b.getAttribute('aria-label')) findings.push('button without an accessible name');
    }
    const h = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].map((e) => +e.tagName[1]);
    for (let i = 1; i < h.length; i++) if (h[i] - h[i-1] > 1) findings.push(`heading level jumps from h${h[i-1]} to h${h[i]}`);
    return findings;
  });
  ok('no accessibility findings on the primary flow', a11y.length === 0, a11y.join('; ') || 'clean');

  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.reload({ waitUntil: 'networkidle' });
  ok('no console errors on load', errors.length === 0, errors.join('; ') || 'clean');

} finally {
  await browser.close();
  server.kill('SIGTERM');
  await sleep(300);
  if (!server.killed) server.kill('SIGKILL');
}

console.log(`\n${'─'.repeat(60)}`);
console.log(bad === 0 ? 'ALL QA CHECKS PASSED — real app, real browser, real evidence' : `${bad} FAILED`);
console.log(`evidence: ${out}`);
process.exit(bad === 0 ? 0 : 1);
