import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cx } from './cx.js';

/**
 * The weight of an action:
 *
 *   secondary  the default, for most actions
 *   primary    the one main action of a view (at most one per view)
 *   ghost      low-stakes actions in dense rows and toolbars
 *   danger     only for what destroys or cannot be undone
 */
export type ButtonVariant = 'secondary' | 'primary' | 'ghost' | 'danger';

/**
 * The height of the button:
 *
 *   sm  `--control-h-sm` (28px; 24px when compact), for a dense row of
 *       actions on a list item or a card. Never smaller than 24x24, so it
 *       stays an easy target (WCAG 2.5.8).
 *   md  `--control-h` (30px), the default.
 *   lg  `--control-h-lg` (36px), for an onboarding or empty-state call to action.
 */
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonClassOptions {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Square, for a button whose only content is an icon. */
  iconOnly?: boolean;
  /** Full width of its container. */
  block?: boolean;
  className?: string;
}

/**
 * The class list of a button, for an element that must look like one but is
 * not a `<button>`: a router link, an `<a>` to a file.
 */
export function buttonClass({ variant = 'secondary', size = 'md', iconOnly = false, block = false, className }: ButtonClassOptions = {}): string {
  return cx(
    'btn',
    variant !== 'secondary' && `btn--${variant}`,
    size !== 'md' && `btn--${size}`,
    iconOnly && 'btn--icon',
    block && 'btn--block',
    className,
  );
}

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'>, ButtonClassOptions {
  /**
   * Work is in flight. The button stops taking presses, is announced as busy
   * (`aria-busy`) and carries `data-loading`. The label stays (so the button
   * keeps its width) with a spinner beside it, unless `loadingLabel` is given.
   */
  loading?: boolean;
  /** Replaces the label while loading, for a verb in progress: "Saving…". No spinner is drawn then. */
  loadingLabel?: ReactNode;
}

/**
 * A `<button type="button">` drawing the `.btn` classes. An icon-only button
 * (`iconOnly`) must have an `aria-label`; it is the button's whole name. Wrap
 * it in a `Tooltip` with the same words so a sighted user sees the name too.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant, size, iconOnly, block, className, loading = false, loadingLabel, disabled, type = 'button', children, ...rest },
  ref,
) {
  if (iconOnly && !rest['aria-label'] && !rest['aria-labelledby'] && isDev()) {
    // A `title` is not a name: it is not reliably announced and never shown to a keyboard user.
    console.warn('@tandemise/design: an iconOnly Button needs an aria-label (a title is not enough; add a Tooltip for sighted users)');
  }
  const showLabel = loading && loadingLabel !== undefined;
  return (
    <button
      ref={ref}
      type={type}
      className={buttonClass({ variant, size, iconOnly, block, className })}
      disabled={disabled || loading}
      {...(loading ? { 'aria-busy': true, 'data-loading': 'true' } : {})}
      {...rest}
    >
      {loading && !showLabel ? <span className="btn__spinner" aria-hidden="true" /> : null}
      {showLabel ? loadingLabel : children}
    </button>
  );
});

function isDev(): boolean {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  return env?.NODE_ENV !== 'production';
}
