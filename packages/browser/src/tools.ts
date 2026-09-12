import type { IntegrationId } from '@tandemise/shared';
import { TandemiseError, slugify } from '@tandemise/shared';
import { defineTool, type IntegrationTool, type ToolContext } from '@tandemise/integrations-core';
import type { Locator, Page } from 'playwright';
import { z } from 'zod';
import { runA11yChecks } from './a11y.js';
import type { BrowserConfig } from './options.js';
import type { BrowserSessionManager } from './session-manager.js';
import type { BrowserSession } from './session.js';

/** Reading the page and reading what it did. */
const READ = 'browser.read';
/** Changing page state: clicking, typing. Reversible by reloading. */
const INTERACT = 'browser.interact';

/**
 * How a tool is told which element to act on.
 *
 * `ref` and `role`/`name` come first on purpose. MVP.md §P4 prefers semantic
 * interfaces, and a CSS selector encodes the page's current markup: it breaks
 * on a refactor that changed nothing a user can see. A `ref` from the last
 * snapshot, or a role and an accessible name, survives that.
 */
const targetInput = {
  ref: z.string().optional()
    .describe('Element reference from the most recent browser.snapshot, e.g. e12'),
  role: z.string().optional().describe('ARIA role, e.g. button, link, textbox'),
  name: z.string().optional().describe('Accessible name, used with role'),
  selector: z.string().optional()
    .describe('CSS or Playwright selector. Last resort - prefer ref or role+name.'),
};

const MAX_EVALUATE_LENGTH = 4000;

