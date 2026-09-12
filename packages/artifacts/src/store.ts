import type {
  ArtifactManifest, ArtifactStorePort, ArtifactWriteRequest, LoadedArtifact,
} from '@tandemise/domain';
import { defaultMediaTypeFor } from '@tandemise/domain';
import type { ArtifactId, Clock, TandemisePaths } from '@tandemise/shared';
import { TandemiseError, ids, systemClock } from '@tandemise/shared';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Filesystem artifact bodies (MVP.md §15.3).
 *
 * Layout under the workspace artifact root:
 *
 *   index/<artifactId>.json        manifest, so an id can be resolved without the DB
 *   <missionId>/<type>/<id>.md     structured artifact bodies, browsable by a human
 *   blobs/<aa>/<sha256>            content-addressed evidence and binaries
 *
 * Two properties are load-bearing.
 *
 * **`contentRef` is never absolute.** It is either a path relative to the
 * artifact root or a `sha256:` reference. The Tandemise home must be movable
 * and the database must survive it; an absolute path baked into a row does not.
 *
 * **Evidence is content-addressed.** The same screenshot captured by three QA
 * runs is one file on disk, and its identity is its hash rather than whatever
 * name the capturing tool happened to choose (MVP.md §15.3).
 *
 * The `index/` sidecar duplicates metadata that also lives in SQLite. That is
 * intentional: `ArtifactStorePort.exists` and `read` are id-keyed, and making
 * the body store depend on the database to answer them would invert the
 * dependency direction and make artifacts unrecoverable if the database were
 * lost. SQLite remains the query surface; this is a local index, not a second
 * source of truth.
 */
export interface ArtifactStoreOptions {
  readonly paths: TandemisePaths;
  readonly clock?: Clock;
}

const SHA_PREFIX = 'sha256:';

export function createFilesystemArtifactStore(options: ArtifactStoreOptions): ArtifactStorePort {
  const { paths } = options;
  const clock = options.clock ?? systemClock;
  /** id → workspace, so the common case never scans the workspaces directory. */
  const workspaceOfArtifact = new Map<ArtifactId, string>();

  const rootFor = (workspaceId: string): string => paths.artifacts(workspaceId);
  const indexPath = (workspaceId: string, id: ArtifactId): string => join(rootFor(workspaceId), 'index', `${id}.json`);

  /**
   * The port resolves artifacts by id alone, but an id does not name a
   * workspace. The workspace segment is recovered by looking in the index of
   * each workspace that has one - in practice one, and the scan is a directory
   * listing rather than a file walk.
   */
  const findManifest = (id: ArtifactId): ArtifactManifest | undefined => {
    const known = workspaceOfArtifact.get(id);
    const candidates = known !== undefined ? [known] : listWorkspaces(paths);
    for (const workspaceId of candidates) {
      const file = indexPath(workspaceId, id);
      if (!existsSync(file)) continue;
      workspaceOfArtifact.set(id, workspaceId);
      return JSON.parse(readFileSync(file, 'utf8')) as ArtifactManifest;
    }
    return undefined;
  };

  const requireManifest = (id: ArtifactId): ArtifactManifest => {
    const manifest = findManifest(id);
    if (!manifest) throw TandemiseError.notFound('Artifact', id);
    return manifest;
  };

  const resolvePath = (manifest: ArtifactManifest): string => {
    const root = rootFor(manifest.workspaceId);
    if (manifest.contentRef.startsWith(SHA_PREFIX)) return blobPath(root, manifest.contentRef.slice(SHA_PREFIX.length));
    return join(root, manifest.contentRef);
  };

  return {
    async write(request: ArtifactWriteRequest): Promise<ArtifactManifest> {
      const id = ids.artifact();
      const bytes = toBytes(request.body);
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const root = rootFor(request.workspaceId);
      const mediaType = request.mediaType ?? defaultMediaTypeFor(request.type);

      // Evidence and binary payloads are deduplicated; structured artifacts keep
      // a readable path because a human opens them and a diff shows them.
      const contentAddressed = request.type === 'Evidence' || request.body instanceof Uint8Array;
      const contentRef = contentAddressed
        ? `${SHA_PREFIX}${sha256}`
        : join(request.missionId, request.type, `${id}${extensionFor(mediaType)}`);
      const target = contentAddressed ? blobPath(root, sha256) : join(root, contentRef);

      if (!contentAddressed || !existsSync(target)) atomicWrite(target, bytes);

      const manifest: ArtifactManifest = {
        id,
        workspaceId: request.workspaceId,
        missionId: request.missionId,
        taskId: request.taskId ?? null,
        createdByRunId: request.createdByRunId ?? null,
        type: request.type,
        title: request.title,
        contentRef,
        mediaType,
        sha256,
        byteSize: bytes.byteLength,
        schemaVersion: 1,
        sourceRefs: request.sourceRefs ?? [],
        supersedes: request.supersedes ?? null,
        summary: request.summary ?? null,
        createdAt: clock.now(),
      };
      atomicWrite(indexPath(request.workspaceId, id), Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'));
      workspaceOfArtifact.set(id, request.workspaceId);
      return manifest;
    },

    async read(id: ArtifactId): Promise<LoadedArtifact> {
      const manifest = requireManifest(id);
      return { manifest, body: readFileSync(resolvePath(manifest), 'utf8') };
    },

    async readBinary(id: ArtifactId): Promise<Uint8Array> {
      const manifest = requireManifest(id);
      return new Uint8Array(readFileSync(resolvePath(manifest)));
    },

    resolvePath,

    exists(id: ArtifactId): boolean {
      const manifest = findManifest(id);
      return manifest !== undefined && existsSync(resolvePath(manifest));
    },
  };
}

function blobPath(root: string, sha256: string): string {
  // Two-character fan-out keeps any single directory from collecting tens of
  // thousands of screenshots, which several filesystems handle badly.
  return join(root, 'blobs', sha256.slice(0, 2), sha256);
}

function extensionFor(mediaType: string): string {
  if (mediaType.startsWith('text/markdown')) return '.md';
  if (mediaType.startsWith('application/json')) return '.json';
  if (mediaType.startsWith('text/')) return '.txt';
  return '.bin';
}

function toBytes(body: string | Uint8Array): Buffer {
  return body instanceof Uint8Array ? Buffer.from(body) : Buffer.from(body, 'utf8');
}

/**
 * Write-to-temp-then-rename. A crash mid-write must not leave a truncated body
 * whose manifest claims a sha256 it no longer has; rename within a directory is
 * atomic on every filesystem Tandemise supports.
 */
function atomicWrite(target: string, bytes: Buffer): void {
  const dir = dirname(target);
  mkdirSync(dir, { recursive: true });
  const temp = join(dir, `.${randomUUID()}.tmp`);
  try {
    writeFileSync(temp, bytes, { mode: 0o600 });
    renameSync(temp, target);
  } catch (e) {
    rmSync(temp, { force: true });
    throw new TandemiseError('INTERNAL', `Failed to write artifact body to ${target}`, { cause: e });
  }
}

function listWorkspaces(paths: TandemisePaths): readonly string[] {
  try {
    return readdirSync(paths.workspaces, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    // No workspaces directory yet: nothing has been written, so nothing resolves.
    return [];
  }
}
