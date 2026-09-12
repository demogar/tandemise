import { useState } from 'react';
import { Link } from 'wouter';
import type { ApprovalView } from '@tandemise/api-contract';
import type { ApprovalEvidence, ApprovalOption, RiskClass } from '@tandemise/domain';
import { Icon, type IconName } from '../../components/Icon.js';
import { ConfirmDialog } from '../../components/Modal.js';
import { ErrorState } from '../../components/primitives.js';
import { useDaemonMutation } from '../../lib/queries.js';
import { relativeTime, titleCase } from '../../lib/format.js';

/**
 * MVP.md §23.4 is a hard requirement, not a style note: every card must answer
 * *what*, *why*, *what evidence*, *what changes*, *what risk*, *what else could
 * I choose*. The six questions are literally the layout below, so an approval
 * that is missing one is visibly incomplete rather than quietly ambiguous.
 */
export function ApprovalCard({ view, compact = false }: { view: ApprovalView; compact?: boolean }): JSX.Element {
  const { approval } = view;
  const [selected, setSelected] = useState<string>(approval.recommendedOptionId ?? approval.options[0]?.id ?? 'approve');
  const [note, setNote] = useState('');
  const [confirming, setConfirming] = useState<ApprovalOption | null>(null);

  const decide = useDaemonMutation(
    (daemon, args: { optionId: string; note: string }) =>
      daemon.decideApproval(approval.id, { optionId: args.optionId, note: args.note || undefined }),
    ['approvals', 'missions', 'tasks'],
  );

  const chosen = approval.options.find((option) => option.id === selected) ?? approval.options[0];
  const needsConfirm = isConsequential(approval.risk) || chosen?.id === 'reject';

  const submit = (): void => {
    if (!chosen) return;
    decide.mutate({ optionId: chosen.id, note });
    setConfirming(null);
  };

  return (
    <article className="approval" data-risk={approval.risk}>
      <div className="approval__risk" />

      <header className="approval__head">
        <span className={`badge ${riskBadgeClass(approval.risk)}`} title={`Risk class: ${approval.risk}`}>
          <Icon name={riskIcon(approval.risk)} size={12} />
          {riskLabel(approval.risk)}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h3 className="approval__title">{approval.title}</h3>
          <div className="approval__context">
            <span className="chip chip--muted">{titleCase(approval.kind)}</span>
            {view.missionTitle ? (
              approval.missionId ? (
                <Link href={`/missions/${approval.missionId}`}>{view.missionTitle}</Link>
              ) : (
                <span>{view.missionTitle}</span>
              )
            ) : null}
            {view.taskTitle ? (
              <>
                <span className="sep">·</span>
                <span>{view.taskTitle}</span>
              </>
            ) : null}
            {view.roleName ? (
              <>
                <span className="sep">·</span>
                <span>requested by {view.roleName}</span>
              </>
            ) : null}
            <span className="sep">·</span>
            <span>{relativeTime(approval.createdAt)}</span>
          </div>
        </div>
      </header>

      <div className="approval__grid">
        <Question icon="info" question="Why is this being asked?" answer={approval.rationale} />
        <Question icon="zap" question="What changes if you approve?" answer={approval.effect} />
      </div>

      {approval.evidence.length > 0 && !compact ? (
        <div style={{ padding: '0 var(--s5) var(--s4)' }}>
          <div className="qa__q" style={{ marginBottom: 6 }}>
            <Icon name="eye" size={12} />
            Evidence
          </div>
          <div className="evidence">
            {approval.evidence.map((item, index) => (
              <EvidenceRow key={`${item.label}-${index}`} evidence={item} />
            ))}
          </div>
        </div>
      ) : null}

      {approval.expiresAt ? (
        <div style={{ padding: '0 var(--s5) var(--s4)' }}>
          <div className="banner banner--warn">
            <Icon name="clock" size={14} />
            This request expires {relativeTime(approval.expiresAt)}. If it lapses, the task stays blocked.
          </div>
        </div>
      ) : null}

      <div className="approval__options">
        <div className="qa__q">
          <Icon name="approvals" size={12} />
          Your options
        </div>
        {approval.options.map((option) => (
          <button
            key={option.id}
            type="button"
            className="option"
            data-selected={option.id === selected}
            data-recommended={option.id === approval.recommendedOptionId}
            onClick={() => setSelected(option.id)}
          >
            <span className="option__radio" />
            <span style={{ flex: 1, minWidth: 0 }}>
              <span className="option__label">
                {option.label}
                {option.id === approval.recommendedOptionId ? (
                  <span className="badge badge--accent" style={{ marginLeft: 8 }}>
                    Recommended
                  </span>
                ) : null}
              </span>
              {option.description ? <span className="option__desc">{option.description}</span> : null}
            </span>
          </button>
        ))}

        <textarea
          className="textarea"
          style={{ minHeight: 56, marginTop: 4 }}
          placeholder="Add a note for the record (optional) — downstream roles will read it."
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />

        {decide.isError ? <ErrorState error={decide.error} /> : null}

        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 4 }}>
          <span className="dim" style={{ fontSize: 'var(--fs-xs)', marginRight: 'auto' }}>
            {needsConfirm ? 'You will be asked to confirm.' : 'Applies immediately.'}
          </span>
          <button
            type="button"
            className={`btn ${chosen?.id === 'reject' ? 'btn--danger' : 'btn--primary'}`}
            disabled={decide.isPending || !chosen}
            onClick={() => (needsConfirm && chosen ? setConfirming(chosen) : submit())}
          >
            {decide.isPending ? 'Submitting…' : (chosen?.label ?? 'Decide')}
          </button>
        </div>
      </div>

      {confirming ? (
        <ConfirmDialog
          title={`${confirming.label}?`}
          destructive={confirming.id === 'reject' || isConsequential(approval.risk)}
          confirmLabel={confirming.label}
          busy={decide.isPending}
          onCancel={() => setConfirming(null)}
          onConfirm={submit}
          body={
            <>
              <p>{approval.effect}</p>
              <p style={{ marginTop: 'var(--s3)' }}>
                Risk class <strong>{riskLabel(approval.risk)}</strong>. This decision is recorded and shown to every downstream role.
              </p>
            </>
          }
        />
      ) : null}
    </article>
  );
}

