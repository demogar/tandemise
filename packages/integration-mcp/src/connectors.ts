import type { IntegrationConnector } from '@tandemise/integrations-core';

/**
 * Hosted MCP servers that connect with one click.
 *
 * Each entry was checked against the live server before it was added: it
 * answers an unauthenticated request with an RFC 9728 challenge, its
 * authorization server publishes metadata, and it accepts dynamic client
 * registration - the three things "Connect" needs to work with no setup. A
 * vendor that stops doing any of them fails at connect with a message saying
 * which, rather than here.
 *
 * GitHub is deliberately absent. Its hosted server does not allow dynamic
 * registration, and the `gh` CLI - already signed in on most developers'
 * machines - is the better route anyway; the GitHub provider offers that.
 *
 * `capability` decides which workers can see the tools. The role that does the
 * work holds it - designers hold `design` - so connecting Figma gives the
 * designer Figma, not every worker. Read-only tools are published under
 * `<capability>.read`, so reading a Linear issue is not an external write that
 * stops for approval.
 */
export const MCP_CONNECTORS: readonly IntegrationConnector[] = [
  connector('figma', 'Figma', 'design', 'design', 'Designers',
    'Read files and frames, and generate designs from your components.',
    'https://mcp.figma.com/mcp', 'https://www.figma.com'),
  connector('canva', 'Canva', 'design', 'design', 'Designers',
    'Create and edit designs, and export them.',
    'https://mcp.canva.com/mcp', 'https://www.canva.com'),
  connector('linear', 'Linear', 'planning', 'planning', 'Product, architecture and release',
    'Create and update issues and projects.',
    'https://mcp.linear.app/mcp', 'https://linear.app'),
  connector('notion', 'Notion', 'planning', 'planning', 'Product, architecture and release',
    'Read and write pages and databases - specs, docs, release notes.',
    'https://mcp.notion.com/mcp', 'https://www.notion.so'),
  connector('atlassian', 'Jira & Confluence', 'planning', 'planning', 'Product, architecture and release',
    'Work with Jira issues and Confluence pages.',
    'https://mcp.atlassian.com/v1/mcp', 'https://www.atlassian.com'),
  connector('supabase', 'Supabase', 'build', 'database', 'Developers',
    'Inspect schemas, run queries and migrations, manage projects.',
    'https://mcp.supabase.com/mcp', 'https://supabase.com'),
  connector('vercel', 'Vercel', 'deploy', 'deploy', 'Release and QA',
    'See deployments and their logs, and manage projects.',
    'https://mcp.vercel.com', 'https://vercel.com'),
  connector('sentry', 'Sentry', 'observe', 'monitoring', 'Developers, QA and release',
    'Find errors after a deploy and trace them to a cause.',
    'https://mcp.sentry.dev/mcp', 'https://sentry.io'),
];

function connector(
  id: string,
  name: string,
  category: string,
  capability: string,
  usedBy: string,
  description: string,
  url: string,
  homepage: string,
): IntegrationConnector {
  return {
    id,
    name,
    description,
    category,
    providerId: 'mcp',
    authorization: 'oauth',
    usedBy,
    homepage,
    config: {
      url,
      auth: 'oauth',
      capability,
      // Writes to someone else's service. Reads are split off by annotation.
      risk: 'external_side_effect',
      trustAnnotations: true,
    },
  };
}
