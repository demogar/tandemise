import { useEffect, useRef, useState, type HTMLAttributes, type MouseEvent, type ReactElement, type ReactNode } from 'react';
import { cx } from './cx.js';
import { Tooltip } from './Tooltip.js';

export interface ChipProps extends HTMLAttributes<HTMLSpanElement> {
  /** Quieter text, for a value that matters less than the ones beside it. */
  muted?: boolean;
  /** Drawn before the text, e.g. an `<Icon size={11} />`. Decorative. */
  icon?: ReactNode;
}

/** A short value in a box: a kind, a version, a branch, a count. Plain text, set in the mono face. */
export function Chip({ muted = false, icon, className, children, ...rest }: ChipProps): ReactElement {
  return (
    <span className={cx('chip', muted && 'chip--muted', className)} {...rest}>
      {icon}
      {children}
    </span>
  );
}

/** How long the chip says "copied", in ms. */
const COPIED_MS = 1200;

export interface IdChipProps extends Omit<HTMLAttributes<HTMLElement>, 'children' | 'onCopy'> {
  /** The identifier, shown and copied whole. */
  id: string;
  /** A word before it ("run", "task"), not copied. */
  prefix?: string;
  /**
   * Inside a link or a button, a second control is invalid markup and a trap
   * for keyboard users, so pass `false` there: the chip is then plain text
   * that still copies on click, and the id must be copyable by keyboard
   * somewhere else (its record's own page).
   */
  interactive?: boolean;
  /** Writes the text to the clipboard. `navigator.clipboard.writeText` by default. */
  copy?: (text: string) => Promise<void>;
  /** Called after a copy, with whether it worked. */
  onCopied?: (ok: boolean) => void;
}

const clipboardCopy = (text: string): Promise<void> =>
  typeof navigator !== 'undefined' && navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject(new Error('no clipboard'));

/**
 * A record's identifier, shown so a person can point at exactly this record
 * (in a bug report, in a message to an agent) and copied whole on click,
 * Enter or Space. The result is announced in a polite live region ("Copied
 * mis_42" or "Could not copy"), and the chip says "copied" for a moment.
 */
export function IdChip({ id, prefix, interactive = true, copy = clipboardCopy, onCopied, className, ...rest }: IdChipProps): ReactElement {
  const [result, setResult] = useState<'copied' | 'failed' | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const run = (event: MouseEvent<HTMLElement>): void => {
    // The chip often sits on a clickable row: copying must not also open it.
    event.stopPropagation();
    event.preventDefault();
    const settle = (ok: boolean): void => {
      setResult(ok ? 'copied' : 'failed');
      onCopied?.(ok);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setResult(null), COPIED_MS);
    };
    copy(id).then(
      () => settle(true),
      () => settle(false),
    );
  };

  const face = (
    <>
      {prefix ? <span className="idchip__prefix">{prefix}</span> : null}
      {result === 'copied' ? 'copied' : id}
    </>
  );
  const announcement = (
    <span className="visually-hidden" role="status">
      {result === 'copied' ? `Copied ${id}` : result === 'failed' ? `Could not copy ${id}` : ''}
    </span>
  );

  if (!interactive) {
    return (
      <>
        <span className={cx('idchip', className)} data-copied={result === 'copied' || undefined} onClick={run} {...rest}>
          {face}
        </span>
        {announcement}
      </>
    );
  }
  return (
    <>
      <Tooltip content="Copy to the clipboard">
        <button type="button" className={cx('idchip', className)} data-copied={result === 'copied' || undefined} onClick={run} {...rest}>
          {face}
        </button>
      </Tooltip>
      {announcement}
    </>
  );
}
