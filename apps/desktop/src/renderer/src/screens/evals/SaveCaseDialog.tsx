import { useState } from 'react';
import { Link } from 'wouter';
import type { SaveEvalCaseRequest } from '@tandemise/api-contract';
import { Modal } from '../../components/Modal.js';
import { Field } from '../../components/primitives.js';
import { useEvalSuites } from '../../lib/queries.js';
import { evalsHref } from './link.js';
import { Refusal, useEvalMutation } from './shared.js';

const NEW_SUITE = '__new__';
const NAME_MAX = 80;

/**
 * Freezes a finished, gated step as an eval case (spec B2): into a suite the
 * project already has, or a new one named here. The daemon decides whether
 * the step can be a case, and a refusal is shown in its own words.
 */
export function SaveCaseDialog({ task, onClose }: { task: { readonly id: string; readonly title: string }; onClose: () => void }): JSX.Element {
  const suites = useEvalSuites();
  const list = suites.data ?? [];
  const [picked, setPicked] = useState<string | null>(null);
  const [newSuiteName, setNewSuiteName] = useState('');
  const [name, setName] = useState(task.title.slice(0, NAME_MAX));
  const [saved, setSaved] = useState<{ suiteId: string; suiteName: string } | null>(null);
  const save = useEvalMutation((daemon, body: SaveEvalCaseRequest) => daemon.saveEvalCase(task.id, body));

  // With no suite yet, the only choice is a new one.
  const choice = picked ?? list[0]?.id ?? NEW_SUITE;
  const creating = choice === NEW_SUITE;
  const ready = name.trim() !== '' && (!creating || newSuiteName.trim() !== '');

  const submit = (): void => {
    if (!ready) return;
    const body: SaveEvalCaseRequest = creating ? { newSuiteName: newSuiteName.trim(), name: name.trim() } : { suiteId: choice, name: name.trim() };
    save.mutate(body, {
      onSuccess: (kase) => setSaved({ suiteId: kase.suiteId, suiteName: creating ? newSuiteName.trim() : list.find((s) => s.id === choice)?.name ?? '' }),
    });
  };

  return (
    <Modal
      title="Save as eval case"
      onClose={onClose}
      footer={
        saved ? (
          <button type="button" className="btn btn--primary" data-autofocus onClick={onClose}>Done</button>
        ) : (
          <>
            <button type="button" className="btn btn--ghost" onClick={onClose}>Cancel</button>
            <button type="button" className="btn btn--primary" disabled={!ready || save.isPending} onClick={submit}>
              {save.isPending ? 'Saving…' : 'Save case'}
            </button>
          </>
        )
      }
    >
      {saved ? (
        <p role="status" style={{ margin: 0 }} aria-label="Saved">
          Saved to {saved.suiteName}.{' '}
          <Link href={evalsHref({ tab: 'suites', suite: saved.suiteId })} onClick={onClose}>Open Evals</Link>
        </p>
      ) : (
        <div className="stack" style={{ gap: 'var(--s4)' }}>
          <p className="muted" style={{ margin: 0, fontSize: 'var(--fs-sm)' }}>
            The step's inputs, starting commit and completion gate are kept, so it can be run again later against a different model, skill or setup.
          </p>
          <Field label="Suite">
            <select className="select" aria-label="Suite" value={choice} onChange={(event) => setPicked(event.target.value)}>
              {list.map((suite) => <option key={suite.id} value={suite.id}>{suite.name}</option>)}
              <option value={NEW_SUITE}>New suite…</option>
            </select>
          </Field>
          {creating ? (
            <Field label="New suite name">
              <input
                className="input"
                aria-label="New suite name"
                maxLength={NAME_MAX}
                value={newSuiteName}
                placeholder="e.g. Backend changes"
                onChange={(event) => setNewSuiteName(event.target.value)}
              />
            </Field>
          ) : null}
          <Field label="Case name">
            <input className="input" aria-label="Case name" maxLength={NAME_MAX} value={name} onChange={(event) => setName(event.target.value)} />
          </Field>
          {save.isError ? <Refusal error={save.error} /> : null}
        </div>
      )}
    </Modal>
  );
}
