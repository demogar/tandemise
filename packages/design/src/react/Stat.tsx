import type { HTMLAttributes, ReactElement, ReactNode } from 'react';
import { cx } from './cx.js';

export interface StatProps extends HTMLAttributes<HTMLDListElement> {
  /** What is measured ("Agents running"). */
  label: ReactNode;
  /** The measurement, already formatted ("4", "$12.40", "not reported"). */
  value: ReactNode;
  /** A line under the value: a comparison, a unit, where it comes from. */
  note?: ReactNode;
  /** Smaller and quieter: for a value that is not a number ("not reported"). */
  muted?: boolean;
}

/**
 * One measured value under its label. A description list (`<dl>` with a
 * `<dt>` label and `<dd>` value), so a screen reader reads the pair together
 * ("Agents running, 4") rather than two loose lines.
 */
export function Stat({ label, value, note, muted = false, className, ...rest }: StatProps): ReactElement {
  return (
    <dl className={cx('stat', className)} {...rest}>
      <dt className="stat__label">{label}</dt>
      <dd className={cx('stat__value', muted && 'stat__value--muted')}>{value}</dd>
      {note !== undefined && note !== null && note !== '' ? <dd className="stat__note">{note}</dd> : null}
    </dl>
  );
}
