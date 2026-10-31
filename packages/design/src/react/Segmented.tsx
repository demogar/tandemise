import { useRef, type HTMLAttributes, type KeyboardEvent, type ReactElement, type ReactNode } from 'react';
import { cx } from './cx.js';

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  disabled?: boolean;
}

export interface SegmentedProps<T extends string> extends Omit<HTMLAttributes<HTMLDivElement>, 'onChange' | 'defaultValue'> {
  /** The chosen option. */
  value: T;
  options: readonly SegmentedOption<T>[];
  onChange: (value: T) => void;
  /**
   * What the choice is ("Theme"). A radio group must be named: pass this, or
   * `aria-labelledby` pointing at a visible label (a `Field`'s, say).
   */
  label?: string;
  /** Options share the full width of the container. */
  block?: boolean;
}

/**
 * The option a key moves to, or `null` for a key the group does not handle.
 * Arrow keys step to the next enabled option and wrap; Home and End go to the
 * first and last enabled one. Pure, so it is tested without a DOM.
 */
export function nextSegmentIndex(key: string, current: number, disabled: readonly boolean[]): number | null {
  const count = disabled.length;
  const enabled = disabled.map((off, index) => (off ? -1 : index)).filter((index) => index !== -1);
  if (enabled.length === 0) return null;
  const step = (from: number, by: 1 | -1): number => {
    for (let i = 1; i <= count; i++) {
      const index = (from + by * i + count * i) % count;
      if (!disabled[index]) return index;
    }
    return from;
  };
  switch (key) {
    case 'ArrowRight':
    case 'ArrowDown':
      return step(current, 1);
    case 'ArrowLeft':
    case 'ArrowUp':
      return step(current, -1);
    case 'Home':
      return enabled[0]!;
    case 'End':
      return enabled[enabled.length - 1]!;
    default:
      return null;
  }
}

/**
 * A small set of mutually exclusive choices drawn as one control (a theme, a
 * time window, a priority). Semantically a radio group: `role="radiogroup"`
 * with a `role="radio"` per option and `aria-checked` on the chosen one. Only
 * the chosen option is in the tab order; the arrow keys move the choice (and
 * focus) along the group, wrapping at the ends, as native radio buttons do.
 */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  block = false,
  className,
  onKeyDown,
  ...rest
}: SegmentedProps<T>): ReactElement {
  const group = useRef<HTMLDivElement>(null);
  const chosen = options.findIndex((option) => option.value === value);
  // Nothing chosen (or the chosen one disabled): the first enabled option takes the tab stop.
  const tabStop = chosen !== -1 && !options[chosen]!.disabled ? chosen : options.findIndex((option) => !option.disabled);

  const move = (event: KeyboardEvent<HTMLDivElement>): void => {
    onKeyDown?.(event);
    if (event.defaultPrevented) return;
    const radios = [...(group.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]') ?? [])];
    const current = radios.findIndex((radio) => radio === document.activeElement);
    if (current === -1) return;
    const next = nextSegmentIndex(event.key, current, options.map((option) => option.disabled === true));
    if (next === null) return;
    event.preventDefault();
    radios[next]?.focus();
    if (next !== chosen) onChange(options[next]!.value);
  };

  return (
    <div
      ref={group}
      role="radiogroup"
      aria-label={label}
      className={cx('segmented', block && 'segmented--block', className)}
      onKeyDown={move}
      {...rest}
    >
      {options.map((option, index) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          className="segmented__option"
          aria-checked={index === chosen}
          tabIndex={index === tabStop ? 0 : -1}
          disabled={option.disabled}
          onClick={() => {
            if (index !== chosen) onChange(option.value);
          }}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
