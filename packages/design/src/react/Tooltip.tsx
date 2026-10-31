import {
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
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
   * The trigger. Either one element, which the tooltip wires itself:
   *
   *   <Tooltip content="Copy the id"><Button>…</Button></Tooltip>
   *
   * or a render prop, to spread the wiring onto an element yourself:
   *
   *   <Tooltip content="Copy the id">{(t) => <button className="btn" {...t}>…</button>}</Tooltip>
   *
   * A trigger must be reachable by keyboard. An element child that is plain
   * text (a `span`, `div`, `p`, ...) with no `tabIndex` is given `tabIndex={0}`;
   * a disabled button cannot take focus at all, so say why it is disabled in
   * words beside it instead of in a tooltip.
   */
  children: ReactElement | ((trigger: TooltipTriggerProps) => ReactNode);
}

/** useLayoutEffect in a browser, useEffect when rendered on a server (where neither runs). */
const useBrowserLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/** The gap between a trigger and its tooltip, in px. */
const GAP = 6;
/** How long a tooltip waits after the pointer leaves, so it can be crossed to and read (WCAG 1.4.13, hoverable). */
const HIDE_GRACE_MS = 150;
/** The closest a tooltip comes to the window's edge, in px. */
const EDGE = 4;

/** Where the tooltip goes for a trigger's box: centred on it, 6px above or below. */
export function tooltipPosition(rect: { left: number; top: number; width: number; height: number }, placement: TooltipPlacement): { left: number; top: number; transform: string } {
  const left = rect.left + rect.width / 2;
  return placement === 'top'
    ? { left, top: rect.top - GAP, transform: 'translate(-50%, -100%)' }
    : { left, top: rect.top + rect.height + GAP, transform: 'translateX(-50%)' };
}

/**
 * Where a drawn tooltip must move to stay inside the window: how far to shift
 * it sideways, and whether it must flip to the other side of its trigger.
 * Pure, so it is tested without a DOM.
 */
export function tooltipFit(
  tip: { left: number; right: number; top: number; bottom: number },
  view: { width: number; height: number },
  placement: TooltipPlacement,
): { shift: number; flip: boolean } {
  const shift = tip.left < EDGE ? EDGE - tip.left : tip.right > view.width - EDGE ? view.width - EDGE - tip.right : 0;
  const flip = placement === 'top' ? tip.top < EDGE : tip.bottom > view.height - EDGE;
  return { shift, flip };
}

/** Elements that take focus without a `tabIndex`. */
const NATIVELY_FOCUSABLE = new Set(['a', 'button', 'input', 'select', 'textarea', 'summary', 'iframe']);

/** Whether an element's focus would show a focus ring (keyboard focus), where the browser can tell. */
function focusVisible(target: HTMLElement): boolean {
  try {
    return target.matches(':focus-visible');
  } catch {
    return true;
  }
}

/** The words a trigger is already called by: its `aria-label`, or else its text. */
function nameOf(target: HTMLElement): string {
  return (target.getAttribute('aria-label') ?? target.textContent ?? '').replace(/\s+/g, ' ').trim();
}

interface Shown {
  target: HTMLElement;
  placement: TooltipPlacement;
  /** False when the hint only repeats the trigger's own name, so it is not read twice. */
  describes: boolean;
}

export interface TooltipState {
  /** The id of the tooltip element. */
  id: string;
  shown: Shown | null;
  /** Show it for `target` after `wait` ms; `describes` decides whether it becomes the trigger's description. */
  show: (target: HTMLElement, wait: number, describes: boolean) => void;
  /** Hide it after the hover grace period, unless the pointer arrives on the tooltip first. */
  hideSoon: () => void;
  hide: () => void;
  /** Track whether the pointer and keyboard focus are on the trigger, so leaving one does not hide what the other still holds. */
  hold: (kind: 'hover' | 'focus', on: boolean) => void;
  /** The tooltip element, drawn while shown. */
  bubble: (content: ReactNode, className?: string) => ReactNode;
}

/**
 * The behaviour shared by `Tooltip` and `Truncate`: when to show, where to draw,
 * and the rules of WCAG 1.4.13 (content on hover or focus):
 *
 *   dismissable  Escape hides it without moving the pointer or focus, and
 *                does not also close the dialog around it;
 *   hoverable    the pointer can move onto the tooltip without it vanishing;
 *   persistent   it stays until the pointer and focus have both left, or
 *                Escape is pressed. No timeout hides it.
 */
