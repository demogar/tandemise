import { defineModule } from '@tandemise/kernel';
import { RUNTIME_ADAPTERS } from '@tandemise/runtimes-core';
import { ClaudeCodeAdapter } from './adapter.js';

/**
 * The entire integration surface of this package: one contribution to the
 * adapter multi-token. Nothing in the core names Claude Code (MVP.md §26.1).
 */
export const claudeRuntimeModule = defineModule('runtime-claude', (container) => {
  container.contribute(RUNTIME_ADAPTERS, () => new ClaudeCodeAdapter(), { source: 'runtime-claude' });
}, ['runtimes-core']);
