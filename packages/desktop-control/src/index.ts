export {
  HELPER_OPS, accessibilityNodeSchema, helperResponseSchema, toErrorCode,
} from './protocol.js';
export type {
  AccessibilityNode, ActivateResult, ClickResult, DesktopWindow, FindResult, HelperOp,
  HelperRequest, HelperResponse, InspectResult, InstalledApp, LaunchResult, ListAppsResult,
  ListInstalledAppsResult, PermissionsResult, PingResult, Point, RequestPermissionsResult,
  RunningApp, ScreenshotResult, ShortcutResult, Size, TypeResult, WindowsResult,
} from './protocol.js';

export { LineAssembler } from './spawn.js';
export type { HelperProcess, HelperReadable, HelperWritable, SpawnHelper } from './spawn.js';

export { MacOSHelperClient } from './client.js';
export type { MacOSHelperClientOptions } from './client.js';

export {
  DESKTOP_CAPABILITY, allowedApps, assertAppAllowed, bundleIdInScope, hasUnrestrictedAppScope,
} from './allowlist.js';

export { DEFAULT_DESKTOP_CONFIG, desktopConfigSchema } from './config.js';
export type { DesktopConfig } from './config.js';

export { desktopTools } from './tools.js';
export type { DesktopToolDeps } from './tools.js';

export { DESKTOP_PROVIDER_ID, DesktopIntegrationProvider } from './provider.js';

export {
  HELPER_BINARY_PATH, HELPER_BINARY_RELATIVE_PATH, HELPER_SPAWN, MACOS_HELPER_CLIENT,
} from './tokens.js';

export { desktopControlModule } from './module.js';
