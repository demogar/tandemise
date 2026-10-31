import type { ComponentPropsWithoutRef, ElementType, ReactElement, ReactNode } from 'react';
import { cx } from './cx.js';
import { Icon } from './Icon.js';

/** `neutral` informs; `accent` offers something; `warn` needs attention; `danger` reports something that failed. */
export type BannerTone = 'neutral' | 'accent' | 'warn' | 'danger';

type BannerOwnProps<C extends ElementType> = {
  /** The element to render: `'div'` (the default), or a link (`'a'`, a router's link) for a banner that goes somewhere. */
  as?: C;
  tone?: BannerTone;
  /**
   * How a banner that appears while the person is on the page is announced:
   *
   *   polite     `role="status"`: read when the reader is idle (most news)
   *   assertive  `role="alert"`: read at once (a failure that blocks them)
   *
   * Leave it out for a banner that is there when the page loads: it is read
   * with the page, and a live region would only repeat it.
   */
  live?: 'polite' | 'assertive';
  /** Drawn first, e.g. an `<Icon size={15} />`. Decorative. */
  icon?: ReactNode;
  /** A control at the end: a button or a link that resolves it. */
  action?: ReactNode;
  /** Shows a close button that calls this. The banner's owner removes it. */
  onDismiss?: () => void;
  /** The close button's name. "Dismiss" by default; say what it dismisses when there are several. */
  dismissLabel?: string;
  className?: string;
  children?: ReactNode;
};

export type BannerProps<C extends ElementType = 'div'> = BannerOwnProps<C> & Omit<ComponentPropsWithoutRef<C>, keyof BannerOwnProps<C>>;

/** A message across the top of a section: a warning, an offer, a state worth knowing. Words first; colour is never the only signal. */
export function Banner<C extends ElementType = 'div'>({
  as,
  tone = 'neutral',
  live,
  icon,
  action,
  onDismiss,
  dismissLabel = 'Dismiss',
  className,
  children,
  ...rest
}: BannerProps<C>): ReactElement {
  const Component: ElementType = as ?? 'div';
  const role = live === 'assertive' ? 'alert' : live === 'polite' ? 'status' : undefined;
  return (
    <Component className={cx('banner', tone !== 'neutral' && `banner--${tone}`, className)} role={role} {...rest}>
      {icon}
      <div className="banner__body">{children}</div>
      {action}
      {onDismiss ? (
        <button type="button" className="btn btn--ghost btn--sm btn--icon banner__dismiss" aria-label={dismissLabel} onClick={onDismiss}>
          <Icon name="x" size={14} />
        </button>
      ) : null}
    </Component>
  );
}
