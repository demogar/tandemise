import type { IntegrationId, Clock } from '@tandemise/shared';
import { TandemiseError } from '@tandemise/shared';
import { defineTool, type IntegrationTool, type ToolContext } from '@tandemise/integrations-core';
import { z } from 'zod';
import { assertAppAllowed, bundleIdInScope, hasUnrestrictedAppScope } from './allowlist.js';
import type { MacOSHelperClient } from './client.js';
import type { DesktopConfig } from './config.js';

/**
 * Capabilities are per-action, under one `desktop` root: a grant for `desktop`
 * covers all of them, while a grant for `desktop.inspect` lets a reviewer role
 * read a UI without being able to click in it.
 */
const CAP = {
  apps: 'desktop.apps',
  launch: 'desktop.launch',
  inspect: 'desktop.inspect',
  click: 'desktop.click',
  type: 'desktop.type',
  shortcut: 'desktop.shortcut',
  screenshot: 'desktop.screenshot',
} as const;

/**
 * Every app-targeting tool takes a bundle id, never a display name.
 *
 * A name is not an identity: two apps can share one, and a name cannot be
 * checked against an allowlist without a lookup that is itself attackable. The
 * bundle id is the thing macOS, the grant and the audit record all agree on.
 * `desktop.list_apps` exists to turn a name into one.
 */
const appInput = z
  .string()
  .min(1)
  .describe('Bundle id of the target application, e.g. com.apple.calculator. Use desktop.list_apps to find one.');

const windowInput = {
  window: z.string().optional().describe('Window title, or a substring of it. Defaults to the main window.'),
  windowIndex: z.number().int().min(0).optional().describe('Window by index, as returned by a previous inspect.'),
};

const selectorInput = {
  role: z.string().optional().describe('Accessibility role, e.g. AXButton, AXTextField.'),
  subrole: z.string().optional().describe('Accessibility subrole, e.g. AXCloseButton.'),
  label: z.string().optional().describe('Visible label: matches title, description or value, case-insensitively.'),
  identifier: z.string().optional().describe('Accessibility identifier, when the app sets one.'),
  titleContains: z.string().optional().describe('Substring of the title, description, value or help text.'),
};

const nodeOutput = z.object({
  role: z.string().nullable(),
  subrole: z.string().nullable(),
  title: z.string().nullable(),
  label: z.string().nullable(),
  value: z.string().nullable(),
  identifier: z.string().nullable(),
  enabled: z.boolean().nullable(),
  focused: z.boolean().nullable(),
  path: z.string().optional(),
});

export interface DesktopToolDeps {
  readonly integrationId: IntegrationId;
  readonly client: MacOSHelperClient;
  readonly config: DesktopConfig;
  readonly clock: Clock;
}

