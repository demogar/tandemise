import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cx } from './cx.js';

export interface SwitchProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onChange' | 'role' | 'aria-checked'> {
  /** On or off. */
  checked: boolean;
  onChange: (next: boolean) => void;
  /**
   * What the switch turns on ("Notify me"). A switch has no visible text of
   * its own, so it needs a name: this, `aria-labelledby` pointing at a visible
   * label, or a wrapping `<label>` (a `Field`).
   */
  label?: string;
}

/**
 * An on/off setting that takes effect at once: a `<button role="switch">` with
 * `aria-checked`. Space and Enter toggle it, as for any button. The track is
 * 34x20 but the hit area is at least 24px tall. Use a checkbox instead for a
 * choice that waits for a form's submit.
 */
export const Switch = forwardRef<HTMLButtonElement, SwitchProps>(function Switch(
  { checked, onChange, label, className, onClick, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={cx('switch', className)}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) onChange(!checked);
      }}
      {...rest}
    />
  );
});
