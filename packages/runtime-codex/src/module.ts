import { defineRuntimeModule } from '@tandemise/runtimes-core';
import { CodexAdapter } from './adapter.js';

/**
 * The entire integration surface of this package: one adapter contributed to
 * the runtime multi-token. Nothing in the core names Codex (MVP.md §26.1).
 */
export const codexRuntimeModule = defineRuntimeModule('runtime-codex', () => new CodexAdapter());