/** The Home-screen form: same questions, fewer of them, and it links onward. */
export function ApprovalPreviewCard({ view }: { view: ApprovalView }): JSX.Element {
  const { approval } = view;
  return (
    <Link href="/approvals" className="approval" style={{ display: 'block', textDecoration: 'none', color: 'inherit' }} data-risk={approval.risk}>
      <div className="approval__risk" />
      <header className="approval__head" style={{ paddingBottom: 'var(--s2)' }}>
        <span className={`badge ${riskBadgeClass(approval.risk)}`}>
          <Icon name={riskIcon(approval.risk)} size={12} />
          {riskLabel(approval.risk)}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h3 className="approval__title">{approval.title}</h3>
          <div className="approval__context">
            <span className="chip chip--muted">{titleCase(approval.kind)}</span>
            {view.missionTitle ? <span>{view.missionTitle}</span> : null}
            <span className="sep">·</span>
            <span>{relativeTime(approval.createdAt)}</span>
          </div>
        </div>
        <span className="btn btn--primary" style={{ flex: 'none' }}>
          Review
          <Icon name="chevronRight" size={13} />
        </span>
      </header>
      <div className="approval__grid" style={{ paddingBottom: 'var(--s4)' }}>
        <Question icon="info" question="Why" answer={approval.rationale} />
        <Question icon="zap" question="What changes" answer={approval.effect} />
      </div>
    </Link>
  );
}

function Question({ icon, question, answer }: { icon: IconName; question: string; answer: string }): JSX.Element {
  return (
    <div className="qa">
      <span className="qa__q">
        <Icon name={icon} size={12} />
        {question}
      </span>
      <p className="qa__a">{answer}</p>
    </div>
  );
}

function EvidenceRow({ evidence }: { evidence: ApprovalEvidence }): JSX.Element {
  const isLink = evidence.kind === 'link' && /^https?:\/\//.test(evidence.value);
  return (
    <div className="evidence__row">
      <span className="evidence__kind">
        <Icon name={evidenceIcon(evidence.kind)} size={13} />
      </span>
      <span className="evidence__label">{evidence.label}</span>
      <span className="evidence__value">
        {isLink ? (
          <a
            href={evidence.value}
            onClick={(event) => {
              event.preventDefault();
              void window.tandemise.openExternal(evidence.value);
            }}
          >
            {evidence.value}
            <Icon name="externalLink" size={11} />
          </a>
        ) : (
          evidence.value
        )}
      </span>
    </div>
  );
}

function evidenceIcon(kind: ApprovalEvidence['kind']): IconName {
  switch (kind) {
    case 'artifact':
      return 'file';
    case 'check':
      return 'check';
    case 'diff':
      return 'branch';
    case 'link':
      return 'link';
    default:
      return 'message';
  }
}

const RISK_LABELS: Readonly<Record<RiskClass, string>> = {
  read: 'Read only',
  write_reversible: 'Reversible',
  external_side_effect: 'Leaves this machine',
  destructive: 'Destructive',
  financial: 'Financial',
  release: 'Release',
};

function riskLabel(risk: RiskClass): string {
  return RISK_LABELS[risk] ?? titleCase(risk);
}

function riskIcon(risk: RiskClass): IconName {
  switch (risk) {
    case 'read':
      return 'eye';
    case 'write_reversible':
      return 'refresh';
    case 'external_side_effect':
      return 'externalLink';
    case 'destructive':
      return 'alert';
    case 'financial':
      return 'alert';
    default:
      return 'zap';
  }
}

function riskBadgeClass(risk: RiskClass): string {
  switch (risk) {
    case 'read':
      return 'badge';
    case 'write_reversible':
      return 'badge badge--running';
    case 'external_side_effect':
      return 'badge badge--blocked';
    case 'destructive':
    case 'financial':
      return 'badge badge--failed';
    default:
      return 'badge badge--release';
  }
}

function isConsequential(risk: RiskClass): boolean {
  return risk === 'destructive' || risk === 'financial' || risk === 'release' || risk === 'external_side_effect';
}
