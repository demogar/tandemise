import type { ReactNode } from 'react';
import { Icon, type IconName } from './Icon.js';
import { describeError } from '../lib/daemon.js';
import { humanizeStatus, type Tone } from '../lib/format.js';

export function StatusBadge({ status, tone, icon }: { status: string; tone: Tone; icon?: IconName }): JSX.Element {
  return (
    <span className={`badge badge--${tone}`}>
      {icon ? <Icon name={icon} size={12} /> : <span className={`dot dot--${tone}`} />}
      {humanizeStatus(status)}
    </span>
  );
}

export function StatusDot({ tone, live = false }: { tone: Tone; live?: boolean }): JSX.Element {
  return <span className={`dot dot--${tone}${live ? ' dot--pulse' : ''}`} />;
}

export function Empty({
  icon = 'sparkle',
  title,
  body,
  action,
}: {
  icon?: IconName;
  title: string;
  body: string;
  action?: ReactNode;
}): JSX.Element {
  return (
    <div className="empty">
      <div className="empty__icon">
        <Icon name={icon} size={18} />
      </div>
      <div className="empty__title">{title}</div>
      <p className="empty__body">{body}</p>
      {action}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }): JSX.Element {
  const described = describeError(error);
  return (
    <div className="errorstate">
      <Icon name="alertCircle" size={18} className="errorstate__icon" />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="errorstate__title">{described.title}</div>
        <p className="errorstate__body">{described.detail}</p>
      </div>
      {onRetry ? (
        <button type="button" className="btn" onClick={onRetry}>
          <Icon name="refresh" size={13} />
          Retry
        </button>
      ) : null}
    </div>
  );
}

/**
 * Skeletons rather than spinners: the shape of the answer is known before the
 * data arrives, so showing it avoids a layout jump and reads as faster.
 */
export function Skeleton({ height = 16, width = '100%', radius }: { height?: number; width?: number | string; radius?: number }): JSX.Element {
  return <div className="skeleton" style={{ height, width, borderRadius: radius }} />;
}

export function SkeletonList({ rows = 4 }: { rows?: number }): JSX.Element {
  return (
    <div className="list">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="list__row">
          <div className="list__main" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <Skeleton height={13} width={`${40 + ((index * 17) % 35)}%`} />
            <Skeleton height={11} width={`${22 + ((index * 13) % 28)}%`} />
          </div>
          <Skeleton height={20} width={78} radius={4} />
        </div>
      ))}
    </div>
  );
}

export function SkeletonCards({ count = 3 }: { count?: number }): JSX.Element {
  return (
    <div className="grid grid--3">
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <Skeleton height={12} width="45%" />
          <Skeleton height={24} width="62%" />
          <Skeleton height={11} width="80%" />
        </div>
      ))}
    </div>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <label className="field">
      <span className="field__label">{label}</span>
      {children}
      {error ? <span className="field__error">{error}</span> : hint ? <span className="field__hint">{hint}</span> : null}
    </label>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  block = false,
}: {
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  block?: boolean;
}): JSX.Element {
  return (
    <div className={`segmented${block ? ' segmented--block' : ''}`} role="group">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className="segmented__option"
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (next: boolean) => void; label: string }): JSX.Element {
  return (
    <button type="button" className="switch" role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)} />
  );
}

export function Stat({ label, value, note, muted = false }: { label: string; value: string; note?: string; muted?: boolean }): JSX.Element {
  return (
    <div className="stat">
      <span className="stat__label">{label}</span>
      <span className={`stat__value${muted ? ' stat__value--muted' : ''}`}>{value}</span>
      {note ? <span className="stat__note">{note}</span> : null}
    </div>
  );
}

export function SectionHead({ title, meta, action }: { title: string; meta?: string; action?: ReactNode }): JSX.Element {
  return (
    <div className="section__head">
      <h2 className="section__title">{title}</h2>
      {meta ? <span className="section__meta">{meta}</span> : null}
      {action ? <div className="section__action">{action}</div> : null}
    </div>
  );
}
