import { useState } from 'react';
import type { SkillImportView, SkillPreviewView, SkillSourceRequest } from '@tandemise/api-contract';
import { Modal } from '../../components/Modal.js';
import { Empty, ErrorState, Field, Segmented, SkeletonList } from '../../components/primitives.js';
import { useDaemon } from '../../lib/connection.js';
import { useDaemonMutation, useDiscoveredSkills } from '../../lib/queries.js';
import { useWorkspaceId } from '../../lib/workspace.js';
import { SkillPreview } from './SkillPreview.js';

type From = 'claude' | 'folder' | 'git';

const FROM: readonly { value: From; label: string }[] = [
  { value: 'claude', label: 'Your Claude skills' },
  { value: 'folder', label: 'A folder' },
  { value: 'git', label: 'A git repository' },
];

/**
 * Import skills (P13): from the person's ~/.claude/skills (ticked from a
 * list), a folder, or a git repository. Every source is previewed first - the
 * files and the SKILL.md - and an import stores exactly what was previewed.
 */
export function ImportSkills({ onClose, onImported }: { onClose: () => void; onImported: (messages: readonly string[]) => void }): JSX.Element {
  const [from, setFrom] = useState<From>('claude');
  return (
    <Modal title="Import skills" wide onClose={onClose}>
      <div className="stack" style={{ gap: 'var(--s4)' }}>
        <p className="muted" style={{ margin: 0, fontSize: 'var(--fs-sm)' }}>
          A skill is a folder with a SKILL.md. You see its files before it is imported, nothing in it is run, and each
          import is kept as a numbered version your roles pin.
        </p>
        <Segmented value={from} options={FROM} onChange={setFrom} />
        {from === 'claude' ? <FromClaude onImported={onImported} /> : <FromSource kind={from} onImported={onImported} />}
      </div>
    </Modal>
  );
}

