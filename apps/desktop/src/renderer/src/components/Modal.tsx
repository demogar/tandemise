import { useEffect, useRef, type ReactNode, type RefObject } from 'react';
import { Icon } from './Icon.js';

/**
 * The open overlays, oldest first. Escape closes only the topmost: the
 * composer opened from a reader drawer closes on its own, and the drawer the
 * person was reading stays where it was.
 */
const stack: object[] = [];

/**
 * Registers an overlay for its lifetime and routes Escape to it while it is on
 * top. `onClose` is read through a ref, so a parent re-rendering with a new
 * callback neither reorders the stack nor steals focus again.
 */
function useOverlay(panel: RefObject<HTMLDivElement>, onClose: () => void, focusSelector: string): void {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const token = {};
    stack.push(token);
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || stack[stack.length - 1] !== token) return;
      event.stopPropagation();
      close.current();
    };
    document.addEventListener('keydown', onKeyDown, true);
    panel.current?.querySelector<HTMLElement>(focusSelector)?.focus();
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      stack.splice(stack.indexOf(token), 1);
    };
  }, [panel, focusSelector]);
}

/**
 * Every destructive action in the app routes through this, so the confirm copy
 * lives with the caller and the escape/focus behaviour lives here once.
 */
export function Modal({
  title,
  children,
  onClose,
  footer,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  footer?: ReactNode;
  wide?: boolean;
}): JSX.Element {
  const panel = useRef<HTMLDivElement>(null);

  useOverlay(panel, onClose, '[data-autofocus], button, input, textarea');

  return (
    <div className="overlay overlay--center" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div ref={panel} className={`modal${wide ? ' modal--wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal__head">
          <h2 className="modal__title">{title}</h2>
        </div>
        <div className="modal__body">{children}</div>
        {footer ? <div className="modal__foot">{footer}</div> : null}
      </div>
    </div>
  );
}

export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  destructive = false,
  busy = false,
  onConfirm,
  onCancel,
}: {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  destructive?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}): JSX.Element {
  return (
    <Modal
      title={title}
      onClose={onCancel}
      footer={
        <>
          <button type="button" className="btn btn--ghost" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            data-autofocus
            className={`btn ${destructive ? 'btn--danger' : 'btn--primary'}`}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? 'Working…' : confirmLabel}
          </button>
        </>
      }
    >
      {body}
    </Modal>
  );
}

/**
 * A side panel for the details behind a scannable row: the list stays visible
 * on the left, so closing the drawer returns you exactly where you were.
 */
export function Drawer({
  title,
  subtitle,
  children,
  onClose,
  footer,
  wide = false,
}: {
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
  onClose: () => void;
  footer?: ReactNode;
  /** For a document rather than a record: prose needs a reading measure, not a sidebar's width. */
  wide?: boolean;
}): JSX.Element {
  const panel = useRef<HTMLDivElement>(null);

  useOverlay(panel, onClose, '[data-autofocus]');

  return (
    <div className="overlay overlay--side" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div ref={panel} className={`drawer${wide ? ' drawer--wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="drawer__head">
          <div style={{ minWidth: 0, flex: 1 }}>
            <h2 className="modal__title truncate">{title}</h2>
            {subtitle ? <div className="drawer__subtitle">{subtitle}</div> : null}
          </div>
          <button type="button" className="btn btn--icon btn--ghost" aria-label="Close" onClick={onClose}>
            <Icon name="x" size={14} />
          </button>
        </div>
        <div className="drawer__body">{children}</div>
        {footer ? <div className="modal__foot">{footer}</div> : null}
      </div>
    </div>
  );
}
