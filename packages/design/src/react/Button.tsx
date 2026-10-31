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

/** `md` is a control's height (`--control-h`); `lg` is `--control-h-lg`, for an onboarding or empty-state call to action. */
export type ButtonSize = 'md' | 'lg';

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
    size === 'lg' && 'btn--lg',
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
 * (`iconOnly`) must have an `aria-label`; it is the button's whole name.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant, size, iconOnly, block, className, loading = false, loadingLabel, disabled, type = 'button', children, ...rest },
  ref,
) {
  if (iconOnly && !rest['aria-label'] && !rest['aria-labelledby'] && isDev()) {
    console.warn('@tandemise/design: an iconOnly Button needs an aria-label');
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
