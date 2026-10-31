import { useId, type ReactElement, type ReactNode } from 'react';
import { cx } from './cx.js';

/** The wiring `Field` computes, named as the DOM attributes it becomes, ready to spread onto a control. */
export interface FieldControlProps {
  id: string;
  required: boolean | undefined;
  'aria-describedby': string | undefined;
  'aria-invalid': true | undefined;
}

export interface FieldProps {
  /** The visible label. Required: a placeholder is not a label. */
  label: ReactNode;
  /** Supporting copy under the control. Hidden while there is an error. */
  hint?: ReactNode;
  /** A validation message. Its presence marks the control invalid. */
  error?: ReactNode;
  /** Marks the label and, in the render-prop form, passes `required` to the control. */
  required?: boolean;
  className?: string;
  /**
   * The control. Two forms:
   *
   *   - a node: the field is a `<label>` wrapping it, so the label names the
   *     control with no ids at all. Good for a lone input, a select, a switch.
   *   - a function of the wiring: the field renders `<label for>` and hands
   *     the control its `id`, `aria-describedby` (the hint or the error) and
   *     `aria-invalid`, so a screen reader hears the error with the control:
   *
   *       <Field label="Name" error={errors.name}>
   *         {(control) => <input className="input" {...control} />}
   *       </Field>
   *
   *     A group of controls (a `Segmented`) is not labelable, so it takes the
   *     label's id from the second argument instead:
   *
   *       <Field label="Theme" hint="…">
   *         {(control, label) => <Segmented aria-labelledby={label.id} aria-describedby={control['aria-describedby']} … />}
   *       </Field>
   *
   * A render prop, not cloneElement: the wiring is visible at the call site
   * and type-checked, and a caller's own `id` is never silently replaced.
   */
  children: ReactNode | ((control: FieldControlProps, label: FieldLabel) => ReactNode);
}

/** The visible label's id, for a control a `<label for>` cannot name: a `Segmented` (a radio group) or a `Switch` takes it as `aria-labelledby`. */
export interface FieldLabel {
  id: string;
}

/** Label, control, and a hint or an error: the parts of one form question. */
export function Field({ label, hint, error, required, className, children }: FieldProps): ReactElement {
  const id = useId();
  const hasError = error !== undefined && error !== null && error !== false && error !== '';
  const hasHint = !hasError && hint !== undefined && hint !== null && hint !== '';
  const describedBy = hasError ? `${id}-error` : hasHint ? `${id}-hint` : undefined;
  const mark = required ? (
    <span className="field__required" aria-hidden="true">
      *
    </span>
  ) : null;
  const message = hasError ? (
    <span className="field__error" id={`${id}-error`}>
      {error}
    </span>
  ) : hasHint ? (
    <span className="field__hint" id={`${id}-hint`}>
      {hint}
    </span>
  ) : null;

  if (typeof children === 'function') {
    const control: FieldControlProps = {
      id: `${id}-control`,
      required: required || undefined,
      'aria-describedby': describedBy,
      'aria-invalid': hasError ? true : undefined,
    };
    return (
      <div className={cx('field', className)} data-invalid={hasError || undefined}>
        <label className="field__label" id={`${id}-label`} htmlFor={control.id}>
          {label}
          {mark}
        </label>
        {children(control, { id: `${id}-label` })}
        {message}
      </div>
    );
  }

  return (
    <label className={cx('field', className)} data-invalid={hasError || undefined}>
      <span className="field__label">
        {label}
        {mark}
      </span>
      {children}
      {message}
    </label>
  );
}
