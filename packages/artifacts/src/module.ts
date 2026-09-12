import { defineModule, token, type TandemiseModule } from '@tandemise/kernel';
import type { ArtifactStorePort } from '@tandemise/domain';
import type { Clock, TandemisePaths } from '@tandemise/shared';
import { createPaths, systemClock } from '@tandemise/shared';
import { createFilesystemArtifactStore } from './store.js';

export const ARTIFACT_STORE = token<ArtifactStorePort>('ArtifactStorePort');
/** Exposed so the composition root can share one `TandemisePaths` everywhere. */
export const ARTIFACT_PATHS = token<TandemisePaths>('TandemisePaths(artifacts)');

export interface ArtifactsModuleOptions {
  readonly paths?: TandemisePaths;
  readonly clock?: Clock;
}

export function createArtifactsModule(options: ArtifactsModuleOptions = {}): TandemiseModule {
  const paths = options.paths ?? createPaths();
  const clock = options.clock ?? systemClock;
  return defineModule('artifacts', (container) => {
    container.bind(ARTIFACT_PATHS, () => paths, { source: 'artifacts' });
    container.bind(
      ARTIFACT_STORE,
      (r) => createFilesystemArtifactStore({ paths: r.resolve(ARTIFACT_PATHS), clock }),
      { source: 'artifacts' },
    );
  });
}

/** Convenience binding for composition roots using the default Tandemise home. */
export const artifactsModule: TandemiseModule = createArtifactsModule();
