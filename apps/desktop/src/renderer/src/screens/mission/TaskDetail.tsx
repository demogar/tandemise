import type { MissionDetail, TaskView } from '@tandemise/api-contract';
import { Icon } from '../../components/Icon.js';
import { Modal } from '../../components/Modal.js';
import { ErrorState, StatusBadge } from '../../components/primitives.js';
import { useDaemonMutation } from '../../lib/queries.js';
import { dateTime, duration, taskTone, titleCase } from '../../lib/format.js';

export function TaskDetail({ task, detail, onClose }: { task: TaskView; detail: MissionDetail; onClose: () => void }): JSX.Element {
  const retry = useDaemonMutation((daemon) => daemon.retryTask(task.id), ['tasks', 'missions'], detail.mission.id);
  const canRetry = task.status === 'FAILED' || task.status === 'BLOCKED';
  const evaluation = detail.evaluations.find((candidate) => candidate.taskId === task.id);

  return (
    <Modal
      title={task.title}
      wide
      onClose={onClose}
      footer={
        <>
          <span className="dim" style={{ marginRight: 'auto', fontSize: 'var(--fs-xs)' }}>
            {task.key}
          </span>
          {canRetry ? (
            <button type="button" className="btn" disabled={retry.isPending} onClick={() => retry.mutate(undefined)}>
              <Icon name="refresh" size={13} />
              {retry.isPending ? 'Retrying…' : 'Retry task'}
            </button>
          ) : null}
          <button type="button" className="btn btn--primary" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      <div className="stack" style={{ gap: 'var(--s4)', color: 'var(--text)' }}>
        <div className="row row--wrap">
          <StatusBadge status={task.status} tone={taskTone(task.status)} />
          <span className="chip">{task.roleName}</span>
          {task.runtimeName ? <span className="chip">{task.runtimeName}</span> : null}
          {task.targetName ? <span className="chip">{task.targetName}</span> : null}
          <span className="chip chip--muted">{task.executionPolicy.isolation} isolation</span>
        </div>

        {task.statusReason ? (
          <div className="banner banner--warn">
            <Icon name="alert" size={14} />
            <span>{task.statusReason}</span>
          </div>
        ) : null}

        <Block label="Objective">{task.objective}</Block>

        <div className="grid grid--2">
          <Block label="Started">{dateTime(task.startedAt)}</Block>
          <Block label="Finished">
            {task.finishedAt
              ? `${dateTime(task.finishedAt)} · ${duration(
                  task.startedAt ? Date.parse(task.finishedAt) - Date.parse(task.startedAt) : null,
                )}`
              : '—'}
          </Block>
        </div>

        {task.requiredCapabilities.length > 0 ? (
          <Block label="Capabilities requested">
            <div className="row row--wrap">
              {task.requiredCapabilities.map((capability) => (
                <span key={capability} className="chip">
                  {capability}
                </span>
              ))}
            </div>
          </Block>
        ) : null}

        {task.checks.length > 0 ? (
          <Block label="Checks">
            <div className="list">
              {task.checks.map((check) => (
                <div key={check.id} className="list__row">
                  <span className={`dot dot--${check.outcome === 'PASS' ? 'succeeded' : check.outcome === 'FAIL' ? 'failed' : 'pending'}`} />
                  <div className="list__main">
                    <div className="list__title mono">{check.name}</div>
                    <div className="list__subtitle">{check.detail}</div>
                  </div>
                  <div className="list__aside dim" style={{ fontSize: 'var(--fs-xs)' }}>
                    {duration(check.durationMs)}
                  </div>
                </div>
              ))}
            </div>
          </Block>
        ) : null}

        {task.gate ? (
          <Block label="Completion gate">
            <div className={`taskcard__gate${task.gate.passed ? '' : ' taskcard__gate--failed'}`} style={{ marginBottom: 'var(--s2)' }}>
              <Icon name={task.gate.passed ? 'shield' : 'alert'} size={12} />
              <span>{task.gate.detail}</span>
            </div>
            <code className="mono dim" style={{ display: 'block', fontSize: 'var(--fs-xs)' }}>
              {task.gate.expression}
            </code>
          </Block>
        ) : null}

        {evaluation ? (
          <Block label={`Evaluation — ${titleCase(evaluation.verdict)}`}>
            <p style={{ marginBottom: 'var(--s2)' }}>{evaluation.summary}</p>
            {evaluation.findings.map((finding, index) => (
              <div key={index} className="finding" style={{ padding: 'var(--s2) 0' }}>
                <span className={`finding__sev finding__sev--${finding.severity}`}>{finding.severity}</span>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 550 }}>{finding.title}</div>
                  <div className="muted" style={{ fontSize: 'var(--fs-sm)' }}>{finding.detail}</div>
                  {finding.location ? <div className="mono dim" style={{ fontSize: 'var(--fs-xs)' }}>{finding.location}</div> : null}
                </div>
              </div>
            ))}
          </Block>
        ) : null}

        {task.outputArtifacts.length > 0 ? (
          <Block label="Artifacts produced">
            <div className="row row--wrap">
              {task.outputArtifacts.map((artifact) => (
                <span key={artifact.id} className="chip">
                  <Icon name="file" size={11} />
                  {artifact.title}
                </span>
              ))}
            </div>
          </Block>
        ) : null}

        {retry.isError ? <ErrorState error={retry.error} /> : null}
      </div>
    </Modal>
  );
}

function Block({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div>
      <div className="qa__q" style={{ marginBottom: 4 }}>
        {label}
      </div>
      <div style={{ fontSize: 'var(--fs-base)', lineHeight: 1.6 }}>{children}</div>
    </div>
  );
}
