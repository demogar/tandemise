import { Icon } from '../../components/Icon.js';
import { Markdown } from '../../components/Markdown.js';
import { Empty, ErrorState, Skeleton } from '../../components/primitives.js';
import { useArtifact } from '../../lib/queries.js';
import { bytes, dateTime, titleCase } from '../../lib/format.js';

export function ArtifactReader({ id }: { id: string | null }): JSX.Element {
  const artifact = useArtifact(id);

  if (!id) {
    return <Empty icon="artifacts" title="Select an artifact" body="Pick something on the left to read it here." />;
  }

  if (artifact.isPending) {
    return (
      <div className="stack" style={{ gap: 'var(--s4)' }}>
        <Skeleton height={28} width="55%" />
        <Skeleton height={12} width="30%" />
        <div style={{ height: 'var(--s4)' }} />
        {Array.from({ length: 8 }, (_, index) => (
          <Skeleton key={index} height={13} width={`${62 + ((index * 23) % 36)}%`} />
        ))}
      </div>
    );
  }

  if (artifact.isError) return <ErrorState error={artifact.error} onRetry={() => void artifact.refetch()} />;

  const { manifest, body } = artifact.data;
  const isText = manifest.mediaType.startsWith('text/') || manifest.mediaType === 'application/json';

  return (
    <article>
      <header className="reader__head">
        <h1 className="reader__title">{manifest.title}</h1>
        <div className="reader__meta">
          <span className="chip">{titleCase(manifest.type)}</span>
          <span>{dateTime(manifest.createdAt)}</span>
          <span className="sep">·</span>
          <span>{bytes(manifest.byteSize)}</span>
          <span className="sep">·</span>
          <span className="mono">{manifest.sha256.slice(0, 12)}</span>
          {manifest.sourceRefs.map((ref, index) => (
            <span key={index} className="chip chip--muted" title={ref.kind}>
              <Icon name={ref.kind.startsWith('git') ? 'branch' : 'link'} size={10} />
              {ref.label ?? ref.value}
            </span>
          ))}
        </div>
        {manifest.summary ? (
          <p className="muted" style={{ marginTop: 'var(--s3)', lineHeight: 1.6, maxWidth: '70ch' }}>
            {manifest.summary}
          </p>
        ) : null}
      </header>

      {isText ? (
        <Markdown source={body} />
      ) : (
        <div className="banner">
          <Icon name="file" size={15} className="dim" />
          <span>
            This artifact is <span className="mono">{manifest.mediaType}</span> and cannot be shown inline.
          </span>
          <button type="button" className="btn" onClick={() => void window.tandemise.revealInFinder(manifest.contentRef)}>
            Reveal in Finder
          </button>
        </div>
      )}
    </article>
  );
}
