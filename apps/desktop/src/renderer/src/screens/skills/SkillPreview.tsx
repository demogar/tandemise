import type { SkillPreviewView } from '@tandemise/api-contract';
import { stripFrontMatter } from '@tandemise/artifacts/strip-front-matter';
import { Markdown } from '../../components/Markdown.js';
import { Chip, Truncate } from '@tandemise/design/react';

/**
 * What importing a folder would bring in (P13): its files and its SKILL.md,
 * shown before anything is imported. Nothing in a skill is ever run; this is
 * where the person reads what they are about to pin to their agents.
 */
export function SkillPreview({ preview }: { preview: SkillPreviewView }): JSX.Element {
  return (
    <section aria-label="Preview" className="card stack" style={{ gap: 'var(--s3)' }}>
      <div className="stack" style={{ gap: 'var(--s1)' }}>
        <div className="row row--wrap" style={{ gap: 'var(--s2)' }}>
          <strong>{preview.name ?? 'Not a usable skill'}</strong>
          {preview.shortHash ? <Chip muted className="mono">{preview.shortHash}</Chip> : null}
          <span className="dim" style={{ fontSize: 'var(--fs-xs)' }}>{preview.sizeLabel}</span>
        </div>
        {preview.description ? <p className="muted" style={{ margin: 0 }}>{preview.description}</p> : null}
        <Truncate as="p" className="dim" style={{ margin: 0, fontSize: 'var(--fs-xs)' }}>From {preview.sourceLabel}</Truncate>
      </div>

      {preview.problem !== null ? (
        <p className="badge badge--failed" style={{ margin: 0, whiteSpace: 'normal' }}>{preview.problem}</p>
      ) : (
        <p style={{ margin: 0, fontWeight: 600 }}>{preview.outcome}</p>
      )}

      {preview.files.length > 0 ? (
        <div className="stack" style={{ gap: 'var(--s1)' }}>
          <span className="field__label">Files</span>
          <ul aria-label="Files" className="mono" style={{ margin: 0, paddingLeft: 'var(--s4)', fontSize: 'var(--fs-xs)' }}>
            {preview.files.map((file) => (
              <li key={file.path}>{file.path} <span className="dim">({file.size} B)</span></li>
            ))}
          </ul>
        </div>
      ) : null}

      {preview.skillMd !== null ? (
        <div className="stack" style={{ gap: 'var(--s1)' }}>
          <span className="field__label">SKILL.md</span>
          <div aria-label="SKILL.md" style={{ maxHeight: 260, overflow: 'auto', border: '1px solid var(--border)', borderRadius: 'var(--tds-radius-md)', padding: 'var(--s3)' }}>
            <Markdown source={stripFrontMatter(preview.skillMd)} />
          </div>
        </div>
      ) : null}
    </section>
  );
}
