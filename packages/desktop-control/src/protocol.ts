import type { ErrorCode } from '@tandemise/shared';
import { z } from 'zod';

/**
 * The newline-delimited JSON protocol spoken by `native/macos-helper`.
 *
 * The helper is a separate process on purpose (MVP.md §33): the Swift that has
 * to exist for the Accessibility, CGEvent and ScreenCaptureKit APIs lives
 * entirely behind a text protocol, so nothing in the TypeScript core links a
 * native library, and the whole native surface is testable by piping JSON.
 */
export const HELPER_OPS = [
  'ping', 'permissions', 'requestPermissions', 'listApps', 'listInstalledApps',
  'launch', 'activate', 'windows', 'inspect', 'find', 'click', 'type',
  'shortcut', 'screenshot', 'shutdown',
] as const;
export type HelperOp = (typeof HELPER_OPS)[number];

export interface HelperRequest {
  readonly id: string;
  readonly op: HelperOp;
  readonly params?: Readonly<Record<string, unknown>>;
}

/**
 * Responses arrive from a subprocess, which is a trust boundary like any other:
 * the envelope is parsed, never asserted.
 */
export const helperResponseSchema = z.object({
  id: z.string(),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      details: z.record(z.unknown()).optional(),
    })
    .optional(),
});
export type HelperResponse = z.infer<typeof helperResponseSchema>;

/**
 * The helper's codes are a subset of `ErrorCode` by construction, with one
 * exception: `UNSUPPORTED` ("this element has no press action") has no direct
 * equivalent and reads as a precondition failure on the caller's side.
 */
export function toErrorCode(helperCode: string): ErrorCode {
  switch (helperCode) {
    case 'PERMISSION_DENIED':
    case 'NOT_FOUND':
    case 'VALIDATION':
    case 'TIMEOUT':
    case 'PRECONDITION_FAILED':
    case 'TARGET_UNAVAILABLE':
    case 'INTERNAL':
      return helperCode;
    case 'UNSUPPORTED':
      return 'PRECONDITION_FAILED';
    default:
      return 'INTEGRATION_FAILED';
  }
}

const point = z.object({ x: z.number(), y: z.number() }).nullable();
const size = z.object({ width: z.number(), height: z.number() }).nullable();

export type Point = NonNullable<z.infer<typeof point>>;
export type Size = NonNullable<z.infer<typeof size>>;

/**
 * One accessibility element. Every field except `role` can legitimately be
 * absent - which of `title`, `label` and `value` carries the human-visible text
 * is entirely up to the application.
 */
export interface AccessibilityNode {
  readonly role: string | null;
  readonly subrole: string | null;
  readonly title: string | null;
  readonly label: string | null;
  readonly value: string | null;
  readonly identifier: string | null;
  readonly enabled: boolean | null;
  readonly focused: boolean | null;
  readonly position: Point | null;
  readonly size: Size | null;
  /** Slash-separated child indices from the inspected root; the handle `click` accepts. */
  readonly path?: string;
  readonly children?: readonly AccessibilityNode[];
  /** Set when the node's subtree was cut short by the depth or node budget. */
  readonly truncated?: boolean;
  readonly childCount?: number;
}

const nodeFields = {
  role: z.string().nullable(),
  subrole: z.string().nullable(),
  title: z.string().nullable(),
  label: z.string().nullable(),
  value: z.string().nullable(),
  identifier: z.string().nullable(),
  enabled: z.boolean().nullable(),
  focused: z.boolean().nullable(),
  position: point,
  size: size,
  path: z.string().optional(),
  truncated: z.boolean().optional(),
  childCount: z.number().optional(),
};

export const accessibilityNodeSchema: z.ZodType<AccessibilityNode> = z.lazy(() =>
  z.object({ ...nodeFields, children: z.array(accessibilityNodeSchema).optional() }),
);

/** A node that is a leaf by construction - `find` and `click` never nest. */
export const flatNodeSchema = z.object(nodeFields);

export const pingResultSchema = z.object({
  version: z.string(),
  pid: z.number(),
  macOS: z.string(),
  operations: z.array(z.string()),
});
export type PingResult = z.infer<typeof pingResultSchema>;

export const permissionsResultSchema = z.object({
  accessibility: z.boolean(),
  screenRecording: z.boolean(),
  screenLocked: z.boolean(),
  executablePath: z.string(),
  hints: z.object({ accessibility: z.string(), screenRecording: z.string() }),
});
export type PermissionsResult = z.infer<typeof permissionsResultSchema>;

