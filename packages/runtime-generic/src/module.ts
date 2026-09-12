import { defineRuntimeModule } from '@tandemise/runtimes-core';
import { FakeRuntimeAdapter } from './fake.js';
import { GenericCliAdapter } from './generic-cli.js';

/**
 * Contributes both adapters. The fake ships in the same module as the generic
 * CLI deliberately: they are the two runtimes that need no vendor at all, and a
 * composition that has one should always have the other available for tests.
 */
export const genericRuntimeModule = defineRuntimeModule(
  'runtime-generic',
  () => new GenericCliAdapter(),
  () => new FakeRuntimeAdapter(),
);
