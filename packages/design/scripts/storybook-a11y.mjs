#!/usr/bin/env node
// Runs axe on every story and docs page of the built Storybook, in light and
// in dark, in headless Chrome, and fails on any violation. It also fails when a
// story does not render or its play function (an interaction test: the Dialog
// focus trap, the Tabs arrow keys...) throws, so the interaction tests run in
// CI too.
//
//   npm run -w @tandemise/design storybook:build
//   npm run -w @tandemise/design storybook:a11y                # every entry
//   npm run -w @tandemise/design storybook:a11y -- button      # entries whose id contains "button"
//
// No browser library: it drives a locally installed Chrome or Chromium over the
// DevTools protocol (Node's own WebSocket) and injects axe-core, which
// @storybook/addon-a11y already installs. Set CHROME_PATH to pick the browser.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkg = dirname(dirname(fileURLToPath(import.meta.url)));
const STATIC = join(pkg, 'storybook-static');
const THEMES = ['light', 'dark'];
const filter = process.argv.slice(2).find((arg) => !arg.startsWith('-'));

// Rules that judge a whole page, not a component shown on its own.
const PAGE_RULES = ['region', 'landmark-one-main', 'page-has-heading-one'];

// On a docs page, the examples (.docs-story) are checked on their own as
// stories, and the args table is Storybook's UI, not the package's. What is
// left is the page itself: an MDX foundations page, the prose of the others.
const DOCS_EXCLUDE = ['.docs-story', '.docblock-argstable'];

/**
 * Violations already known and tracked, reported but not failed on, so the
 * check catches every new one. Each is a finding about the design system
 * itself; remove the entry in the change that fixes it.
 */
const KNOWN = [
  {
    theme: 'light',
    rule: 'color-contrast',
    node: /badge|btn--danger|tab__count/,
    why: 'light theme: --status-{pending,blocked,failed,succeeded} text on its -soft wash (badge, StatusPill, danger button) measures 3.9-4.5:1 and --text-tertiary on --surface-active (.tab__count) 4.4:1, under the 4.5:1 AA needs at --fs-xs. CONTRAST_PAIRS measures the status roles on plain --surface only.',
  },
];
const known = (theme, rule, node) => KNOWN.find((k) => k.theme === theme && k.rule === rule && k.node.test(node));

if (!existsSync(join(STATIC, 'index.json'))) {
  console.error('storybook-a11y: storybook-static/ is missing - run `npm run -w @tandemise/design storybook:build` first');
  process.exit(1);
}
const axeSource = readFileSync(createRequire(join(pkg, 'package.json')).resolve('axe-core/axe.min.js'), 'utf8');

// ------------------------------------------------------------ static server

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const server = createServer((req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
  let file = join(STATIC, path);
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
  if (!file.startsWith(STATIC) || !existsSync(file)) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

// ------------------------------------------------------------------ browser

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const candidates = [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ];
  const found = candidates.find((path) => existsSync(path));
  if (!found) {
    console.error('storybook-a11y: no Chrome or Chromium found - set CHROME_PATH');
    process.exit(1);
  }
  return found;
}

const profile = mkdtempSync(join(tmpdir(), 'tandemise-a11y-'));
const chrome = spawn(findChrome(), ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--window-size=1280,900', 'about:blank'], {
  stdio: ['ignore', 'ignore', 'pipe'],
});
const cleanup = () => {
  try {
    chrome.kill('SIGKILL');
  } catch {
    /* already gone */
  }
  server.close();
  try {
    rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* chrome may still be writing its profile; the OS temp dir clears it */
  }
};
process.on('exit', cleanup);

const wsUrl = await new Promise((resolve, reject) => {
  let buffer = '';
  chrome.stderr.on('data', (chunk) => {
    buffer += chunk;
    const match = buffer.match(/DevTools listening on (ws:\/\/\S+)/);
    if (match) resolve(match[1]);
  });
  chrome.on('exit', (code) => reject(new Error(`chrome exited (${code}) before it was ready:\n${buffer}`)));
  setTimeout(() => reject(new Error('chrome did not start in 30s')), 30_000);
});

const socket = new WebSocket(wsUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});
let nextId = 0;
const pending = new Map();
/** Console errors and uncaught exceptions on the page since the last navigation. */
const pageErrors = [];
const waiters = [];
socket.addEventListener('message', (event) => {
  const message = JSON.parse(String(event.data));
  if (message.id !== undefined && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
  } else if (message.method) {
    // Storybook logs a failed play-function assertion with console.error
    // rather than failing the render, so every console error is a failure.
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      pageErrors.push(message.params.args.map((a) => a.value ?? a.description).join(' '));
    } else if (message.method === 'Runtime.exceptionThrown') {
      pageErrors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
    }
    for (const waiter of [...waiters]) if (waiter.method === message.method && waiter.sessionId === message.sessionId) waiter.resolve(message.params);
  }
});
const send = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });

