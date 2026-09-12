import type { ArtifactManifest, ArtifactWriteRequest, LoadedArtifact } from '../entities/artifact.js';
import type { ArtifactId } from '@tandemise/shared';

/**
 * Artifact body storage. Metadata lives in the database; bodies live outward -
 * on the filesystem for the local implementation, content-addressed by hash so
 * that identical evidence captured twice costs one copy (MVP.md §15.3).
 */
export interface ArtifactStorePort {
  write(request: ArtifactWriteRequest): Promise<ArtifactManifest>;
  read(id: ArtifactId): Promise<LoadedArtifact>;
  readBinary(id: ArtifactId): Promise<Uint8Array>;
  /** Absolute path for UI "reveal in Finder" and for attaching to a runtime. */
  resolvePath(manifest: ArtifactManifest): string;
  exists(id: ArtifactId): boolean;
}
