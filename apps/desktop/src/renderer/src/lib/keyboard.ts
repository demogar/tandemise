import { useEffect, useRef, useState } from 'react';

/** True when the event target is a place the user is typing. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

interface HotkeyOptions {
  /** Fire even when focus is inside a text field. Used for ⌘↵ and Escape. */
  readonly whileTyping?: boolean;
}

/**
 * `combo` is written as `mod+k`, `shift+/`, `j`. `mod` is ⌘ on macOS and Ctrl
 * elsewhere, which is the only platform difference worth encoding here.
 */
export function useHotkey(combo: string, handler: () => void, options: HotkeyOptions = {}): void {
  const latest = useRef(handler);
  latest.current = handler;

  useEffect(() => {
    const parts = combo.toLowerCase().split('+');
    const key = parts[parts.length - 1] ?? '';
    const wantsMod = parts.includes('mod');
    const wantsShift = parts.includes('shift');

    const onKeyDown = (event: KeyboardEvent): void => {
      const mod = event.metaKey || event.ctrlKey;
      if (wantsMod !== mod) return;
      if (wantsShift !== event.shiftKey) return;
      if (event.key.toLowerCase() !== key && !(key === 'enter' && event.key === 'Enter')) return;
      if (!options.whileTyping && isTypingTarget(event.target)) return;
      event.preventDefault();
      latest.current();
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [combo, options.whileTyping]);
}

/**
 * `j`/`k` list navigation. Returns the focused index and keeps it in range as
 * the list changes underneath it.
 */
export function useListNavigation(length: number, onActivate: (index: number) => void): number {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (index >= length) setIndex(Math.max(0, length - 1));
  }, [length, index]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (isTypingTarget(event.target) || event.metaKey || event.ctrlKey || length === 0) return;
      if (event.key === 'j' || event.key === 'ArrowDown') {
        event.preventDefault();
        setIndex((current) => Math.min(current + 1, length - 1));
      } else if (event.key === 'k' || event.key === 'ArrowUp') {
        event.preventDefault();
        setIndex((current) => Math.max(current - 1, 0));
      } else if (event.key === 'Enter') {
        event.preventDefault();
        onActivate(index);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [length, index, onActivate]);

  return index;
}
