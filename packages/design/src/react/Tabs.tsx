import type { ComponentPropsWithoutRef, ElementType, HTMLAttributes, KeyboardEvent, ReactElement, ReactNode } from 'react';
import { cx } from './cx.js';

/**
 * The tab that a key moves focus to, or `null` for a key tabs do not handle.
 * Left/Right wrap around, Home/End go to the ends. Pure, so it is tested
 * without a DOM.
 */
export function nextTabIndex(key: string, current: number, count: number): number | null {
  if (count === 0) return null;
  switch (key) {
    case 'ArrowRight':
      return (current + 1) % count;
    case 'ArrowLeft':
      return (current - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}

export interface TabsProps extends HTMLAttributes<HTMLDivElement> {
  /** What the tabs switch between, for a screen reader ("Board sections"). Use `aria-labelledby` instead if a visible heading names them. */
  label?: string;
  children: ReactNode;
}

/**
 * A row of tabs (`role="tablist"`). Only the selected tab is in the page's
 * tab order; Left/Right, Home and End move between tabs, and Enter or a click
 * activates one, so a tab can be a router link as well as a button.
 */
export function Tabs({ label, className, children, onKeyDown, ...rest }: TabsProps): ReactElement {
  const move = (event: KeyboardEvent<HTMLDivElement>): void => {
    onKeyDown?.(event);
    if (event.defaultPrevented) return;
    const tabs = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]')];
    const current = tabs.findIndex((tab) => tab === document.activeElement);
    if (current === -1) return;
    const next = nextTabIndex(event.key, current, tabs.length);
    if (next === null) return;
    event.preventDefault();
    tabs[next]?.focus();
  };
  return (
    <div className={cx('tabs', className)} role="tablist" aria-label={label} onKeyDown={move} {...rest}>
      {children}
    </div>
  );
}

type TabOwnProps<C extends ElementType> = {
  /** The element to render: `'button'` (the default), `'a'`, or a router's link component. */
  as?: C;
  /** The tab that is showing. */
  selected: boolean;
  /** A count beside the label, in a pill. */
  count?: ReactNode;
  className?: string;
  children?: ReactNode;
};

export type TabProps<C extends ElementType = 'button'> = TabOwnProps<C> & Omit<ComponentPropsWithoutRef<C>, keyof TabOwnProps<C>>;

/** One tab (`role="tab"`, `aria-selected`). Render it inside `Tabs`. */
export function Tab<C extends ElementType = 'button'>({ as, selected, count, className, children, ...rest }: TabProps<C>): ReactElement {
  const Component: ElementType = as ?? 'button';
  const buttonProps = Component === 'button' ? { type: 'button' } : {};
  return (
    <Component
      {...buttonProps}
      className={cx('tab', className)}
      role="tab"
      aria-selected={selected}
      tabIndex={selected ? 0 : -1}
      {...rest}
    >
      {children}
      {count !== undefined && count !== null && count !== false ? <span className="tab__count">{count}</span> : null}
    </Component>
  );
}
