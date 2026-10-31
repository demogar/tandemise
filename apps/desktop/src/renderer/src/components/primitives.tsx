import type { ReactNode } from 'react';
import { Icon, type IconName } from './Icon.js';
import { describeError } from '../lib/daemon.js';
import { humanizeStatus, type Tone } from '../lib/format.js';
import { Button, Card, EmptyState, Field as DesignField, StatusDot as DesignStatusDot, StatusPill, type FieldProps } from '@tandemise/design/react';

/**
 * The design package's accessible controls, re-exported so screens keep one
 * import path: `Segmented` is a named radio group (pass `label`, or
 * `aria-labelledby` from a `Field`'s render prop), `Switch` a named
 * `role="switch"`, `Stat` a description list, and `IdChip` a copy button
 * (`interactive={false}` inside a link or a button).
 */
export { IdChip, Segmented, Stat, Switch } from '@tandemise/design/react';

/** A record's status in words, as a pill in its tone (`StatusPill` from the design package). */
export function StatusBadge({ status, tone, icon }: { status: string; tone: Tone; icon?: IconName }): JSX.Element {
  return <StatusPill tone={tone} label={humanizeStatus(status)} icon={icon ? <Icon name={icon} size={12} /> : undefined} />;
}

export function StatusDot({ tone, live = false }: { tone: Tone; live?: boolean }): JSX.Element {
  return <DesignStatusDot tone={tone} live={live} />;
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
  return <EmptyState icon={<Icon name={icon} size={18} />} title={title} body={body} action={action} />;
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
        <Button onClick={onRetry}>
          <Icon name="refresh" size={13} />
          Retry
        </Button>
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
        <Card key={index} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <Skeleton height={12} width="45%" />
          <Skeleton height={24} width="62%" />
          <Skeleton height={11} width="80%" />
        </Card>
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
  children: FieldProps['children'];
}): JSX.Element {
  return (
    <DesignField label={label} hint={hint} error={error}>
      {children}
    </DesignField>
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