export function desktopTools(deps: DesktopToolDeps): readonly IntegrationTool[] {
  const { integrationId, client, config, clock } = deps;

  /**
   * The single gate every app-targeting tool passes through. Two independent
   * allowlists must both admit the app: the workspace's (the integration row)
   * and the assignment's (its grants). Neither is a substitute for the other -
   * the first is an administrator's decision, the second a per-mission one.
   */
  const gate = (toolName: string, capability: string, ctx: ToolContext, app: string): void => {
    if (config.apps.length > 0 && !bundleIdInScope(config.apps, app)) {
      throw TandemiseError.permissionDenied(
        `'${toolName}' is not permitted to touch '${app}': this workspace's desktop integration allows only ${config.apps.join(', ')}`,
        { tool: toolName, bundleId: app },
      );
    }
    assertAppAllowed(toolName, ctx.assignment, capability, app, clock);
  };

  /**
   * Keyboard input goes wherever focus happens to be, so an app that will not
   * come forward must abort the call rather than type into whatever is in
   * front. This is the single most damaging silent failure in desktop
   * automation, and the only reliable defence is to refuse.
   */
  const focus = async (toolName: string, app: string): Promise<void> => {
    const activated = await client.activate({ bundleId: app });
    if (activated.frontmost) return;
    throw new TandemiseError(
      'PRECONDITION_FAILED',
      `'${toolName}' will not send input: '${app}' could not be brought to the front, so the keystrokes `
        + 'would reach whichever application is focused instead.',
      { details: { tool: toolName, bundleId: app } },
    );
  };

  const listApps = defineTool({
    name: 'desktop.list_apps',
    integrationId,
    capability: CAP.apps,
    risk: 'read',
    description:
      'List the macOS applications this assignment may control, running and installed, with their bundle ids. '
        + 'Applications outside the allowlist are not reported.',
    inputSchema: z.object({
      installed: z.boolean().default(false).describe('Also list installed-but-not-running applications.'),
    }),
    outputSchema: z.object({
      running: z.array(z.object({
        bundleId: z.string(), name: z.string().nullable(), pid: z.number(), isActive: z.boolean(),
      })),
      installed: z.array(z.object({
        bundleId: z.string(), name: z.string(), path: z.string(), version: z.string().nullable(),
      })),
      hiddenByAllowlist: z.number(),
    }),
    execute: async (ctx, input) => {
      const visible = (bundleId: string | null): bundleId is string => {
        if (bundleId === null) return false;
        if (config.apps.length > 0 && !bundleIdInScope(config.apps, bundleId)) return false;
        try {
          assertAppAllowed('desktop.list_apps', ctx.assignment, CAP.apps, bundleId, clock);
          return true;
        } catch {
          return false;
        }
      };

      const runningAll = (await client.listApps()).apps;
      const running = runningAll
        .filter((a) => visible(a.bundleId))
        .map((a) => ({
          bundleId: a.bundleId ?? '', name: a.localizedName, pid: a.pid, isActive: a.isActive,
        }));

      let installed: { bundleId: string; name: string; path: string; version: string | null }[] = [];
      let installedHidden = 0;
      if (input.installed) {
        const all = (await client.listInstalledApps()).apps;
        installed = all
          .filter((a) => visible(a.bundleId))
          .map((a) => ({ bundleId: a.bundleId ?? '', name: a.name, path: a.path, version: a.version }));
        installedHidden = all.length - installed.length;
      }

      const hiddenByAllowlist = runningAll.length - running.length + installedHidden;
      return {
        output: { running, installed, hiddenByAllowlist },
        summary: `${running.length} allowlisted application(s) running`
          + (input.installed ? `, ${installed.length} installed` : '')
          + (hiddenByAllowlist > 0 ? ` (${hiddenByAllowlist} hidden by the allowlist)` : ''),
      };
    },
  });

  const launch = defineTool({
    name: 'desktop.launch',
    integrationId,
    capability: CAP.launch,
    risk: 'write_reversible',
    description: 'Launch an application (or bring it forward if it is already running) and wait for it to be ready.',
    inputSchema: z.object({
      app: appInput,
      activate: z.boolean().default(true).describe('Bring the application to the front.'),
    }),
    outputSchema: z.object({
      bundleId: z.string().nullable(),
      name: z.string().nullable(),
      pid: z.number(),
      path: z.string(),
      alreadyRunning: z.boolean(),
      frontmost: z.boolean(),
    }),
    resource: (input) => input.app,
    execute: async (ctx, input) => {
      gate('desktop.launch', CAP.launch, ctx, input.app);
      const result = await client.launch({ bundleId: input.app, activate: input.activate });
      return {
        output: {
          bundleId: result.bundleId, name: result.localizedName, pid: result.pid,
          path: result.path, alreadyRunning: result.alreadyRunning, frontmost: result.frontmost,
        },
        summary: `${result.localizedName ?? input.app} is running (pid ${result.pid})`
          + (input.activate && !result.frontmost ? ' but did not come to the front' : ''),
      };
    },
  });

  const inspect = defineTool({
    name: 'desktop.inspect',
    integrationId,
    capability: CAP.inspect,
    risk: 'read',
    description:
      'Read an application\'s accessibility tree: roles, titles, labels, values, enabled and focused state, '
        + 'positions and sizes. Depth and node count are capped; the result says when it was truncated.',
    inputSchema: z.object({
      app: appInput,
      ...windowInput,
      maxDepth: z.number().int().min(1).max(40).optional(),
      maxNodes: z.number().int().min(1).max(20_000).optional(),
    }),
    resource: (input) => input.app,
    execute: async (ctx, input) => {
      gate('desktop.inspect', CAP.inspect, ctx, input.app);
      const result = await client.inspect({
        bundleId: input.app,
        ...(input.window !== undefined ? { window: input.window } : {}),
        ...(input.windowIndex !== undefined ? { windowIndex: input.windowIndex } : {}),
        maxDepth: input.maxDepth ?? config.maxInspectDepth,
        maxNodes: input.maxNodes ?? config.maxInspectNodes,
      });
      return {
        output: result,
        summary: `${result.nodeCount} accessibility node(s) from ${input.app}`
          + (result.truncated ? ' (truncated - narrow with window/maxDepth)' : ''),
      };
    },
  });

  const find = defineTool({
    name: 'desktop.find',
    integrationId,
    capability: CAP.inspect,
    risk: 'read',
    description:
      'Find accessibility elements by role, label or identifier. Each match carries a stable path that '
        + 'desktop.click accepts, so actions never need coordinates.',
    inputSchema: z.object({
      app: appInput,
      ...windowInput,
      ...selectorInput,
      limit: z.number().int().min(1).max(200).default(25),
    }),
    outputSchema: z.object({
      selector: z.string(),
      matches: z.array(nodeOutput),
      count: z.number(),
      truncated: z.boolean(),
    }),
    resource: (input) => input.app,
    execute: async (ctx, input) => {
      gate('desktop.find', CAP.inspect, ctx, input.app);
      const result = await client.find({ bundleId: input.app, ...omitUndefined(input, ['app']) });
      return {
        output: {
          selector: result.selector,
          matches: result.matches,
          count: result.count,
          truncated: result.truncated,
        },
        summary: `${result.count} element(s) match ${result.selector} in ${input.app}`,
      };
    },
  });

  const click = defineTool({
    name: 'desktop.click',
    integrationId,
    capability: CAP.click,
    risk: 'write_reversible',
    description:
      'Press an element chosen by role/label/identifier, or by a path from desktop.find. Coordinates are a '
        + 'fallback that must be requested explicitly, and are always answered with the element actually at that point.',
    inputSchema: z.object({
      app: appInput,
      ...windowInput,
      ...selectorInput,
      path: z.string().optional().describe('Stable element path from desktop.find. Preferred over a selector when known.'),
      coordinates: z
        .object({ x: z.number(), y: z.number() })
        .optional()
        .describe('Screen coordinates. Requires allowCoordinates and is a last resort.'),
      allowCoordinates: z.boolean().default(false),
      button: z.enum(['left', 'right', 'middle']).default('left'),
      clickCount: z.number().int().min(1).max(3).default(1),
    }),
    resource: (input) => input.app,
    execute: async (ctx, input) => {
      gate('desktop.click', CAP.click, ctx, input.app);
      const { app, coordinates, ...rest } = input;
      const result = await client.click({
        bundleId: app,
        ...omitUndefined(rest, []),
        ...(coordinates ? { x: coordinates.x, y: coordinates.y } : {}),
      });

      if (result.method === 'accessibility') {
        return {
          output: result,
          summary: `${result.action} on ${describeNode(result.element)} in ${app}`,
        };
      }
      // MVP.md §13.4: a coordinate action is only complete once its effect has
      // been verified. The helper hit-tests the point; we surface that verbatim
      // so the caller can tell a hit from a miss.
      const at = result.elementAtPoint;
      return {
        output: result,
        summary: at
          ? `Clicked (${result.point?.x ?? '?'}, ${result.point?.y ?? '?'}) in ${app}; that point is ${describeNode(at)}`
          : `Clicked (${result.point?.x ?? '?'}, ${result.point?.y ?? '?'}) in ${app}; could not verify what was hit`
            + (result.verificationError ? ` (${result.verificationError})` : ''),
      };
    },
  });

  const type = defineTool({
    name: 'desktop.type',
    integrationId,
    capability: CAP.type,
    risk: 'write_reversible',
    description:
      'Type text into an application. The application is brought to the front first, and the call fails rather '
        + 'than typing into a different one.',
    inputSchema: z.object({
      app: appInput,
      text: z.string().min(1).describe('Text to type. Newlines are sent as Return.'),
      delayMs: z.number().int().min(0).max(500).optional().describe('Delay between keystrokes.'),
    }),
    outputSchema: z.object({ typedCharacters: z.number(), events: z.number() }),
    resource: (input) => input.app,
    execute: async (ctx, input) => {
      gate('desktop.type', CAP.type, ctx, input.app);
      await focus('desktop.type', input.app);
      const result = await client.type({
        text: input.text,
        ...(input.delayMs !== undefined ? { delayMs: input.delayMs } : {}),
      });
      return {
        output: result,
        summary: `Typed ${result.typedCharacters} character(s) into ${input.app}`,
      };
    },
  });

  const shortcut = defineTool({
    name: 'desktop.shortcut',
    integrationId,
    capability: CAP.shortcut,
    risk: 'write_reversible',
    description:
      'Send a keyboard shortcut such as ["CMD","R"]. The application is brought to the front first, and the '
        + 'call fails rather than sending the shortcut to a different one.',
    inputSchema: z.object({
      app: appInput,
      keys: z
        .array(z.string().min(1))
        .min(1)
        .max(5)
        .describe('Modifiers (CMD, SHIFT, ALT, CTRL, FN) plus exactly one key, e.g. ["CMD","SHIFT","P"].'),
    }),
    outputSchema: z.object({
      modifiers: z.array(z.string()), key: z.string(), keyCode: z.number(),
    }),
    resource: (input) => input.app,
    execute: async (ctx, input) => {
      gate('desktop.shortcut', CAP.shortcut, ctx, input.app);
      await focus('desktop.shortcut', input.app);
      const result = await client.shortcut({ keys: input.keys });
      return {
        output: result,
        summary: `Sent ${[...result.modifiers, result.key].join('+')} to ${input.app}`,
      };
    },
  });

  const screenshot = defineTool({
    name: 'desktop.screenshot',
    integrationId,
    capability: CAP.screenshot,
    risk: 'read',
    description:
      'Capture a PNG of an application window. The image is returned as evidence, not inline. Capturing a whole '
        + 'display requires an unrestricted app grant, because a full-screen capture would include applications '
        + 'this assignment may not see.',
    inputSchema: z.object({
      app: appInput.optional(),
      windowId: z.number().int().optional().describe('Specific window, from desktop.inspect or a window listing.'),
      display: z.boolean().default(false).describe('Capture the whole main display instead of one window.'),
    }),
    outputSchema: z.object({
      target: z.string(),
      method: z.string(),
      width: z.number(),
      height: z.number(),
      bytes: z.number(),
      filename: z.string(),
    }),
    resource: (input) => input.app,
    execute: async (ctx, input) => {
      if (input.display || (input.app === undefined && input.windowId === undefined)) {
        if (!hasUnrestrictedAppScope(ctx.assignment, CAP.screenshot, clock)) {
          throw TandemiseError.permissionDenied(
            'desktop.screenshot may not capture a whole display: this assignment is allowlisted to specific '
              + 'applications, and a full-screen capture would include others. Pass an app bundle id.',
            { tool: 'desktop.screenshot' },
          );
        }
      } else if (input.app !== undefined) {
        gate('desktop.screenshot', CAP.screenshot, ctx, input.app);
      } else {
        // A bare window id names a window whose owner we have not checked.
        throw TandemiseError.validation(
          'desktop.screenshot needs an app bundle id alongside windowId, so the window\'s owner can be checked '
            + 'against the allowlist.',
        );
      }

      const result = await client.screenshot({
        ...(input.app !== undefined && !input.display ? { bundleId: input.app } : {}),
        ...(input.windowId !== undefined && !input.display ? { windowId: input.windowId } : {}),
      });

      const filename = `desktop-${(input.app ?? 'display').replace(/[^a-zA-Z0-9.-]/g, '_')}-${clock.epochMs()}.png`;
      return {
        output: {
          target: result.target, method: result.method, width: result.width,
          height: result.height, bytes: result.bytes, filename,
        },
        summary: `Captured ${result.width}x${result.height} PNG of ${result.target} via ${result.api}/${result.method}`,
        evidence: [{
          filename,
          mediaType: 'image/png',
          bytes: decodeBase64(result.base64),
          title: `Screenshot of ${input.app ?? result.target}`,
        }],
      };
    },
  });

  return [listApps, launch, inspect, find, click, type, shortcut, screenshot];
}

function describeNode(node: {
  role: string | null; title: string | null; label: string | null; identifier: string | null;
}): string {
  const name = node.title ?? node.label ?? node.identifier;
  return name ? `${node.role ?? 'element'} '${name}'` : (node.role ?? 'an element');
}

/**
 * Drop `undefined` entries so they are never serialised into the helper's
 * params, where `{"window": null}` would read as "a window literally named
 * null" rather than "no window given".
 */
function omitUndefined<T extends Record<string, unknown>>(
  value: T,
  drop: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    if (v === undefined || drop.includes(key)) continue;
    out[key] = v;
  }
  return out;
}

/** PNG bytes from the helper's base64. `Buffer` is a Node global, not an import. */
function decodeBase64(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'base64'));
}
