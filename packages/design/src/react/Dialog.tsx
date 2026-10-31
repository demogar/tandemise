import { useId, useRef, type ReactElement, type ReactNode } from 'react';
import { cx } from './cx.js';
import { useDialogLayer } from './layer.js';

export interface DialogProps {
  /** The dialog's heading, and its accessible name. */
  title: ReactNode;
  /** A line under the title, announced as the dialog's description. */
  description?: ReactNode;
  children?: ReactNode;
  /** Actions, right-aligned under a border: Cancel, then the one that does it. */
  footer?: ReactNode;
  /** Escape, a press on the scrim, or a Cancel in the footer. */
  onClose: () => void;
  /** 760px instead of 520px, for a form or a document. */
  wide?: boolean;
  /**
   * What takes focus when the dialog opens: the first match inside it. The
   * default puts it on the element marked `data-autofocus`, else the first
   * button or field. Put `data-autofocus` on the safe choice, not the
   * destructive one, unless confirming is the point of the dialog.
   */
  initialFocus?: string;
  /** A press on the scrim closes it. Turn off for a dialog that holds unsaved input. */
  closeOnScrim?: boolean;
  className?: string;
}

/**
 * A modal dialog: `role="dialog"`, `aria-modal`, named by its title and
 * described by its description. Focus moves in when it opens, Tab stays
 * inside, Escape closes only the topmost dialog, and focus returns to what
 * opened it. Render it while it is open; unmount it to close.
 */
export function Dialog({
  title,
  description,
  children,
  footer,
  onClose,
  wide = false,
  initialFocus = '[data-autofocus], button, input, textarea',
  closeOnScrim = true,
  className,
}: DialogProps): ReactElement {
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();
  useDialogLayer(panel, onClose, { initialFocus });
  // A string title is also set as aria-label, so the dialog can be found by its name without reading its heading.
  const naming = typeof title === 'string' ? { 'aria-label': title } : { 'aria-labelledby': `${id}-title` };
  return (
    <div className="overlay overlay--center" onMouseDown={(event) => closeOnScrim && event.target === event.currentTarget && onClose()}>
      <div
        ref={panel}
        className={cx('modal', wide && 'modal--wide', className)}
        role="dialog"
        aria-modal="true"
        {...naming}
        aria-describedby={description !== undefined ? `${id}-description` : undefined}
      >
        <div className="modal__head">
          <h2 className="modal__title" id={`${id}-title`}>
            {title}
          </h2>
          {description !== undefined ? (
            <p className="modal__description" id={`${id}-description`}>
              {description}
            </p>
          ) : null}
        </div>
        <div className="modal__body">{children}</div>
        {footer ? <div className="modal__foot">{footer}</div> : null}
      </div>
    </div>
  );
}