const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
await send('Page.enable', {}, sessionId);
await send('Runtime.enable', {}, sessionId);
// Motion off: the pulse and the dialog's entrance would otherwise be measured mid-animation.
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] }, sessionId);

const evaluate = async (expression) => {
  const { result, exceptionDetails } = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
  return result.value;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function load(url) {
  const loaded = new Promise((resolve) => {
    const waiter = { method: 'Page.loadEventFired', sessionId, resolve: () => (waiters.splice(waiters.indexOf(waiter), 1), resolve()) };
    waiters.push(waiter);
  });
  await send('Page.navigate', { url }, sessionId);
  await loaded;
}

/** Waits for a story to finish rendering and playing, or for a docs page to draw. Returns the render phase. */
async function settle(kind) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    // A story is done at "finished" (after its play function and afterEach);
    // a play function that threw leaves Storybook's error display up.
    const state = await evaluate(`(() => {
      if (${JSON.stringify(kind)} === 'docs') return document.querySelector('#storybook-docs .sbdocs-content') ? 'finished' : 'rendering';
      const phase = window.__STORYBOOK_PREVIEW__?.currentRender?.phase ?? 'loading';
      if (phase === 'finished' && document.body.classList.contains('sb-show-errordisplay')) return 'errored';
      return phase;
    })()`);
    if (['finished', 'aborted', 'errored'].includes(state)) {
      await sleep(kind === 'docs' ? 600 : 150);
      return state;
    }
    await sleep(100);
  }
  return 'timeout';
}

// --------------------------------------------------------------------- run

const index = JSON.parse(readFileSync(join(STATIC, 'index.json'), 'utf8'));
const entries = Object.values(index.entries).filter((entry) => !filter || entry.id.includes(filter));
const failures = [];
const knownHits = new Map();
let checked = 0;

for (const theme of THEMES) {
  let themeViolations = 0;
  for (const entry of entries) {
    const kind = entry.type === 'docs' ? 'docs' : 'story';
    const url = `${base}/iframe.html?id=${encodeURIComponent(entry.id)}&viewMode=${kind}&globals=theme:${theme}`;
    pageErrors.length = 0;
    await load(url);
    const phase = await settle(kind);
    if (phase === 'errored' || phase === 'timeout' || pageErrors.length > 0) {
      const error = pageErrors[0] ?? (await evaluate(`document.querySelector('#error-message')?.textContent ?? ''`).catch(() => ''));
      const plain = String(error).replace(/\u001b\[\d+m/g, '').trim().split('\n').slice(0, 6).join(' / ');
      failures.push(`${theme}  ${entry.id}  ${phase === 'timeout' ? 'did not finish rendering in 20s' : `render or play function failed: ${plain}`}`);
      continue;
    }
    const context = kind === 'docs' ? { include: [['#storybook-docs']], exclude: DOCS_EXCLUDE.map((selector) => [selector]) } : { include: [['#storybook-root']] };
    await evaluate(`window.axe ? undefined : (0, eval)(${JSON.stringify(axeSource)})`);
    const violations = await evaluate(`axe.run(${JSON.stringify(context)}, {
      resultTypes: ['violations'],
      rules: Object.fromEntries(${JSON.stringify(PAGE_RULES)}.map((id) => [id, { enabled: false }])),
    }).then((r) => r.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.map((n) => ({ target: n.target.join(' '), html: n.html.slice(0, 160) })) })))`);
    checked++;
    for (const v of violations) {
      const fresh = [];
      for (const node of v.nodes) {
        const match = known(theme, v.id, `${node.target} ${node.html}`);
        if (match) knownHits.set(match, (knownHits.get(match) ?? 0) + 1);
        else fresh.push(node.target);
      }
      if (fresh.length === 0) continue;
      themeViolations++;
      failures.push(`${theme}  ${entry.id}  [${v.impact}] ${v.id}: ${v.help}\n      ${fresh.slice(0, 4).join('\n      ')}`);
    }
  }
  console.log(`${theme}: ${entries.length} entries, ${themeViolations} violation(s)`);
}

socket.close();
for (const [entry, count] of knownHits) console.log(`known (not failed on): ${count} node(s), ${entry.rule} - ${entry.why}`);
if (failures.length) {
  console.error(`\nstorybook-a11y: ${failures.length} problem(s)\n`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}
console.log(`storybook-a11y-ok (${checked} renders, ${entries.length} entries x ${THEMES.length} themes, 0 violations)`);
process.exit(0);
