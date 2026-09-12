import type { ArtifactManifest } from '@tandemise/domain';
import { Icon, type IconName } from '../../components/Icon.js';
import { bytes, relativeTime, titleCase } from '../../lib/format.js';

export function ArtifactRows({
  artifacts,
  selectedId,
  onSelect,
  groupByType = false,
}: {
  artifacts: readonly ArtifactManifest[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  groupByType?: boolean;
}): JSX.Element {
  const groups = groupByType ? groupArtifacts(artifacts) : ([['', artifacts]] as const);

  return (
    <>
      {groups.map(([type, items]) => (
        <div key={type || 'all'}>
          {type ? <div className="sidebar__section">{titleCase(type)}</div> : null}
          {items.map((artifact) => (
            <button
              key={artifact.id}
              type="button"
              className="list__row"
              data-active={artifact.id === selectedId}
              style={{ border: 'none', borderBottom: '1px solid var(--border)', background: 'transparent' }}
              onClick={() => onSelect(artifact.id)}
            >
              <Icon name={iconFor(artifact.type)} size={15} className="dim" />
              <div className="list__main">
                <div className="list__title">{artifact.title}</div>
                <div className="list__subtitle truncate">
                  {artifact.summary ?? `${bytes(artifact.byteSize)} · ${artifact.mediaType}`}
                </div>
              </div>
              <span className="dim" style={{ fontSize: 'var(--fs-micro)', flex: 'none' }}>
                {relativeTime(artifact.createdAt)}
              </span>
            </button>
          ))}
        </div>
      ))}
    </>
  );
}

function groupArtifacts(artifacts: readonly ArtifactManifest[]): readonly (readonly [string, readonly ArtifactManifest[]])[] {
  const byType = new Map<string, ArtifactManifest[]>();
  for (const artifact of artifacts) {
    const bucket = byType.get(artifact.type);
    if (bucket) bucket.push(artifact);
    else byType.set(artifact.type, [artifact]);
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
