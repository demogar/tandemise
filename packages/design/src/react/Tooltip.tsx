import { useEffect, useId, useRef, useState, type FocusEvent, type MouseEvent, type ReactElement, type ReactNode } from 'react';
import { cx } from './cx.js';

/** The props a tooltip's trigger spreads onto itself. */
export interface TooltipTriggerProps {
  'aria-describedby': string | undefined;
  onMouseEnter: (event: MouseEvent<HTMLElement>) => void;
  onMouseLeave: () => void;
  onFocus: (event: FocusEvent<HTMLElement>) => void;
  onBlur: () => void;
}

export type TooltipPlacement = 'top' | 'bottom';

export interface TooltipProps {
  /** The hint. Short, and never the only place something is said: touch has no hover. */
  content: ReactNode;
  placement?: TooltipPlacement;
  /** Hover delay, in ms. Keyboard focus shows it at once. */
  delay?: number;
  className?: string;
  /**
   * The trigger, as a render prop: spread the props onto a focusable element.
   *
   *   <Tooltip content="Copy the id">{(t) => <button className="btn" {...t}>…</button>}</Tooltip>
   */
  children: (trigger: TooltipTriggerProps) => ReactNode;
}

/** Where the tooltip goes for a trigger's box: centred on it, 6px above or below. */
export function tooltipPosition(rect: { left: number; top: number; width: number; height: number }, placement: TooltipPlacement): { left: number; top: number; transform: string } {
  const left = rect.left + rect.width / 2;
  return placement === 'top'
    ? { left, top: rect.top - 6, transform: 'translate(-50%, -100%)' }
    : { left, top: rect.top + rect.height + 6, transform: 'translateX(-50%)' };
}

/**
 * A hint shown on hover and on keyboard focus (`role="tooltip"`), tied to its
 * trigger with `aria-describedby`, hidden again by Escape, blur or leaving.
 * It is drawn `position: fixed` beside the trigger, so it is not clipped by a
 * scrolling container; it does not follow a trigger that scrolls while open.
 */
export function Tooltip({ content, placement = 'top', delay = 400, className, children }: TooltipProps): ReactElement {
  const id = useId();
  const [at, setAt] = useState<ReturnType<typeof tooltipPosition> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const show = (target: HTMLElement, wait: number): void => {
    clearTimeout(timer.current);
    const place = (): void => setAt(tooltipPosition(target.getBoundingClientRect(), placement));
    if (wait > 0) timer.current = setTimeout(place, wait);
    else place();
  };
  const hide = (): void => {
    clearTimeout(timer.current);
    setAt(null);
  };

  useEffect(() => {
    if (at === null) return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setAt(null);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [at]);
  useEffect(() => () => clearTimeout(timer.current), []);

  const trigger: TooltipTriggerProps = {
    'aria-describedby': at !== null ? id : undefined,
    onMouseEnter: (event) => show(event.currentTarget, delay),
    onMouseLeave: hide,
    onFocus: (event) => show(event.currentTarget, 0),
    onBlur: hide,
  };
  return (
    <>
      {children(trigger)}
      {at !== null ? (
        <span role="tooltip" id={id} className={cx('tooltip', className)} data-placement={placement} style={at}>
          {content}
        </span>
      ) : null}
    </>
  );
}
