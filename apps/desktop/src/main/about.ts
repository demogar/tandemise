import { app, Menu, shell, type AboutPanelOptionsOptions, type MenuItemConstructorOptions } from 'electron';
import { homedir, release, type } from 'node:os';
import {
  TANDEMISE_DOCS_URL,
  TANDEMISE_NEW_ISSUE_URL,
  TANDEMISE_REPOSITORY_URL,
  type AppAboutFacts,
} from '@tandemise/api-contract/about';

/**
 * Short git commit the app was built from, injected by electron-vite `define`
 * (see `electron.vite.config.ts`); `dev` when git was not available.
 */
export const APP_BUILD: string = typeof __TANDEMISE_BUILD__ === 'string' && __TANDEMISE_BUILD__ ? __TANDEMISE_BUILD__ : 'dev';

/** Must match NOTICE word for word. */
const COPYRIGHT = 'Copyright 2026 Demostenes Garcia G. and the Tandemise contributors';
const LICENSE = 'Licensed under the Apache License, Version 2.0';

function osDescription(): string {
  if (process.platform === 'darwin') return `macOS ${process.getSystemVersion()} (${process.arch})`;
  return `${type()} ${release()} (${process.arch})`;
}

/** What Settings → About shows for the app side, and what "Copy diagnostics" copies. */
export function appAboutFacts(): AppAboutFacts {
  return {
    version: app.getVersion(),
    build: APP_BUILD,
    electron: process.versions.electron ?? 'unknown',
    chrome: process.versions.chrome ?? 'unknown',
    node: process.versions.node,
    os: osDescription(),
    userHome: homedir(),
  };
}

/**
 * The native About panel (app menu → About Tandemise).
 *
 * On macOS the panel prints "Version <applicationVersion> (<version>)". Left
 * unset, `version` falls back to the running bundle's `CFBundleVersion` - in
 * development that is Electron's own bundle, so the panel read
 * "Version 0.5.0 (33.4.11)": a Tandemise version beside an Electron version,
 * which looks like a build number and is not one. `version` is our commit.
 * `website` is shown on Linux only, so the link is in `credits` too.
 */
export function aboutPanelOptions(iconPath: string): AboutPanelOptionsOptions {
  return {
    applicationName: 'Tandemise',
    applicationVersion: app.getVersion(),
    version: APP_BUILD === 'dev' ? 'dev build' : APP_BUILD,
    copyright: `${COPYRIGHT}\n${LICENSE}`,
    credits: `Source, documentation and issues:\n${TANDEMISE_REPOSITORY_URL}`,
    website: TANDEMISE_REPOSITORY_URL,
    iconPath,
  };
}

/**
 * The application menu: Electron's standard menus, with a Help menu that
 * points at Tandemise instead of Electron's own documentation and forums
 * (which is what the default menu's Help items open).
 */
export function installApplicationMenu(): void {
  const open = (url: string) => (): void => {
    void shell.openExternal(url);
  };
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' } as const] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'Documentation', click: open(TANDEMISE_DOCS_URL) },
        { label: 'Report an Issue', click: open(TANDEMISE_NEW_ISSUE_URL) },
        { type: 'separator' },
        { label: 'Tandemise on GitHub', click: open(TANDEMISE_REPOSITORY_URL) },
        // Off macOS there is no app menu, so About lives here.
        ...(process.platform === 'darwin' ? [] : [{ type: 'separator' } as const, { role: 'about' } as const]),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
