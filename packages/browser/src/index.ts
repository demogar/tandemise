export { DomainAllowlist } from './allowlist.js';

export { BrowserProfileManager, profileDirectory } from './profiles.js';
export type { ProfileLaunchOptions } from './profiles.js';

export { BrowserSession } from './session.js';
export type {
  BlockedEntry, BrowserSessionOptions, ConsoleEntry, NetworkEntry,
} from './session.js';

export { BrowserSessionManager } from './session-manager.js';

export { BROWSER_OPTIONS, browserConfigSchema, browserOptionsFrom } from './options.js';
export type { BrowserConfig, BrowserOptions } from './options.js';

export { runA11yChecks } from './a11y.js';
export type { A11yFinding, A11yImpact, A11yReport } from './a11y.js';

export { DevServerController } from './dev-server.js';
export type { DevServerHandle, DevServerSpec } from './dev-server.js';

export { browserTools } from './tools.js';

export { BROWSER_PROVIDER_ID, BrowserIntegrationProvider, INSTALL_HINT } from './provider.js';

export {
  BROWSER_PROFILE_MANAGER, BROWSER_SESSION_MANAGER, DEV_SERVER_CONTROLLER,
  browserIntegrationModule,
} from './module.js';
