import { defineRuntimeModule } from '@tandemise/runtimes-core';
import { ClaudeCodeAdapter } from './adapter.js';

/**
 * The entire integration surface of this package: one adapter contributed to
 * the runtime multi-token. Nothing in the core names Claude Code (MVP.md §26.1).
 */
export const claudeRuntimeModule = defineRuntimeModule('runtime-claude', () => new ClaudeCodeAdapter());
