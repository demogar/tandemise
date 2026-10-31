import { useRef, type ReactNode } from 'react';
import { Button, Dialog, useDialogLayer } from '@tandemise/design/react';
import { Icon } from './Icon.js';

/**
 * Every destructive action in the app routes through this, so the confirm copy
 * lives with the caller and the escape/focus behaviour lives in the design
 * package's `Dialog` once: focus moves in, Tab stays inside, Escape closes only
 * the topmost layer (a composer opened from a drawer closes on its own), and
 * focus returns to what opened it.
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
  return (
    <Dialog title={title} onClose={onClose} footer={footer} wide={wide}>
      {children}
    </Dialog>
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
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button data-autofocus variant={destructive ? 'danger' : 'primary'} onClick={onConfirm} loading={busy} loadingLabel="Working…">
            {confirmLabel}
          </Button>
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

  // The same layer stack as every Dialog, so Escape still closes only the topmost.
  useDialogLayer(panel, onClose, { initialFocus: '[data-autofocus]' });

  return (
    <div className="overlay overlay--side" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div ref={panel} className={`drawer${wide ? ' drawer--wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="drawer__head">
          <div style={{ minWidth: 0, flex: 1 }}>
            <h2 className="modal__title truncate">{title}</h2>
            {subtitle ? <div className="drawer__subtitle">{subtitle}</div> : null}
          </div>
          <Button iconOnly variant="ghost" aria-label="Close" onClick={onClose}>
            <Icon name="x" size={14} />
          </Button>
        </div>
        <div className="drawer__body">{children}</div>
        {footer ? <div className="modal__foot">{footer}</div> : null}
      </div>
    </div>
  );
}