export function useTooltip(placement: TooltipPlacement): TooltipState {
  const id = useId();
  const [shown, setShown] = useState<Shown | null>(null);
  const [style, setStyle] = useState<CSSProperties | null>(null);
  const showTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const holding = useRef({ hover: false, focus: false });
  const bubbleRef = useRef<HTMLSpanElement>(null);

  const clear = (): void => {
    clearTimeout(showTimer.current);
    clearTimeout(hideTimer.current);
  };
  const hide = useCallback((): void => {
    clear();
    holding.current = { hover: false, focus: false };
    setShown(null);
    setStyle(null);
  }, []);
  const show = useCallback(
    (target: HTMLElement, wait: number, describes: boolean): void => {
      clear();
      const place = (): void => {
        setShown({ target, placement, describes });
        setStyle({ ...tooltipPosition(target.getBoundingClientRect(), placement), visibility: 'hidden' });
      };
      if (wait > 0) showTimer.current = setTimeout(place, wait);
      else place();
    },
    [placement],
  );
  const hideSoon = useCallback((): void => {
    clearTimeout(showTimer.current);
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => {
      if (!holding.current.hover && !holding.current.focus) hide();
    }, HIDE_GRACE_MS);
  }, [hide]);
  const hold = useCallback((kind: 'hover' | 'focus', on: boolean): void => {
    holding.current[kind] = on;
    if (on) clearTimeout(hideTimer.current);
  }, []);

  // Measured once drawn: shifted inside the window, flipped if there is no room on its side.
  useBrowserLayoutEffect(() => {
    const tip = bubbleRef.current;
    if (!shown || !tip || style?.visibility !== 'hidden') return;
    const fit = tooltipFit(tip.getBoundingClientRect(), { width: window.innerWidth, height: window.innerHeight }, shown.placement);
    const side: TooltipPlacement = fit.flip ? (shown.placement === 'top' ? 'bottom' : 'top') : shown.placement;
    const at = tooltipPosition(shown.target.getBoundingClientRect(), side);
    setStyle({ ...at, left: at.left + fit.shift });
  }, [shown, style]);

  // Escape hides it. Listened for on window, in the capture phase, so it runs
  // before a dialog's own Escape handler (on document) and stops there: the
  // first Escape dismisses the hint, the next one closes the dialog.
  useEffect(() => {
    if (shown === null) return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      hide();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [shown, hide]);
  useEffect(() => clear, []);

  const bubble = (content: ReactNode, className?: string): ReactNode =>
    shown !== null && style !== null ? (
      <span
        ref={bubbleRef}
        role="tooltip"
        id={id}
        className={cx('tooltip', className)}
        data-placement={shown.placement}
        style={style}
        onMouseEnter={() => {
          clearTimeout(hideTimer.current);
          hold('hover', true);
        }}
        onMouseLeave={() => {
          hold('hover', false);
          hideSoon();
        }}
      >
        {content}
      </span>
    ) : null;

  return { id, shown, show, hideSoon, hide, hold, bubble };
}

/**
 * A hint shown on hover and on keyboard focus (`role="tooltip"`), tied to its
 * trigger with `aria-describedby` (unless it only repeats the trigger's name,
 * as an icon-only button's label does). It meets WCAG 1.4.13: Escape dismisses
 * it, the pointer can move onto it, and it stays until both pointer and focus
 * have left. It is drawn `position: fixed` beside the trigger, kept inside the
 * window, so a scrolling container does not clip it; it does not follow a
 * trigger that scrolls while open.
 */
export function Tooltip({ content, placement = 'top', delay = 400, className, children }: TooltipProps): ReactElement {
  const tip = useTooltip(placement);
  const describes = (target: HTMLElement): boolean => typeof content !== 'string' || content.trim() !== nameOf(target);

  const trigger: TooltipTriggerProps = {
    'aria-describedby': tip.shown?.describes ? tip.id : undefined,
    onMouseEnter: (event) => {
      tip.hold('hover', true);
      if (!tip.shown) tip.show(event.currentTarget, delay, describes(event.currentTarget));
    },
    onMouseLeave: () => {
      tip.hold('hover', false);
      tip.hideSoon();
    },
    onFocus: (event) => {
      // Keyboard focus only: focus a dialog hands back to its opener after a click is not a reason to pop a hint.
      if (!focusVisible(event.currentTarget)) return;
      tip.hold('focus', true);
      tip.show(event.currentTarget, 0, describes(event.currentTarget));
    },
    onBlur: () => {
      tip.hold('focus', false);
      tip.hideSoon();
    },
  };

  return (
    <>
      {typeof children === 'function' ? children(trigger) : wire(children, trigger)}
      {tip.bubble(content, className)}
    </>
  );
}

type Handler<E> = ((event: E) => void) | undefined;
const both =
  <E,>(own: Handler<E>, ours: (event: E) => void) =>
  (event: E): void => {
    own?.(event);
    ours(event);
  };

/** Puts the trigger wiring on an element child, keeping the child's own handlers and description. */
function wire(child: ReactElement, trigger: TooltipTriggerProps): ReactElement {
  if (!isValidElement(child)) return child;
  const props = child.props as Record<string, unknown>;
  const ownDescription = props['aria-describedby'] as string | undefined;
  const plainText = typeof child.type === 'string' && !NATIVELY_FOCUSABLE.has(child.type);
  return cloneElement(child as ReactElement<Record<string, unknown>>, {
    'aria-describedby': [ownDescription, trigger['aria-describedby']].filter(Boolean).join(' ') || undefined,
    onMouseEnter: both(props.onMouseEnter as Handler<MouseEvent<HTMLElement>>, trigger.onMouseEnter),
    onMouseLeave: both(props.onMouseLeave as Handler<MouseEvent<HTMLElement>>, trigger.onMouseLeave),
    onFocus: both(props.onFocus as Handler<FocusEvent<HTMLElement>>, trigger.onFocus),
    onBlur: both(props.onBlur as Handler<FocusEvent<HTMLElement>>, trigger.onBlur),
    ...(plainText && props.tabIndex === undefined ? { tabIndex: 0 } : {}),
  });
}
