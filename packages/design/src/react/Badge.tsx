import type { HTMLAttributes, ReactElement, ReactNode } from 'react';
import { cx, type BadgeTone, type Tone } from './cx.js';

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  /** The colour: a status tone, `accent`, or `release` (the release risk). `pending` is the quiet default. */
  tone?: BadgeTone;
}

/** A small label in a status colour: a count, a kind, a state. */
export function Badge({ tone = 'pending', className, children, ...rest }: BadgeProps): ReactElement {
  return (
    <span className={cx('badge', tone !== 'pending' && `badge--${tone}`, className)} {...rest}>
      {children}
    </span>
  );
}

export interface StatusDotProps extends HTMLAttributes<HTMLSpanElement> {
  tone: Tone;
  /** Pulses, for work happening now. Never the only signal: pair it with words. */
  live?: boolean;
}

/** A status as a 7px dot. Decorative unless given an `aria-label`. */
export function StatusDot({ tone, live = false, className, ...rest }: StatusDotProps): ReactElement {
  const labelled = rest['aria-label'] !== undefined;
  return (
    <span
      className={cx('dot', `dot--${tone}`, live && 'dot--pulse', className)}
      {...(labelled ? { role: 'img' } : { 'aria-hidden': true })}
      {...rest}
    />
  );
}

export interface StatusPillProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'children'> {
  tone: Tone;
  /** The status in words. Colour is never the only signal. */
  label: ReactNode;
  /** Drawn in place of the dot, e.g. an `<Icon size={12} />`. */
  icon?: ReactNode;
  /** The dot pulses: work happening now. Ignored when an icon is given. */
  live?: boolean;
}

/** A status: dot (or icon) and words, in the tone's colour. */
export function StatusPill({ tone, label, icon, live = false, className, ...rest }: StatusPillProps): ReactElement {
  return (
    <span className={cx('badge', `badge--${tone}`, className)} data-tone={tone} {...rest}>
      {icon ?? <span className={cx('dot', `dot--${tone}`, live && 'dot--pulse')} aria-hidden="true" />}
      {label}
    </span>
  );
}
