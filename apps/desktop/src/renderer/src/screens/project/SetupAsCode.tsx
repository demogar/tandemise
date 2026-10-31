import { useState } from 'react';
import { useLocation } from 'wouter';
import type { Repository } from '@tandemise/domain';
import type { SetupApplyView, SetupExportView, SetupItemView, SetupPreviewView, SkillPreviewView } from '@tandemise/api-contract';
import { Icon } from '../../components/Icon.js';
import { ErrorState, Segmented, SectionHead } from '../../components/primitives.js';
import { useDaemonMutation, useSetupStatus } from '../../lib/queries.js';
import { showFlash } from '../../lib/notices.js';
import { SkillPreview } from '../skills/SkillPreview.js';
import { evalsHref } from '../evals/link.js';
import { Banner, Button, Card } from '@tandemise/design/react';

type NeedsImport = NonNullable<SetupItemView['needsImport']>;

const KIND_LABEL: Readonly<Record<SetupItemView['kind'], string>> = {
  settings: 'Project', wip: 'Project', monthly_limits: 'Limits', mission_limits: 'Limits',
  role: 'Role', workflow: 'Workflow', routine: 'Routine', skill: 'Skill', issues: 'Issues',
  mcps: 'Connection', tracker: 'Tracker', intake: 'Intake', planner: 'Planning rules', routing: 'Model routing', merge: 'Merge policy',
};
const ACTION_LABEL: Readonly<Record<SetupItemView['action'], string>> = { add: 'Add', change: 'Change', remove: 'Remove', same: 'Same' };
const ACTION_CLASS: Readonly<Record<SetupItemView['action'], string>> = {
  add: 'badge badge--succeeded', change: 'badge badge--running', remove: 'badge badge--failed', same: 'chip chip--muted',
};

/**
 * Setup as code (P15): the project's roles, workflows, routines, limits and
 * settings as files in a repository's `.tandemise/` folder.
 *
 * Export writes them; Import reads a folder and shows, row by row, what taking
 * the files' version would change. Nothing changes until Apply, and an import
 * never starts work: routines and GitHub issue settings arrive off. A pinned
 * skill whose files are not on this machine is never applied; its row offers
 * to import it from where it came from, with the Skills screen's preview.
 */
