import type { ArtifactView, MissionArtifactView } from '@tandemise/api-contract';
import { Icon, type IconName } from '../../components/Icon.js';
import { useActors } from '../../lib/team.js';
import { relativeTime, titleCase } from '../../lib/format.js';

/** A row may come from a mission list, which knows its version, or from search, which does not. */
type ListedArtifact = ArtifactView | MissionArtifactView;

/**
 * Artifacts as scannable lines: icon, title, the headline, who wrote it, when.
 *
 * Older versions are shown only when the list was given them, each indented
 * under the version that replaced it, so a revised document reads as one
 * entry with a history rather than as three documents with the same title.
 */
export function ArtifactRows({
  artifacts,
  selectedId,
  onSelect,
  groupByType = false,
}: {
  artifacts: readonly ListedArtifact[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  groupByType?: boolean;
}): JSX.Element {
  const lines = versionTree(artifacts);
  const groups = groupByType ? groupArtifacts(lines) : ([['', lines]] as const);

  return (
    <>
      {groups.map(([type, items]) => (
        <div key={type || 'all'}>
          {type ? <div className="sidebar__section">{titleCase(type)}</div> : null}
          {items.map(({ live, older }) => (
            <div key={live.id}>
              <ArtifactRow artifact={live} active={live.id === selectedId} onSelect={onSelect} />
              {older.map((artifact) => (
                <ArtifactRow key={artifact.id} artifact={artifact} older active={artifact.id === selectedId} onSelect={onSelect} />
              ))}
            </div>
          ))}
        </div>
      ))}
    </>
  );
}

function ArtifactRow({
  artifact,
  active,
  older = false,
  onSelect,
}: {
  artifact: ListedArtifact;
  active: boolean;
  older?: boolean;
  onSelect: (id: string) => void;
}): JSX.Element {
  const actors = useActors();
  const version = 'version' in artifact ? artifact.version : null;
  // A legacy artifact has no handoff; its summary stands in, as it does in the reader.
  const headline = artifact.handoff?.headline ?? artifact.summary;
  const by = artifact.author ?? actors.ref(artifact.authorId);
  return (
    <button
      type="button"
      className={`list__row artifact-row${older ? ' artifact-row--older' : ''}`}
      data-active={active}
      onClick={() => onSelect(artifact.id)}
      title={older ? `Older version of ${artifact.title}` : undefined}
    >
      <Icon name={older ? 'clock' : iconFor(artifact.type)} size={older ? 13 : 15} className="dim" />
      <div className="list__main">
        <div className="artifact-row__title">
          <span className="list__title">{artifact.title}</span>
          {version !== null && (older || version > 1) ? <span className="chip artifact-row__version">v{version}</span> : null}
        </div>
        {headline ? <div className="list__subtitle truncate">{headline}</div> : null}
      </div>
      {/* No id chip here: in a 320px column it left the title two letters
          wide, and the reader beside it has the id behind Details. */}
      <div className="artifact-row__aside">
        <span>{relativeTime(artifact.createdAt)}</span>
        {by && !older ? <span className="artifact-row__by truncate">by {by.id === actors.meId ? 'you' : by.name}</span> : null}
      </div>
    </button>
  );
}

interface VersionLine {
  readonly live: ListedArtifact;
  /** Its predecessors, newest first. Empty unless the list included superseded versions. */
  readonly older: readonly ListedArtifact[];
}

/**
 * Hangs each superseded version under its live successor by walking the
 * `supersedes` pointers back from every live row. A version whose line cannot
 * be walked (its successor missing from the list) stays a row of its own, so
 * nothing the daemon returned is silently dropped.
 */
function versionTree(artifacts: readonly ListedArtifact[]): readonly VersionLine[] {
  const byId = new Map(artifacts.map((a) => [a.id as string, a]));
  const isLive = (a: ListedArtifact): boolean => !('supersededBy' in a) || a.supersededBy === null;
  const placed = new Set<string>();
  const lines: VersionLine[] = [];
  for (const live of artifacts) {
    if (!isLive(live)) continue;
    const older: ListedArtifact[] = [];
    let cursor = live.supersedes ? byId.get(live.supersedes) : undefined;
    while (cursor && !placed.has(cursor.id)) {
      placed.add(cursor.id);
      older.push(cursor);
      cursor = cursor.supersedes ? byId.get(cursor.supersedes) : undefined;
    }
    placed.add(live.id);
    lines.push({ live, older });
  }
  for (const orphan of artifacts) {
    if (!placed.has(orphan.id)) lines.push({ live: orphan, older: [] });
  }
  return lines;
}

function groupArtifacts(lines: readonly VersionLine[]): readonly (readonly [string, readonly VersionLine[]])[] {
  const byType = new Map<string, VersionLine[]>();
  for (const line of lines) {
    const bucket = byType.get(line.live.type);
    if (bucket) bucket.push(line);
    else byType.set(line.live.type, [line]);
  }
  return [...byType.entries()];
}

export function iconFor(type: string): IconName {
  switch (type) {
    case 'ProductSpec':
    case 'ProblemBrief':
      return 'book';
    case 'DesignBrief':
      return 'sparkle';
    case 'ArchitecturePlan':
    case 'ImplementationPlan':
    case 'MissionPlan':
      return 'layers';
    case 'ChangeSet':
      return 'branch';
    case 'ReviewReport':
      return 'eye';
    case 'QAPlan':
    case 'QAReport':
      return 'target';
    case 'ReleaseCandidate':
      return 'zap';
    case 'DecisionRecord':
      return 'shield';
    case 'Evidence':
      return 'camera';
    default:
      return 'file';
  }
}
