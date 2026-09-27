import { useEffect, useState } from 'react';
import type { RepositoryIssuesView, UpdateIssueSettingsRequest } from '@tandemise/api-contract';
import { ErrorState, Field, SectionHead, Switch } from '../../components/primitives.js';
import { Icon } from '../../components/Icon.js';
import { useDaemonMutation, useIssues, useWorkflows } from '../../lib/queries.js';

/** Mirrors ISSUE_POLL_MINUTES in @tandemise/domain; the daemon refuses anything else. */
const POLL_MINUTES = [5, 10, 15, 30, 60] as const;

/**
 * GitHub issues in and out (P14): per repository, open issues with a label
 * become draft missions, and Tandemise reports back on them. Its own section
 * (and file) so the rest of the Repositories screen is untouched.
 */
export function Issues(): JSX.Element | null {
  const issues = useIssues();
  const repositories = issues.data?.repositories ?? [];
  if (repositories.length === 0) return null;
  return (
    <section className="section" aria-label="Issues">
      <SectionHead title="Issues" meta="Turn labelled GitHub issues into missions" />
      <div className="stack">
        {repositories.map((view) => <RepositoryIssues key={view.repositoryId} view={view} />)}
      </div>
      {issues.isError ? <ErrorState error={issues.error} /> : null}
    </section>
  );
}

interface Draft {
  githubRepo: string;
  label: string;
  pollMinutes: number;
  workflowPreset: string;
}

function draftOf(view: RepositoryIssuesView): Draft {
  return {
    githubRepo: view.settings.githubRepo ?? view.suggestedRepo ?? '',
    label: view.settings.label,
    pollMinutes: view.settings.pollMinutes,
    workflowPreset: view.settings.workflowPreset ?? '',
  };
}

function RepositoryIssues({ view }: { view: RepositoryIssuesView }): JSX.Element {
  const workflows = useWorkflows();
  const [draft, setDraft] = useState<Draft>(() => draftOf(view));
  const saved = draftOf(view);
  const key = JSON.stringify(saved);
  // A save (or another window) changed the stored settings: start from them again.
  useEffect(() => { setDraft(draftOf(view)); }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  const update = useDaemonMutation(
    (daemon, body: UpdateIssueSettingsRequest) => daemon.updateIssueSettings(view.repositoryId, body),
    ['missions'],
  );
  const checkNow = useDaemonMutation((daemon, _: void) => daemon.checkIssues(view.repositoryId), ['missions']);
  const dirty = JSON.stringify(draft) !== key;
  const s = view.settings;
  const fields = {
    githubRepo: draft.githubRepo.trim() === '' ? null : draft.githubRepo.trim(),
    label: draft.label,
    pollMinutes: draft.pollMinutes,
    workflowPreset: draft.workflowPreset === '' ? null : draft.workflowPreset,
  };

  return (
    <div className="card" aria-label={`Issues for ${view.repositoryName}`}>
      <div className="list__row" style={{ padding: 0, alignItems: 'flex-start' }}>
        <div className="list__main">
          <div className="list__title">{view.repositoryName}</div>
          <div className="list__subtitle">
            Open issues with the label become draft missions. An issue that lists “Done when” or “Acceptance criteria” is queued, ready to plan; any other waits for you to refine it.
          </div>
        </div>
        <div className="list__aside">
          <Switch
            checked={s.enabled}
            label="Turn labelled issues into missions"
            onChange={(enabled) => update.mutate(enabled ? { enabled, ...fields } : { enabled })}
          />
        </div>
      </div>

      <div className="grid grid--2" style={{ marginTop: 'var(--s3)' }}>
        <Field label="GitHub repository" hint="owner/name, as on github.com.">
          <input
            className="input mono"
            aria-label="GitHub repository"
            placeholder="owner/name"
            value={draft.githubRepo}
            onChange={(event) => setDraft({ ...draft, githubRepo: event.target.value })}
          />
        </Field>
        <Field label="Label" hint="Only open issues with this label are read.">
          <input
            className="input"
            aria-label="Label"
            value={draft.label}
            onChange={(event) => setDraft({ ...draft, label: event.target.value })}
          />
        </Field>
        <Field label="Check every" hint="Tandemise asks GitHub through the gh command line tool; nothing is pushed to it.">
          <select
            className="select"
            aria-label="Check every"
            value={draft.pollMinutes}
            onChange={(event) => setDraft({ ...draft, pollMinutes: Number(event.target.value) })}
          >
            {POLL_MINUTES.map((minutes) => <option key={minutes} value={minutes}>{minutes} minutes</option>)}
          </select>
        </Field>
        <Field label="Workflow" hint="How each mission from an issue is planned.">
          <select
            className="select"
            aria-label="Workflow for issues"
            value={draft.workflowPreset}
            onChange={(event) => setDraft({ ...draft, workflowPreset: event.target.value })}
          >
            <option value="">The project’s default</option>
            {(workflows.data ?? []).map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
          </select>
        </Field>
      </div>

      <div className="stack" style={{ marginTop: 'var(--s3)' }}>
        <div className="list__row" style={{ padding: 0 }}>
          <div className="list__main">
            <div className="list__title">Post progress comments</div>
            <div className="list__subtitle">Tandemise comments when it queues the work, when it is stuck, and when it is done, with each criterion and whether it was verified.</div>
          </div>
          <div className="list__aside">
            <Switch checked={s.postComments} label="Post progress comments" onChange={(postComments) => update.mutate({ postComments })} />
          </div>
        </div>
        <div className="list__row" style={{ padding: 0 }}>
          <div className="list__main">
            <div className="list__title">Close the issue when the mission completes</div>
            <div className="list__subtitle">Only when every criterion was verified. Otherwise the issue stays open and the comment says what was not.</div>
          </div>
          <div className="list__aside">
            <Switch checked={s.closeOnComplete} label="Close the issue when the mission completes" onChange={(closeOnComplete) => update.mutate({ closeOnComplete })} />
          </div>
        </div>
      </div>

      <div className="list__row" style={{ padding: 0, marginTop: 'var(--s3)' }}>
        <div className="list__main">
          <div className="list__subtitle" aria-label="Issue status">{view.statusLabel}</div>
          {s.enabled && s.lastError !== null ? <div className="field__error">{s.lastError}</div> : null}
        </div>
        <div className="list__aside">
          <button type="button" className="btn" disabled={!dirty || update.isPending} onClick={() => update.mutate(fields)}>
            {update.isPending ? 'Saving…' : 'Save issue settings'}
          </button>
          <button type="button" className="btn" disabled={!s.enabled || view.checking || checkNow.isPending} onClick={() => checkNow.mutate()}>
            <Icon name="refresh" size={13} />
            {view.checking || checkNow.isPending ? 'Checking…' : 'Check now'}
          </button>
        </div>
      </div>
      {update.isError ? <ErrorState error={update.error} /> : null}
      {checkNow.isError ? <ErrorState error={checkNow.error} /> : null}
    </div>
  );
}
