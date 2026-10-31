import { useEffect, useRef, useState, type ElementType, type HTMLAttributes, type ReactElement, type ReactNode } from 'react';
import { cx } from './cx.js';
import { useTooltip, type TooltipPlacement } from './Tooltip.js';

/** An element that is already a control: a `Truncate` inside one is reached through it. */
const INTERACTIVE = 'a[href], button, [role="button"], [role="link"], [role="tab"], [role="option"], [role="menuitem"], summary, label';

/** Whether an element's text is cut off: by an ellipsis (wider than its box) or a line clamp (taller). */
export function isClipped(box: { scrollWidth: number; clientWidth: number; scrollHeight: number; clientHeight: number }): boolean {
  return box.scrollWidth > box.clientWidth + 1 || box.scrollHeight > box.clientHeight + 1;
}

export interface TruncateProps extends HTMLAttributes<HTMLElement> {
  /** The element to render: `'span'` (the default), `'div'`, `'p'`, a heading. */
  as?: ElementType;
  placement?: TooltipPlacement;
  children: ReactNode;
}

/**
 * Text that ends in an ellipsis when it does not fit, and can still be read
 * whole. While it is cut off, its full text shows in a tooltip on hover and
 * on keyboard focus:
 *
 *   - on its own, it joins the tab order (only while cut off), so a keyboard
 *     user can reach the rest;
 *   - inside a link or a button, it does not (a control inside a control is
 *     invalid): the tooltip shows when that control is focused instead.
 *
 * The full text is the element's own content, so a screen reader already
 * reads all of it; the tooltip is not added as a description.
 */
export function Truncate({ as, placement = 'top', className, children, ...rest }: TruncateProps): ReactElement {
  const Component: ElementType = as ?? 'span';
  const ref = useRef<HTMLElement>(null);
  const [clipped, setClipped] = useState(false);
  const [nested, setNested] = useState(false);
  const tip = useTooltip(placement);
  const { show, hideSoon, hold } = tip;

  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    setNested(el.parentElement?.closest(INTERACTIVE) != null);
    const measure = (): void => setClipped(isClipped(el));
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [children]);

  // Inside a control: show the whole text while that control has keyboard focus.
  useEffect(() => {
    const el = ref.current;
    const host = nested ? el?.parentElement?.closest<HTMLElement>(INTERACTIVE) : null;
    if (!el || !host) return undefined;
    const onFocus = (): void => {
      if (!isClipped(el) || !host.matches(':focus-visible')) return;
      hold('focus', true);
      show(el, 0, false);
    };
    const onBlur = (): void => {
      hold('focus', false);
      hideSoon();
    };
    host.addEventListener('focus', onFocus);
    host.addEventListener('blur', onBlur);
    return () => {
      host.removeEventListener('focus', onFocus);
      host.removeEventListener('blur', onBlur);
    };
  }, [nested, show, hideSoon, hold]);

  const own = (): HTMLElement | null => ref.current;
  return (
    <>
      <Component
        ref={ref}
        className={cx('truncate', className)}
        data-clipped={clipped || undefined}
        {...(clipped && !nested ? { tabIndex: 0 } : {})}
        onMouseEnter={() => {
          const el = own();
          if (!el || !isClipped(el)) return;
          hold('hover', true);
          show(el, 400, false);
        }}
        onMouseLeave={() => {
          hold('hover', false);
          hideSoon();
        }}
        onFocus={() => {
          const el = own();
          if (!el || !isClipped(el)) return;
          hold('focus', true);
          show(el, 0, false);
        }}
        onBlur={() => {
          hold('focus', false);
          hideSoon();
        }}
        {...rest}
      >
        {children}
      </Component>
      {tip.bubble(children, 'tooltip--full')}
    </>
  );
}
