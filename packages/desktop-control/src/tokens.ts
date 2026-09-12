import { token } from '@tandemise/kernel';
import type { MacOSHelperClient } from './client.js';
import type { SpawnHelper } from './spawn.js';

/** Where the built helper lives, relative to the repository root. */
export const HELPER_BINARY_RELATIVE_PATH = 'native/macos-helper/.build/release/tandemise-helper';

/**
 * Both are bound by the composition root, which is the only place that knows
 * the installation layout and the only place allowed to name
 * `node:child_process`.
 */
export const HELPER_BINARY_PATH = token<string>('desktop/helper-binary-path');
export const HELPER_SPAWN = token<SpawnHelper>('desktop/helper-spawn');

export const MACOS_HELPER_CLIENT = token<MacOSHelperClient>('desktop/macos-helper-client');
