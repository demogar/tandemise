import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { OAuthCallback, OAuthCallbackListener, OAuthCallbackPort } from '@tandemise/application';

const CALLBACK_PATH = '/callback';

/**
 * Loopback redirect listeners for connecting accounts (RFC 8252 §7.3).
 *
 * One listener per connect attempt, on 127.0.0.1 and a port the OS picks, gone
 * when the attempt settles. It is deliberately not a route on the daemon's API
 * server: every API route requires the desktop's bearer token, which a browser
 * redirect cannot carry, and adding an unauthenticated route there would widen
 * a surface whose whole security story is "nothing but health is open".
 *
 * The listener answers only `GET /callback`. Which request actually completes
 * the attempt is the connect flow's decision, made by checking the state it
 * issued - so a stray request to this port can neither finish nor end one.
 */
export const oauthCallbacks: OAuthCallbackPort = {
  async open(): Promise<OAuthCallbackListener> {
    const queue: OAuthCallback[] = [];
    const waiters: ((callback: OAuthCallback) => void)[] = [];

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (req.method !== 'GET' || url.pathname !== CALLBACK_PATH) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found');
        return;
      }
      let answered = false;
      const callback: OAuthCallback = {
        params: url.searchParams,
        respond: (outcome) => {
          if (answered) return;
          answered = true;
          res.writeHead(outcome.ok ? 200 : 400, {
            'content-type': 'text/html; charset=utf-8',
            // The page is static text; nothing on it should run or be framed.
            'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
            'x-frame-options': 'DENY',
            'cache-control': 'no-store',
            'referrer-policy': 'no-referrer',
          }).end(page(outcome));
        },
      };
      const waiter = waiters.shift();
      if (waiter === undefined) queue.push(callback);
      else waiter(callback);
    });
    // A tab left open must not keep the daemon from exiting.
    server.unref();

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    const { port } = server.address() as AddressInfo;

    return {
      redirectUri: `http://127.0.0.1:${port}${CALLBACK_PATH}`,
      next: (signal) => new Promise<OAuthCallback>((resolve, reject) => {
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        const queued = queue.shift();
        if (queued !== undefined) {
          resolve(queued);
          return;
        }
        const waiter = (callback: OAuthCallback): void => {
          signal.removeEventListener('abort', onAbort);
          resolve(callback);
        };
        const onAbort = (): void => {
          const index = waiters.indexOf(waiter);
          if (index !== -1) waiters.splice(index, 1);
          reject(signal.reason);
        };
        waiters.push(waiter);
        signal.addEventListener('abort', onAbort, { once: true });
      }),
      close: () => {
        for (const pending of queue.splice(0)) {
          pending.respond({ ok: false, title: 'Expired', message: 'This connection attempt is over. Start again from Tandemise.' });
        }
        server.closeAllConnections();
        server.close();
      },
    };
  },
};

function page(outcome: { ok: boolean; title: string; message: string }): string {
  const mark = outcome.ok ? '✓' : '!';
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escape(outcome.title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
    font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: Canvas; color: CanvasText; }
  main { max-width: 420px; padding: 32px; text-align: center; }
  .mark { width: 44px; height: 44px; margin: 0 auto 16px; border-radius: 50%; display: grid; place-items: center;
    font-size: 22px; color: #fff; background: ${outcome.ok ? '#1f9d55' : '#c2410c'}; }
  h1 { font-size: 18px; margin: 0 0 6px; }
  p { margin: 0; opacity: .75; }
</style></head><body><main><div class="mark">${mark}</div><h1>${escape(outcome.title)}</h1><p>${escape(outcome.message)}</p></main></body></html>`;
}

function escape(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
