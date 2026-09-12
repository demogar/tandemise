import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon.js';
import { Modal } from './Modal.js';
import { ErrorState, Field } from './primitives.js';
import { useWorkspace } from '../lib/workspace.js';
import { useDaemonMutation } from '../lib/queries.js';

/**
 * Which project this window is working on.
 *
 * It sits at the top of the sidebar rather than in Settings because it changes
 * what every screen below it is showing - a project is the frame, not a
 * setting. An install with one project still shows it, so the frame is visible
 * before there is anything to switch between.
 */
export function WorkspaceSwitcher(): JSX.Element {
  const { current, all, select } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: MouseEvent): void => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', dismiss);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('mousedown', dismiss);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  const repositories = current?.repositories.length ?? 0;

  return (
    <div className="wsswitch" ref={root}>
      <button
        type="button"
        className="wsswitch__trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="wsswitch__body">
          <span className="wsswitch__name truncate">{current?.workspace.name ?? 'No project'}</span>
          <span className="wsswitch__meta">
            {repositories === 0 ? 'No repositories' : `${repositories} ${repositories === 1 ? 'repository' : 'repositories'}`}
          </span>
        </span>
        <Icon name="chevronDown" size={13} />
      </button>

      {open ? (
        <div className="wsswitch__menu" role="listbox">
          {all.map((view) => (
            <button
              key={view.workspace.id}
              type="button"
              role="option"
              aria-selected={view.workspace.id === current?.workspace.id}
              className="wsswitch__option"
              onClick={() => {
                select(view.workspace.id);
                setOpen(false);
              }}
            >
              <span className="wsswitch__check">
                {view.workspace.id === current?.workspace.id ? <Icon name="check" size={13} /> : null}
              </span>
              <span className="truncate">{view.workspace.name}</span>
              <span className="wsswitch__count">{view.repositories.length}</span>
            </button>
          ))}
          <div className="wsswitch__sep" />
          <button
            type="button"
            className="wsswitch__option"
            onClick={() => {
              setOpen(false);
              setCreating(true);
            }}
          >
            <span className="wsswitch__check">
              <Icon name="plus" size={13} />
            </span>
            <span>New project…</span>
          </button>
        </div>
      ) : null}

      {creating ? <NewWorkspaceModal onClose={() => setCreating(false)} onCreated={select} /> : null}
    </div>
  );
}

function NewWorkspaceModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (id: string) => void;
}): JSX.Element {
  const [name, setName] = useState('');
  const [repositoryPath, setRepositoryPath] = useState('');

  const create = useDaemonMutation(
    (daemon) =>
      daemon.createWorkspace({
        name: name.trim(),
        ...(repositoryPath.trim() === '' ? {} : { repositoryPath: repositoryPath.trim() }),
      }),
    ['workspaces'],
  );

  const browse = async (): Promise<void> => {
    const path = await window.tandemise.selectDirectory('Choose a repository');
    if (path) setRepositoryPath(path);
  };

  return (
    <Modal
      title="New project"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={name.trim() === '' || create.isPending}
            onClick={() =>
              create.mutate(undefined, {
                onSuccess: (view) => {
                  onCreated(view.workspace.id);
                  onClose();
                },
              })
            }
          >
            {create.isPending ? 'Creating…' : 'Create project'}
          </button>
        </>
      }
    >
      <div className="stack" style={{ gap: 'var(--s4)', color: 'var(--text)' }}>
        <p className="muted">
          A project keeps its own repositories, integrations, roles and routing. Runtimes are shared across the install unless you scope
          one to a project.
        </p>
        <Field label="Name">
          <input className="input" value={name} onChange={(event) => setName(event.target.value)} placeholder="Beveloce" autoFocus />
        </Field>
        <Field label="First repository" hint="Optional. You can add this and others in Settings at any time.">
          <div className="row" style={{ gap: 'var(--s2)' }}>
            <input
              className="input mono"
              style={{ flex: 1 }}
              value={repositoryPath}
              onChange={(event) => setRepositoryPath(event.target.value)}
              placeholder="~/projects/beveloce/beveloce-web"
            />
            <button type="button" className="btn" onClick={() => void browse()}>
              <Icon name="folder" size={13} />
              Browse
            </button>
          </div>
        </Field>
        {create.isError ? <ErrorState error={create.error} /> : null}
      </div>
    </Modal>
  );
}