export const requestPermissionsResultSchema = z.object({
  accessibility: z.boolean(),
  screenRecording: z.boolean(),
  prompted: z.boolean(),
  note: z.string(),
});
export type RequestPermissionsResult = z.infer<typeof requestPermissionsResultSchema>;

export const runningAppSchema = z.object({
  bundleId: z.string().nullable(),
  localizedName: z.string().nullable(),
  pid: z.number(),
  isActive: z.boolean(),
  isHidden: z.boolean(),
  activationPolicy: z.string(),
  bundlePath: z.string().nullable(),
});
export type RunningApp = z.infer<typeof runningAppSchema>;

export const listAppsResultSchema = z.object({
  apps: z.array(runningAppSchema),
  count: z.number(),
});
export type ListAppsResult = z.infer<typeof listAppsResultSchema>;

export const installedAppSchema = z.object({
  bundleId: z.string().nullable(),
  name: z.string(),
  path: z.string(),
  version: z.string().nullable(),
});
export type InstalledApp = z.infer<typeof installedAppSchema>;

export const listInstalledAppsResultSchema = z.object({
  apps: z.array(installedAppSchema),
  count: z.number(),
});
export type ListInstalledAppsResult = z.infer<typeof listInstalledAppsResultSchema>;

export const launchResultSchema = z.object({
  bundleId: z.string().nullable(),
  localizedName: z.string().nullable(),
  pid: z.number(),
  path: z.string(),
  alreadyRunning: z.boolean(),
  frontmost: z.boolean(),
});
export type LaunchResult = z.infer<typeof launchResultSchema>;

export const activateResultSchema = z.object({
  bundleId: z.string().nullable(),
  pid: z.number(),
  activateAccepted: z.boolean(),
  frontmost: z.boolean(),
});
export type ActivateResult = z.infer<typeof activateResultSchema>;

export const windowSchema = z.object({
  index: z.number(),
  title: z.string().nullable(),
  role: z.string().nullable(),
  subrole: z.string().nullable(),
  position: point,
  size: size,
  focused: z.boolean(),
  main: z.boolean(),
  minimized: z.boolean(),
  /** The window-server id; the only handle screen capture accepts. */
  windowId: z.number().nullable(),
});
export type DesktopWindow = z.infer<typeof windowSchema>;

export const windowsResultSchema = z.object({
  bundleId: z.string().nullable(),
  pid: z.number(),
  windows: z.array(windowSchema),
  count: z.number(),
});
export type WindowsResult = z.infer<typeof windowsResultSchema>;

export const inspectResultSchema = z.object({
  bundleId: z.string().nullable(),
  pid: z.number(),
  windowIndex: z.number().nullable(),
  root: z.string(),
  tree: accessibilityNodeSchema,
  nodeCount: z.number(),
  truncated: z.boolean(),
  limits: z.object({ maxDepth: z.number(), maxNodes: z.number() }),
});
export type InspectResult = z.infer<typeof inspectResultSchema>;

export const findResultSchema = z.object({
  bundleId: z.string().nullable(),
  pid: z.number(),
  windowIndex: z.number().nullable(),
  selector: z.string(),
  matches: z.array(flatNodeSchema),
  count: z.number(),
  truncated: z.boolean(),
});
export type FindResult = z.infer<typeof findResultSchema>;

/**
 * `method` says how the click happened. `coordinates` always carries
 * `elementAtPoint`: MVP.md §13.4 requires a coordinate action to be followed by
 * accessibility or screenshot verification, so the helper hit-tests the point it
 * clicked and reports what was actually there.
 */
export const clickResultSchema = z.union([
  z.object({
    method: z.literal('accessibility'),
    action: z.string(),
    path: z.string(),
    element: flatNodeSchema,
  }),
  z.object({
    method: z.literal('coordinates'),
    point: point,
    button: z.string(),
    elementAtPoint: flatNodeSchema.nullable(),
    verificationError: z.string().nullable(),
  }),
]);
export type ClickResult = z.infer<typeof clickResultSchema>;

export const typeResultSchema = z.object({
  typedCharacters: z.number(),
  events: z.number(),
});
export type TypeResult = z.infer<typeof typeResultSchema>;

export const shortcutResultSchema = z.object({
  modifiers: z.array(z.string()),
  key: z.string(),
  keyCode: z.number(),
});
export type ShortcutResult = z.infer<typeof shortcutResultSchema>;

export const screenshotResultSchema = z.object({
  target: z.string(),
  api: z.string(),
  method: z.string(),
  fallbackReason: z.string().nullable(),
  width: z.number(),
  height: z.number(),
  bytes: z.number(),
  format: z.literal('png'),
  base64: z.string(),
});
export type ScreenshotResult = z.infer<typeof screenshotResultSchema>;
