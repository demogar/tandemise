import { useState } from 'react';
import { ErrorState } from './primitives.js';
import { useDaemonMutation, useRunBrain } from '../lib/queries.js';
import { useWorkspaceId } from '../lib/workspace.js';
import { showFlash } from '../lib/notices.js';
import { LessonRow } from '../screens/Brain.js';
import '../screens/Brain.css';
import { Button, Card } from '@tandemise/design/react';

/**
 * "What it knew" (#51 spec §11): the brain commit a run read, the rules files
 * it loaded, the lessons it was given or fetched, and what it proposed. Each
 * lesson can be voted on from here.
 */
export function WhatItKnew({ runId, taskId }: { runId: string; taskId: string }): JSX.Element | null {
  const view = useRunBrain(runId);
  if (view.isPending) return null;
  if (view.isError) return <ErrorState error={view.error} />;
  const v = view.data;
  const fetchedOnly = v.fetched.filter((f) => !v.loaded.some((l) => l.id === f.id));
  return (
    <section className="brain-knew" aria-label="What it knew">
      <div className="field__label">What it knew</div>
      <p style={{ margin: 0 }} aria-label="What it knew summary">
        {v.summary}{' '}
        <span className="muted">Brain commit {v.commitUrl ? <a className="mono" href={v.commitUrl} target="_blank" rel="noreferrer">{v.shortSha}</a> : <span className="mono">{v.shortSha}</span>}.</span>
      </p>
      {v.rules.length > 0 ? <p className="muted mono" style={{ margin: 0, fontSize: 'var(--fs-xs)' }} aria-label="Rules files">{v.rules.join(' · ')}</p> : null}
      {v.loaded.length + fetchedOnly.length > 0 ? (
        <ul className="brain__list" aria-label="Lessons it knew">
          {[...v.loaded, ...fetchedOnly].map((e) => <LessonRow key={e.id} entry={e} taskId={taskId} />)}
        </ul>
      ) : null}
      {v.proposed.length > 0 ? (
        <>
          <div className="field__label">Proposed by this run</div>
          <ul className="brain__list" aria-label="Proposed by this run">{v.proposed.map((e) => <LessonRow key={e.id} entry={e} taskId={taskId} />)}</ul>
        </>
      ) : null}
    </section>
  );
}

/** "Remember this" on a task: one sentence, scoped to the task's role and step. */
export function RememberThis({ taskId, roleId, stepKey }: { taskId: string; roleId: string; stepKey: string }): JSX.Element {
  const workspaceId = useWorkspaceId() ?? '';
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const remember = useDaemonMutation(
    (daemon, body: { text: string }) => daemon.remember(workspaceId, { text: body.text, scope: { role: roleId, step: stepKey }, taskId }),
    ['workspaces'],
  );
  if (!open) return <Button variant="ghost" className="btn--sm" onClick={() => setOpen(true)}>Remember this</Button>;
  return (
    <Card className="stack" aria-label="Remember this on the task">
      <textarea className="input" rows={2} aria-label="Remember this text" value={text} placeholder="What should the next person doing this step know?" onChange={(e) => setText(e.target.value)} />
      <div className="row" style={{ gap: 'var(--s2)' }}>
        <Button variant="primary" className="btn--sm" disabled={remember.isPending || text.trim() === ''} onClick={() => remember.mutate({ text: text.trim() }, { onSuccess: (v) => { setOpen(false); setText(''); showFlash(v.message); } })}>
          {remember.isPending ? 'Saving…' : 'Remember'}
        </Button>
        <Button variant="ghost" className="btn--sm" onClick={() => setOpen(false)}>Cancel</Button>
      </div>
      {remember.isError ? <ErrorState error={remember.error} /> : null}
    </Card>
  );
}
