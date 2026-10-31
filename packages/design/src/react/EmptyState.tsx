import type { ReactElement, ReactNode } from 'react';
import { cx } from './cx.js';

export interface EmptyStateProps {
  /** A glyph in the tile above the title, e.g. `<Icon name="sparkle" size={18} />`. */
  icon?: ReactNode;
  title: ReactNode;
  /** What the view will hold, and how to get there. */
  body?: ReactNode;
  /** The one way forward: a button or a link. */
  action?: ReactNode;
  /** Less padding, for an empty state inside a card or a pane. */
  inline?: boolean;
  className?: string;
}

/** What a view says when there is nothing in it yet: what goes here and how to start. */
export function EmptyState({ icon, title, body, action, inline = false, className }: EmptyStateProps): ReactElement {
  return (
    <div className={cx('empty', inline && 'empty--inline', className)}>
      {icon !== undefined ? <div className="empty__icon">{icon}</div> : null}
      <div className="empty__title">{title}</div>
      {body !== undefined ? <p className="empty__body">{body}</p> : null}
      {action}
    </div>
  );
}
