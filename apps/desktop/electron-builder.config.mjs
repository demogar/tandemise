/**
 * Packaging for the desktop app (electron-builder).
 *
 *   npm run build                                  # the workspace, daemon included
 *   npm run -w @tandemise/desktop package          # this platform's installers
 *   npm run -w @tandemise/desktop package -- --linux AppImage   # one target
 *
 * The app carries its own daemon in `resources/daemon`, staged per target arch
 * by `afterPack` (scripts/stage-daemon.mjs), and runs it on Electron's own
 * Node with ELECTRON_RUN_AS_NODE - so the `runAsNode` fuse must stay enabled.
 * Installers land in `apps/desktop/release/`.
 *
 * Signing is opt-in through the environment and skipped when it is absent:
 * - macOS: CSC_LINK + CSC_KEY_PASSWORD (Developer ID Application .p12), and for
 *   notarization APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID.
 * - Windows: WIN_CSC_LINK + WIN_CSC_KEY_PASSWORD (Authenticode .pfx).
 * See CONTRIBUTING.md, "Packaging the desktop app".
 */
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { stageDaemon } from './scripts/stage-daemon.mjs';

const here = import.meta.dirname;
const require = createRequire(import.meta.url);
const ARCH_NAME = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' };

const notarize = Boolean(process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID);

/** @type {import('electron-builder').Configuration} */
export default {
  appId: 'dev.tandemise.desktop',
  productName: 'Tandemise',
  executableName: 'tandemise',
  copyright: 'Copyright © Tandemise contributors',
  directories: { output: 'release', buildResources: 'build' },
  artifactName: '${productName}-${version}-${os}-${arch}.${ext}',
  // The installed Electron, exactly: package.json holds a range (the lockfile pins it).
  electronVersion: require('electron/package.json').version,

  // Everything the main process and the renderer need is bundled by
  // electron-vite into dist/, so the app ships no node_modules of its own.
  files: ['dist/**/*', 'build/icon.png', 'resources/**/*', 'package.json', '!**/*.map', '!node_modules/**/*'],
  npmRebuild: false,
  asar: true,

  // The daemon goes in after the app is laid out and before anything is
  // signed, straight into the resources folder. (Not `extraResources`: its
  // file matcher drops node_modules, which the daemon cannot run without.)
  afterPack: async (context) => {
    const platform = context.electronPlatformName;
    const arch = ARCH_NAME[context.arch];
    const resources = platform === 'darwin'
      ? join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
      : join(context.appOutDir, 'resources');
    await stageDaemon({ out: join(resources, 'daemon'), platform, arch });
  },

  mac: {
    target: [{ target: 'dmg', arch: ['arm64', 'x64'] }],
    category: 'public.app-category.developer-tools',
    icon: 'build/icon.icns',
    hardenedRuntime: true,
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',
    // No CSC_LINK: an ad-hoc signature (Apple Silicon will not run an app
    // with none) rather than a failed build. Gatekeeper still warns on it.
    ...(process.env.CSC_LINK ? {} : { identity: '-' }),
    notarize,
  },
  dmg: { artifactName: '${productName}-${version}-mac-${arch}.${ext}' },

  linux: {
    target: [{ target: 'AppImage', arch: ['x64'] }, { target: 'deb', arch: ['x64'] }],
    category: 'Development',
    syncDesktopName: true,
    icon: 'build/icon.png',
    maintainer: 'Tandemise contributors <tandemise@users.noreply.github.com>',
    synopsis: 'A local-first desktop OS for running a software company with AI workers.',
  },

  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    icon: 'build/icon.png',
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    artifactName: '${productName}-${version}-win-${arch}-setup.${ext}',
  },

  publish: null,
};
