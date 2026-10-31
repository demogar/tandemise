import { useId, type HTMLAttributes, type ReactElement, type ReactNode } from 'react';
import { cx } from './cx.js';

export interface CardProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  /**
   * A heading row with a bottom border. Given a title, the card is a
   * `<section>` labelled by it; without one it is a plain `<div>`.
   */
  title?: ReactNode;
  /** Controls at the right of the heading row. */
  actions?: ReactNode;
  /**
   * No padding: the content (a list, a table) runs to the edges. With a
   * title, the body gets the card's padding back.
   */
  flush?: boolean;
}

/** A bordered surface that groups one thing. */
export function Card({ title, actions, flush = false, className, children, id, ...rest }: CardProps): ReactElement {
  const generated = useId();
  if (title === undefined && actions === undefined) {
    return (
      <div className={cx('card', flush && 'card--flush', className)} id={id} {...rest}>
        {children}
      </div>
    );
  }
  const headingId = title !== undefined ? `${id ?? generated}-title` : undefined;
  return (
    <section className={cx('card', 'card--flush', className)} id={id} aria-labelledby={headingId} {...rest}>
      <div className="card__head">
        {title !== undefined ? (
          <h3 className="card__title" id={headingId}>
            {title}
          </h3>
        ) : null}
        {actions !== undefined ? <div className="card__actions">{actions}</div> : null}
      </div>
      {flush ? children : <div className="card__body">{children}</div>}
    </section>
  );
}
