import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

/** Resolve against this file, not `process.cwd()`: the build must not depend on where npm was run. */
const here = (...segments: string[]): string => resolve(import.meta.dirname, ...segments);

/**
 * The short git commit this app is built from, shown in the About panel and in
 * Settings → About next to the version. `dev` when git is not available. The
 * daemon records the same value at `npm run build` (scripts/write-build-info.mjs),
 * so the two can be compared.
 */
function shortCommit(): string {
  try {
    const sha = execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], {
      cwd: here(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return /^[0-9a-f]{4,40}$/.test(sha) ? sha : 'dev';
  } catch {
    return 'dev';
  }
}

/**
 * Injected only into the production bundle. In dev the policy arrives as a
 * response header (see `applyContentSecurityPolicy`), but `file://` loads have
 * no headers at all, so a packaged app would otherwise run with no CSP.
 */
const PRODUCTION_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src http://127.0.0.1:* ws://127.0.0.1:* http://localhost:* ws://localhost:*",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join('; ');

function injectCsp() {
  return {
    name: 'tandemise-csp',
    apply: 'build' as const,
    transformIndexHtml(html: string): string {
      return html.replace(
        '</title>',
        `</title>\n    <meta http-equiv="Content-Security-Policy" content="${PRODUCTION_CSP}" />`,
      );
    },
  };
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    define: { __TANDEMISE_BUILD__: JSON.stringify(shortCommit()) },
    build: { outDir: here('dist/main'), rollupOptions: { input: here('src/main/index.ts') } },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: here('dist/preload'),
      rollupOptions: {
        input: here('src/preload/index.ts'),
        // A sandboxed preload is evaluated as CommonJS - Electron has no module
        // loader inside the sandbox - so an ESM bundle fails outright with
        // "Cannot use import statement outside a module" and the renderer comes
        // up with no bridge at all. `.cjs` because the package is `type: module`.
        output: { format: 'cjs', entryFileNames: 'index.cjs' },
      },
    },
  },
  renderer: {
    root: here('src/renderer'),
    plugins: [react(), injectCsp()],
    resolve: { alias: { '@': here('src/renderer/src') } },
    build: {
      outDir: here('dist/renderer'),
      rollupOptions: { input: here('src/renderer/index.html') },
    },
  },
});