function FromClaude({ onImported }: { onImported: (messages: readonly string[]) => void }): JSX.Element {
  const found = useDiscoveredSkills(true);
  const daemon = useDaemon();
  const workspaceId = useWorkspaceId() ?? '';
  const [ticked, setTicked] = useState<readonly string[]>([]);
  const [preview, setPreview] = useState<SkillPreviewView | null>(null);
  const [previewError, setPreviewError] = useState<unknown>(null);

  const importAll = useDaemonMutation(async (client, paths: readonly string[]) => {
    const done: SkillImportView[] = [];
    for (const path of paths) {
      const skill = found.data?.skills.find((s) => s.path === path);
      if (skill?.hash == null) continue;
      done.push(await client.importSkill(workspaceId, { source: { kind: 'claude', path }, hash: skill.hash }));
    }
    return done;
  }, ['workspaces']);

  const open = async (path: string): Promise<void> => {
    setPreviewError(null);
    try {
      setPreview(await daemon.previewSkill(workspaceId, { kind: 'claude', path }));
    } catch (e) {
      setPreview(null);
      setPreviewError(e);
    }
  };

  if (found.isError) return <ErrorState error={found.error} onRetry={() => void found.refetch()} />;
  if (found.isPending || found.data === undefined) return <SkeletonList rows={3} />;
  const { root, exists, skills } = found.data;

  return (
    <div className="stack" style={{ gap: 'var(--s3)' }}>
      <p className="dim" style={{ margin: 0, fontSize: 'var(--fs-xs)' }}>Looking in <span className="mono">{root}</span></p>
      {!exists || skills.length === 0 ? (
        <div className="card">
          <Empty
            icon="book"
            title={exists ? 'No skill folders here' : 'This folder does not exist'}
            body="Import a skill from a folder or a git repository instead."
          />
        </div>
      ) : (
        <div className="list" aria-label="Found skills">
          {skills.map((skill) => {
            const on = ticked.includes(skill.path);
            return (
              <div key={skill.path} className="list__row" aria-label={`Found: ${skill.folder}`} style={{ alignItems: 'flex-start' }}>
                <input
                  type="checkbox"
                  aria-label={`Import ${skill.folder}`}
                  checked={on}
                  disabled={!skill.importable}
                  onChange={(e) => setTicked(e.target.checked ? [...ticked, skill.path] : ticked.filter((p) => p !== skill.path))}
                />
                <div className="list__main">
                  <div className="list__title">{skill.name ?? skill.folder}</div>
                  {skill.description ? <div className="list__subtitle">{skill.description}</div> : null}
                  {skill.problem !== null ? (
                    <div className="list__subtitle"><span className="badge badge--failed" style={{ whiteSpace: 'normal' }}>{skill.problem}</span></div>
                  ) : (
                    <div className="list__subtitle dim" style={{ fontSize: 'var(--fs-xs)' }}>
                      {skill.fileCount} {skill.fileCount === 1 ? 'file' : 'files'} · {skill.sizeLabel}
                      {skill.libraryLabel ? ` · ${skill.libraryLabel}` : ''}
                    </div>
                  )}
                </div>
                <div className="list__aside">
                  <button type="button" className="btn btn--ghost" onClick={() => void open(skill.path)}>Preview</button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {previewError !== null ? <ErrorState error={previewError} /> : null}
      {preview !== null ? <SkillPreview preview={preview} /> : null}
      {importAll.isError ? <ErrorState error={importAll.error} /> : null}

      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button
          type="button"
          className="btn btn--primary"
          disabled={ticked.length === 0 || importAll.isPending}
          onClick={() => importAll.mutate(ticked, { onSuccess: (done) => onImported(done.map((d) => d.message)) })}
        >
          {importAll.isPending ? 'Importing…' : ticked.length === 1 ? 'Import 1 skill' : `Import ${ticked.length} skills`}
        </button>
      </div>
    </div>
  );
}

function FromSource({ kind, onImported }: { kind: 'folder' | 'git'; onImported: (messages: readonly string[]) => void }): JSX.Element {
  const daemon = useDaemon();
  const workspaceId = useWorkspaceId() ?? '';
  const [path, setPath] = useState('');
  const [url, setUrl] = useState('');
  const [subpath, setSubpath] = useState('');
  const [preview, setPreview] = useState<SkillPreviewView | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [previewing, setPreviewing] = useState(false);

  const source = (): SkillSourceRequest => kind === 'folder'
    ? { kind: 'path', path: path.trim() }
    : { kind: 'git', url: url.trim(), ...(subpath.trim() === '' ? {} : { subpath: subpath.trim() }) };

  const doImport = useDaemonMutation((client, hash: string) => client.importSkill(workspaceId, { source: source(), hash }), ['workspaces']);

  const run = async (): Promise<void> => {
    setError(null);
    setPreviewing(true);
    try {
      setPreview(await daemon.previewSkill(workspaceId, source()));
    } catch (e) {
      setPreview(null);
      setError(e);
    } finally {
      setPreviewing(false);
    }
  };

  const choose = async (): Promise<void> => {
    const picked = await window.tandemise.selectDirectory('Choose a skill folder');
    if (picked) { setPath(picked); setPreview(null); }
  };

  const ready = kind === 'folder' ? path.trim().length > 0 : url.trim().length > 0;

  return (
    <div className="stack" style={{ gap: 'var(--s3)' }}>
      {kind === 'folder' ? (
        <Field label="Folder" hint="The folder that holds the SKILL.md.">
          <div className="row" style={{ gap: 'var(--s2)' }}>
            <input className="input" aria-label="Skill folder" value={path} placeholder="/path/to/skill" onChange={(e) => { setPath(e.target.value); setPreview(null); }} />
            <button type="button" className="btn" onClick={() => void choose()}>Choose…</button>
          </div>
        </Field>
      ) : (
        <div className="grid grid--2">
          <Field label="Repository URL" hint="https://, ssh:// or git@host: — cloned shallow; nothing in it is run.">
            <input className="input" aria-label="Repository URL" value={url} placeholder="https://example.com/team/skills.git" onChange={(e) => { setUrl(e.target.value); setPreview(null); }} />
          </Field>
          <Field label="Subfolder" hint="Where the SKILL.md is, if not at the top.">
            <input className="input" aria-label="Subfolder" value={subpath} placeholder="skills/tdd" onChange={(e) => { setSubpath(e.target.value); setPreview(null); }} />
          </Field>
        </div>
      )}
      <div>
        <button type="button" className="btn" disabled={!ready || previewing} onClick={() => void run()}>
          {previewing ? 'Reading…' : 'Preview'}
        </button>
      </div>

      {error !== null ? <ErrorState error={error} /> : null}
      {preview !== null ? <SkillPreview preview={preview} /> : null}
      {doImport.isError ? <ErrorState error={doImport.error} /> : null}

      {preview !== null ? (
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button
            type="button"
            className="btn btn--primary"
            disabled={preview.hash === null || preview.problem !== null || !preview.changes || doImport.isPending}
            onClick={() => doImport.mutate(preview.hash!, { onSuccess: (done) => onImported([done.message]) })}
          >
            {doImport.isPending ? 'Importing…' : 'Import'}
          </button>
        </div>
      ) : null}
    </div>
  );
}
