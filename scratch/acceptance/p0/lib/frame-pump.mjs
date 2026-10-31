// Keeps an acceptance window painting on a machine whose display is idle (opt-in).
//
// Once the compositor stops driving a window (a locked or sleeping display), Chromium produces no frames, and a
// clipped `Page.captureScreenshot` — hold's `paint`, which xterm's rows wait on — never answers, so a scenario
// stalls. While it runs, this asks every page on the given CDP ports for a tiny screenshot once a second, which
// makes Chromium produce one. It changes nothing in the app.
//
// In a run-all, after the window is spawned:
//
//   import { keepPainting } from '../p0/lib/frame-pump.mjs';
//   keepPainting([PORT]);
//
// It does nothing unless asked: pass --keep-painting to the run-all, or set ACCEPTANCE_KEEP_PAINTING=1. The pump
// is a separate process that ends with the run-all that started it.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(import.meta.url);

/** Whether this run asked for it. */
export const keepPaintingAsked = () => process.argv.includes('--keep-painting') || process.env.ACCEPTANCE_KEEP_PAINTING === '1';

/** Starts the pump for `ports` when asked; returns its pid, or null. */
export function keepPainting(ports) {
  if (!keepPaintingAsked()) return null;
  const child = spawn(process.execPath, [SCRIPT, '--pump', String(process.pid), ...ports.map(String)], { stdio: 'ignore', detached: true });
  child.unref();
  console.log(`(keeping the window${ports.length === 1 ? '' : 's'} on ${ports.join(', ')} painting)`);
  return child.pid;
}

// ------------------------------------------------------------------ the pump itself
if (process.argv[1] === SCRIPT && process.argv[2] === '--pump') {
  const parent = Number(process.argv[3]);
  const ports = process.argv.slice(4).map(Number);
  const open = new Map();
  const alive = () => { try { process.kill(parent, 0); return true; } catch { return false; } };
  const socketFor = async (url) => {
    if (open.has(url)) return open.get(url);
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; setTimeout(reject, 3000); });
    ws.onclose = () => open.delete(url);
    ws.onmessage = () => {};
    open.set(url, ws);
    return ws;
  };
  let id = 0;
  while (alive()) {
    for (const port of ports) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(1000) })).json();
        for (const t of list.filter((x) => x.type === 'page' && !x.url.startsWith('devtools://'))) {
          (await socketFor(t.webSocketDebuggerUrl)).send(JSON.stringify({ id: ++id, method: 'Page.captureScreenshot', params: { format: 'jpeg', quality: 1 } }));
        }
      } catch { /* no window on this port yet, or it closed */ }
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  process.exit(0);
}