export function SetupAsCode({ workspaceId, repositories, defaultRepositoryId }: {
  workspaceId: string;
  repositories: readonly Repository[];
  defaultRepositoryId: string | null;
}): JSX.Element {
  const status = useSetupStatus();
  const [, navigate] = useLocation();
  const [repositoryId, setRepositoryId] = useState<string>(defaultRepositoryId ?? repositories[0]?.id ?? '');
  const [exported, setExported] = useState<SetupExportView | null>(null);
  const [preview, setPreview] = useState<{ path: string; view: SetupPreviewView } | null>(null);
  const [choices, setChoices] = useState<Record<string, 'mine' | 'theirs'>>({});
  const [applied, setApplied] = useState<SetupApplyView | null>(null);
  const [fetching, setFetching] = useState<{ wanted: NeedsImport; preview: SkillPreviewView } | null>(null);

  const exportSetup = useDaemonMutation((daemon, id: string) => daemon.exportSetup(workspaceId, id), ['workspaces']);
  const previewSetup = useDaemonMutation((daemon, path: string) => daemon.previewSetup(workspaceId, path), []);
  const applySetup = useDaemonMutation(
    (daemon, body: { path: string; hash: string; choices: Record<string, 'mine' | 'theirs'> }) => daemon.applySetup(workspaceId, body),
    ['workspaces', 'missions'],
  );

  const previewSkill = useDaemonMutation((daemon, wanted: NeedsImport) => daemon.previewSkill(workspaceId, wanted.source), []);
  const importSkill = useDaemonMutation(
    (daemon, body: { wanted: NeedsImport; hash: string }) => daemon.importSkill(workspaceId, { source: body.wanted.source, hash: body.hash }),
    ['workspaces'],
  );

  const last = status.data?.lastExport ?? null;
  const chosen = repositoryId !== '' && repositories.some((r) => r.id === repositoryId) ? repositoryId : repositories[0]?.id ?? '';

  const runExport = (): void => {
    setApplied(null);
    exportSetup.mutate(chosen, { onSuccess: (view) => setExported(view) });
  };

  const readFolder = (path: string): void => {
    previewSetup.mutate(path, {
      onSuccess: (view) => {
        setPreview({ path, view });
        setChoices(Object.fromEntries(view.items.flatMap((i) => (i.choice === null ? [] : [[i.id, i.choice]]))));
      },
    });
  };

  const pickImport = async (): Promise<void> => {
    const path = await window.tandemise.selectDirectory('Choose a repository (or its .tandemise folder) to import from');
    if (!path) return;
    setApplied(null);
    setExported(null);
    setFetching(null);
    readFolder(path);
  };

  const startFetch = (wanted: NeedsImport): void => {
    setFetching(null);
    previewSkill.mutate(wanted, { onSuccess: (view) => setFetching({ wanted, preview: view }) });
  };

  const runFetch = (): void => {
    if (fetching === null || fetching.preview.hash === null) return;
    importSkill.mutate({ wanted: fetching.wanted, hash: fetching.preview.hash }, {
      onSuccess: (view) => {
        showFlash(view.message);
        setFetching(null);
        // The skill is in the library now: read the folder again so its rows can be taken.
        if (preview !== null) readFolder(preview.path);
      },
    });
  };

  const taking = preview === null ? 0 : preview.view.items.filter((i) => i.choice !== null && choices[i.id] === 'theirs').length;
  const runApply = (): void => {
    if (preview === null) return;
    applySetup.mutate({ path: preview.path, hash: preview.view.hash, choices }, {
      onSuccess: (view) => {
        setApplied(view);
        setPreview(null);
        showFlash(view.applied === 0 ? 'Nothing was changed.' : `Applied ${view.applied} ${view.applied === 1 ? 'change' : 'changes'}.`);
      },
    });
  };

  return (
    <section className="section" aria-label="Setup as code">
      <SectionHead title="Setup as code" meta={last === null ? 'Not exported yet' : `Last exported ${last.hash}`} />

      <Card>
        <div className="field__label">Export</div>
        <p className="field__hint" style={{ marginBottom: 'var(--s3)' }}>
          Writes your roles, workflows, routines, limits, project settings, skill pins and GitHub issue settings into{' '}
          <span className="mono">.tandemise/</span> in a repository, so you can commit them and bring them to another machine.
          Skills are listed by name, version and content hash in <span className="mono">skills.lock</span>, never copied. No
          secrets and no timestamps: the same setup always writes the same bytes.
        </p>
        {repositories.length === 0 ? (
          <p className="muted">Add a repository above first: the files are written into it.</p>
        ) : (
          <div className="row" style={{ gap: 'var(--s2)' }}>
            <select className="input" aria-label="Export to repository" value={chosen} onChange={(e) => setRepositoryId(e.target.value)} style={{ maxWidth: 280 }}>
              {repositories.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
            <Button disabled={exportSetup.isPending || chosen === ''} onClick={runExport}>
              <Icon name="folder" size={13} />
              {exportSetup.isPending ? 'Exporting…' : 'Export'}
            </Button>
          </div>
        )}
        {exportSetup.isError ? <ErrorState error={exportSetup.error} /> : null}
        {exported !== null ? <ExportResult view={exported} /> : null}
      </Card>

      <Card style={{ marginTop: 'var(--s3)' }}>
        <div className="field__label">Import</div>
        <p className="field__hint" style={{ marginBottom: 'var(--s3)' }}>
          Reads a <span className="mono">.tandemise</span> folder and shows what would change, item by item. Nothing changes until you
          press Apply. Imported routines and issue settings arrive off, so an import never starts work.
        </p>
        <div className="row" style={{ gap: 'var(--s2)' }}>
          <Button disabled={previewSetup.isPending} onClick={() => void pickImport()}>
            <Icon name="folder" size={13} />
            {previewSetup.isPending ? 'Reading…' : 'Import from a folder…'}
          </Button>
        </div>
        {previewSetup.isError ? <ErrorState error={previewSetup.error} /> : null}
        {preview !== null ? (
          <Preview
            view={preview.view}
            choices={choices}
            onChoose={(id, choice) => setChoices((current) => ({ ...current, [id]: choice }))}
            onFetch={startFetch}
            fetchingName={previewSkill.isPending ? previewSkill.variables?.name ?? null : null}
          />
        ) : null}
        {previewSkill.isError ? <ErrorState error={previewSkill.error} /> : null}
        {preview !== null && fetching !== null ? (
          <FetchSkill
            wanted={fetching.wanted}
            preview={fetching.preview}
            pending={importSkill.isPending}
            onImport={runFetch}
            onCancel={() => setFetching(null)}
          />
        ) : null}
        {importSkill.isError ? <ErrorState error={importSkill.error} /> : null}
        {preview !== null ? (
          <div className="row" style={{ gap: 'var(--s2)', marginTop: 'var(--s3)' }}>
            <Button variant="primary" disabled={applySetup.isPending} onClick={runApply}>
              {applySetup.isPending ? 'Applying…' : taking === 0 ? 'Apply (nothing to take)' : `Apply ${taking} ${taking === 1 ? 'change' : 'changes'}`}
            </Button>
            <Button variant="ghost" onClick={() => { setPreview(null); setFetching(null); }}>Cancel</Button>
            {/* Tries these files against the project's eval cases first; nothing here is applied. */}
            <Button
              style={{ marginLeft: 'auto' }}
              onClick={() => navigate(evalsHref({ tab: 'runs', candidate: { kind: 'setup', folder: preview.path } }))}
            >
              <Icon name="target" size={13} />
              Try on evals
            </Button>
          </div>
        ) : null}
        {applySetup.isError ? <ErrorState error={applySetup.error} /> : null}
        {applied !== null ? (
          <div className="stack" style={{ marginTop: 'var(--s3)' }} aria-label="Import applied">
            <p>
              {applied.applied === 0
                ? 'Nothing was changed.'
                : `Applied ${applied.applied} ${applied.applied === 1 ? 'change' : 'changes'}. Imported routines and issue settings are off until you turn them on (Missions → Routines, Repositories → Issues).`}
              {applied.kept > 0 ? ` Kept yours for ${applied.kept}.` : ''}
            </p>
            {applied.lines.map((line) => <p key={line} className="muted" style={{ fontSize: 'var(--fs-sm)' }}>{line}</p>)}
          </div>
        ) : null}
      </Card>
    </section>
  );
}

function ExportResult({ view }: { view: SetupExportView }): JSX.Element {
  const written = view.files.filter((f) => f.status === 'written').length;
  return (
    <div className="stack" style={{ marginTop: 'var(--s3)' }} aria-label="Export result">
      <p>
        Wrote {written} {written === 1 ? 'file' : 'files'} to {view.repositoryName}/.tandemise · Content hash <span className="mono">{view.hash}</span>
      </p>
      <ul className="mono muted" style={{ fontSize: 'var(--fs-xs)', margin: 0, paddingLeft: 'var(--s4)' }}>
        {view.files.map((file) => (
          <li key={file.path}>
            {file.path} · {file.bytes} B{file.status === 'kept' ? ' · already here, left as it is' : ''}
          </li>
        ))}
        {view.removed.map((path) => <li key={path}>{path} · removed (no longer in your setup)</li>)}
      </ul>
      {view.secrets.length > 0 ? (
        <p className="muted" style={{ fontSize: 'var(--fs-sm)' }}>
          {view.secrets.length} {view.secrets.length === 1 ? 'secret was' : 'secrets were'} replaced with a placeholder
          ({view.secrets.map((s) => `${s.name} in ${s.file}`).join(', ')}). Put the values back by hand after importing.
        </p>
      ) : null}
      {view.warnings.map((warning) => <Banner key={warning} tone="warn">{warning}</Banner>)}
    </div>
  );
}

/**
 * A pinned skill fetched from its recorded source, shown exactly as the Skills
 * screen shows an import. Files that no longer match the pin are not offered:
 * importing them would not supply what the setup pins.
 */
function FetchSkill({ wanted, preview, pending, onImport, onCancel }: {
  wanted: NeedsImport;
  preview: SkillPreviewView;
  pending: boolean;
  onImport: () => void;
  onCancel: () => void;
}): JSX.Element {
  const matches = preview.problem === null && preview.hash === wanted.hash;
  return (
    <div className="stack" style={{ marginTop: 'var(--s3)' }} aria-label="Import a pinned skill">
      <SkillPreview preview={preview} />
      {preview.problem === null && !matches ? (
        <Banner tone="warn">
          The source now has different files ({preview.shortHash ?? 'unknown'}) from the ones your setup pins ({wanted.hash.slice(0, 12)}).
          Importing them would not supply {wanted.name} v{wanted.version}. Ask for the files it was exported with, or change the pin.
        </Banner>
      ) : null}
      <div className="row" style={{ gap: 'var(--s2)' }}>
        <Button variant="primary" disabled={!matches || pending} onClick={onImport}>
          {pending ? 'Importing…' : `Import ${wanted.name}`}
        </Button>
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}

function Preview({ view, choices, onChoose, onFetch, fetchingName }: {
  view: SetupPreviewView;
  choices: Record<string, 'mine' | 'theirs'>;
  onChoose: (id: string, choice: 'mine' | 'theirs') => void;
  onFetch: (wanted: NeedsImport) => void;
  fetchingName: string | null;
}): JSX.Element {
  const { counts } = view;
  // Differences first; what is the same is listed last, for completeness.
  const rows = [...view.items].sort((a, b) => Number(a.action === 'same') - Number(b.action === 'same'));
  return (
    <div style={{ marginTop: 'var(--s3)' }} aria-label="Import preview">
      <p>
        From <span className="mono">{view.folder}</span>: {counts.add} to add · {counts.change} to change · {counts.remove} to remove · {counts.same} the same
      </p>
      {view.ignored.length > 0 ? (
        <p className="muted" style={{ fontSize: 'var(--fs-sm)' }}>Not read by this version: {view.ignored.join(', ')}.</p>
      ) : null}
      <table className="table" style={{ marginTop: 'var(--s2)' }}>
        <thead>
          <tr><th>Item</th><th>Kind</th><th>Change</th><th>Your choice</th></tr>
        </thead>
        <tbody>
          {rows.map((item) => (
            <tr key={item.id} aria-label={`${item.name}: ${ACTION_LABEL[item.action]}`}>
              <td>
                <div>{item.name}</div>
                {item.detail !== '' && item.action !== 'same' ? <div className="muted" style={{ fontSize: 'var(--fs-xs)' }}>{item.detail}</div> : null}
                {item.problem !== null ? <div className="field__error">{item.problem}</div> : null}
                {item.needsImport !== null ? (
                  <Button
                    style={{ marginTop: 'var(--s1)' }}
                    disabled={fetchingName !== null}
                    onClick={() => onFetch(item.needsImport!)}
                  >
                    {fetchingName === item.needsImport.name ? 'Reading…' : `Fetch ${item.needsImport.name} from its source…`}
                  </Button>
                ) : null}
                {item.notes.map((note) => <div key={note} className="muted" style={{ fontSize: 'var(--fs-xs)' }}>{note}</div>)}
              </td>
              <td className="muted">{KIND_LABEL[item.kind]}</td>
              <td><span className={ACTION_CLASS[item.action]}>{ACTION_LABEL[item.action]}</span></td>
              <td>
                {item.choice === null ? (
                  <span className="dim">{item.problem !== null ? 'Keep mine' : '—'}</span>
                ) : (
                  <Segmented
                    label={`Choice for ${item.name}`}
                    value={choices[item.id] ?? item.choice}
                    options={[{ value: 'mine', label: 'Keep mine' }, { value: 'theirs', label: 'Take theirs' }]}
                    onChange={(next) => onChoose(item.id, next)}
                  />
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
