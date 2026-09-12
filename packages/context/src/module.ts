import { defineModule, token, type TandemiseModule } from '@tandemise/kernel';
import { createContextCompiler, type ContextCompiler } from './compiler.js';

export const CONTEXT_COMPILER = token<ContextCompiler>('ContextCompiler');

export const contextModule: TandemiseModule = defineModule('context', (container) => {
  container.bind(CONTEXT_COMPILER, () => createContextCompiler(), { source: 'context' });
});