export function browserTools(
  integrationId: IntegrationId,
  config: BrowserConfig,
  sessions: BrowserSessionManager,
): readonly IntegrationTool[] {
  const session = (ctx: ToolContext): Promise<BrowserSession> =>
    sessions.acquire(ctx.assignment, config);

  const navigate = defineTool({
    name: 'browser.navigate',
    integrationId,
    capability: 'browser.navigate',
    risk: 'read',
    description: 'Navigate the assignment browser to a URL within its domain allowlist.',
    inputSchema: z.object({
      url: z.string().url(),
      waitUntil: z.enum(['load', 'domcontentloaded', 'networkidle', 'commit']).default('load'),
    }),
    outputSchema: z.object({
      url: z.string(),
      title: z.string(),
      status: z.number().nullable(),
    }),
    resource: (input) => hostOf(input.url),
    execute: async (ctx, input) => {
      const s = await session(ctx);
      s.assertAllowed(input.url);
      const response = await s.page.goto(input.url, { waitUntil: input.waitUntil });
      const output = {
        url: s.page.url(),
        title: await s.page.title(),
        status: response?.status() ?? null,
      };
      return { output, summary: `Loaded ${output.url} (${output.status ?? 'no response'})` };
    },
  });

  const snapshot = defineTool({
    name: 'browser.snapshot',
    integrationId,
    capability: READ,
    risk: 'read',
    description:
      'Capture the page as an accessibility tree with element references. Prefer this over a screenshot: it is what the page means, not what it looks like.',
    inputSchema: z.object({
      depth: z.number().int().min(1).max(50).optional()
        .describe('Limit the tree depth for a large page'),
      includeJson: z.boolean().default(false)
        .describe('Also return the tree as structured JSON'),
    }),
    outputSchema: z.object({
      url: z.string(),
      title: z.string(),
      snapshot: z.string(),
      tree: z.unknown().optional(),
    }),
    execute: async (ctx, input) => {
      const s = await session(ctx);
      const options = input.depth === undefined ? {} : { depth: input.depth };
      const text = await s.page.ariaSnapshot({ mode: 'ai', ...options });
      const output = {
        url: s.page.url(),
        title: await s.page.title(),
        snapshot: text,
        ...(input.includeJson
          ? { tree: await s.page.ariaSnapshotJSON(options) as unknown }
          : {}),
      };
      return { output, summary: `Accessibility snapshot of ${output.url} (${text.split('\n').length} nodes)` };
    },
  });

  const click = defineTool({
    name: 'browser.click',
    integrationId,
    capability: INTERACT,
    risk: 'write_reversible',
    description: 'Click an element identified by snapshot reference, role and name, or selector.',
    inputSchema: z.object({
      ...targetInput,
      button: z.enum(['left', 'right', 'middle']).default('left'),
      clickCount: z.number().int().min(1).max(3).default(1),
    }),
    outputSchema: z.object({ target: z.string(), url: z.string() }),
    execute: async (ctx, input) => {
      const s = await session(ctx);
      const { locator, description } = resolveTarget(s.page, input);
      await locator.click({ button: input.button, clickCount: input.clickCount });
      return {
        output: { target: description, url: s.page.url() },
        summary: `Clicked ${description}`,
      };
    },
  });

  const type = defineTool({
    name: 'browser.type',
    integrationId,
    capability: INTERACT,
    risk: 'write_reversible',
    description: 'Type text into a field, optionally clearing it first or submitting afterwards.',
    inputSchema: z.object({
      ...targetInput,
      text: z.string(),
      clear: z.boolean().default(true),
      submit: z.boolean().default(false).describe('Press Enter after typing'),
    }),
    outputSchema: z.object({ target: z.string(), characters: z.number(), url: z.string() }),
    execute: async (ctx, input) => {
      const s = await session(ctx);
      const { locator, description } = resolveTarget(s.page, input);
      if (input.clear) await locator.fill('');
      await locator.fill(input.text);
      if (input.submit) await locator.press('Enter');
      return {
        output: { target: description, characters: input.text.length, url: s.page.url() },
        // The text itself is not echoed: it is frequently a credential.
        summary: `Typed ${input.text.length} character(s) into ${description}`,
      };
    },
  });

  const screenshot = defineTool({
    name: 'browser.screenshot',
    integrationId,
    capability: READ,
    risk: 'read',
    description: 'Capture a PNG of the page or one element, for evidence.',
    inputSchema: z.object({
      ...targetInput,
      fullPage: z.boolean().default(false),
    }),
    outputSchema: z.object({
      filename: z.string(),
      byteSize: z.number(),
      url: z.string(),
    }),
    execute: async (ctx, input) => {
      const s = await session(ctx);
      const hasTarget = Boolean(input.ref ?? input.selector ?? input.role);
      const bytes = hasTarget
        ? await resolveTarget(s.page, input).locator.screenshot()
        : await s.page.screenshot({ fullPage: input.fullPage });
      const filename = evidenceFilename(s.page.url());
      return {
        output: { filename, byteSize: bytes.byteLength, url: s.page.url() },
        summary: `Screenshot of ${s.page.url()} (${bytes.byteLength} bytes)`,
        // Bytes travel back to the caller; persisting them as an Evidence
        // artifact needs a mission and an artifact store, which live a layer up.
        evidence: [{
          filename,
          mediaType: 'image/png',
          bytes: new Uint8Array(bytes),
          title: `Screenshot of ${s.page.url()}`,
        }],
      };
    },
  });

  const evaluate = defineTool({
    name: 'browser.evaluate',
    integrationId,
    capability: 'browser.evaluate',
    risk: 'write_reversible',
    description:
      'Evaluate a JavaScript expression in the page. A last resort - prefer snapshot, click and type (MVP.md §13.1).',
    inputSchema: z.object({
      expression: z.string().min(1).max(MAX_EVALUATE_LENGTH),
    }),
    outputSchema: z.object({ result: z.string() }),
    execute: async (ctx, input) => {
      // Two locks: the capability, and an explicit opt-in on the integration.
      // Arbitrary page script can read any credential the page holds, so it is
      // off unless someone turned it on for this integration deliberately.
      if (!config.allowEvaluate) {
        throw TandemiseError.permissionDenied(
          'browser.evaluate is disabled for this integration. Set allowEvaluate on the integration config to enable it.',
        );
      }
      const s = await session(ctx);
      const value: unknown = await s.page.evaluate(input.expression);
      const result = typeof value === 'string' ? value : JSON.stringify(value) ?? 'undefined';
      return { output: { result }, summary: `Evaluated expression, result: ${result.slice(0, 120)}` };
    },
  });

  const waitFor = defineTool({
    name: 'browser.wait_for',
    integrationId,
    capability: READ,
    risk: 'read',
    description: 'Wait for an element or a piece of text to reach a state.',
    inputSchema: z.object({
      ...targetInput,
      text: z.string().optional().describe('Wait for this text to appear anywhere on the page'),
      state: z.enum(['visible', 'hidden', 'attached', 'detached']).default('visible'),
      timeoutMs: z.number().int().min(100).max(120_000).default(10_000),
    }),
    outputSchema: z.object({ matched: z.boolean(), waitedMs: z.number(), url: z.string() }),
    execute: async (ctx, input) => {
      const s = await session(ctx);
      const startedAt = Date.now();
      const locator = input.text !== undefined && !input.ref && !input.selector && !input.role
        ? s.page.getByText(input.text)
        : resolveTarget(s.page, input).locator;
      try {
        await locator.first().waitFor({ state: input.state, timeout: input.timeoutMs });
        return {
          output: { matched: true, waitedMs: Date.now() - startedAt, url: s.page.url() },
          summary: `Reached state '${input.state}' after ${Date.now() - startedAt}ms`,
        };
      } catch {
        // A timeout is an answer here, not a failure: "it never appeared" is
        // exactly what a QA worker asked to find out.
        return {
          output: { matched: false, waitedMs: Date.now() - startedAt, url: s.page.url() },
          summary: `Never reached state '${input.state}' within ${input.timeoutMs}ms`,
        };
      }
    },
  });

  const consoleLogs = defineTool({
    name: 'browser.console_logs',
    integrationId,
    capability: READ,
    risk: 'read',
    description: 'Read console output and page errors captured since the session opened.',
    inputSchema: z.object({
      limit: z.number().int().min(1).max(500).default(50),
      level: z.enum(['error', 'warning', 'info', 'log', 'pageerror']).optional(),
    }),
    outputSchema: z.object({
      entries: z.array(z.object({ level: z.string(), text: z.string(), at: z.number() })),
    }),
    execute: async (ctx, input) => {
      const s = await session(ctx);
      const all = s.consoleLogs(input.limit);
      const entries = input.level ? all.filter((e) => e.level === input.level) : all;
      const errors = entries.filter((e) => e.level === 'error' || e.level === 'pageerror').length;
      return {
        output: { entries: [...entries] },
        summary: `${entries.length} console entr(ies), ${errors} error(s)`,
      };
    },
  });

  const networkLog = defineTool({
    name: 'browser.network_log',
    integrationId,
    capability: READ,
    risk: 'read',
    description: 'Read the requests this page made, including any blocked by the domain allowlist.',
    inputSchema: z.object({
      limit: z.number().int().min(1).max(500).default(50),
      includeBlocked: z.boolean().default(true),
    }),
    outputSchema: z.object({
      requests: z.array(z.object({
        method: z.string(), url: z.string(), status: z.number().nullable(),
        resourceType: z.string(), at: z.number(),
      })),
      blocked: z.array(z.object({ url: z.string(), resourceType: z.string(), at: z.number() })),
      allowlist: z.string(),
    }),
    execute: async (ctx, input) => {
      const s = await session(ctx);
      const requests = [...s.networkLog(input.limit)];
      const blocked = input.includeBlocked ? [...s.blockedRequests(input.limit)] : [];
      return {
        output: { requests, blocked, allowlist: s.allowlist.describe() },
        summary: `${requests.length} request(s), ${blocked.length} blocked by allowlist`,
      };
    },
  });

  const a11yCheck = defineTool({
    name: 'browser.a11y_check',
    integrationId,
    capability: READ,
    risk: 'read',
    description:
      'Run basic accessibility checks: missing alt text, unlabelled controls, heading order, and text contrast.',
    inputSchema: z.object({}),
    outputSchema: z.object({
      url: z.string(),
      findings: z.array(z.object({
        rule: z.string(), impact: z.string(), message: z.string(), selector: z.string(),
      })),
      counts: z.record(z.number()),
    }),
    execute: async (ctx) => {
      const s = await session(ctx);
      const report = await runA11yChecks(s.page);
      const serious = report.findings.filter((f) => f.impact === 'serious').length;
      return {
        output: { url: report.url, findings: [...report.findings], counts: { ...report.counts } },
        summary: `${report.findings.length} accessibility finding(s), ${serious} serious`,
      };
    },
  });

  return [
    navigate, snapshot, click, type, screenshot, evaluate, waitFor,
    consoleLogs, networkLog, a11yCheck,
  ];
}

interface TargetInput {
  readonly ref?: string | undefined;
  readonly role?: string | undefined;
  readonly name?: string | undefined;
  readonly selector?: string | undefined;
}

function resolveTarget(page: Page, input: TargetInput): { locator: Locator; description: string } {
  if (input.ref) {
    return { locator: page.locator(`aria-ref=${input.ref}`), description: `ref ${input.ref}` };
  }
  if (input.role) {
    const role = input.role as Parameters<Page['getByRole']>[0];
    const options = input.name === undefined ? {} : { name: input.name };
    return {
      locator: page.getByRole(role, options),
      description: `${input.role}${input.name ? ` "${input.name}"` : ''}`,
    };
  }
  if (input.selector) {
    return { locator: page.locator(input.selector), description: input.selector };
  }
  throw TandemiseError.validation(
    'No element specified: pass ref, role (with name), or selector',
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return url;
  }
}

/**
 * A name a human can recognise in an artifact list six weeks later, and that
 * sorts chronologically inside one mission.
 */
function evidenceFilename(url: string): string {
  const host = slugify(hostOf(url), 24);
  return `screenshot-${host}-${Date.now()}.png`;
}
