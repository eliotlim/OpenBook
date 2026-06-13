import {useSyncExternalStore} from 'react';

/**
 * Tracks whether ⌘ (macOS) / Ctrl is currently held — so keyboard-shortcut
 * hints can stay hidden at rest and reveal themselves the moment the user
 * reaches for the modifier. One shared window listener for every subscriber
 * (and an SSR snapshot of `false`, so the first client render matches).
 */

let held = false;
const subscribers = new Set<() => void>();
let installed = false;

function set(value: boolean): void {
  if (value === held) return;
  held = value;
  subscribers.forEach((cb) => cb());
}

function ensureInstalled(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  const onDown = (e: KeyboardEvent): void => {
    if (e.key === 'Meta' || e.key === 'Control') set(true);
  };
  const onUp = (e: KeyboardEvent): void => {
    if (e.key === 'Meta' || e.key === 'Control') set(false);
  };
  const clear = (): void => set(false);
  window.addEventListener('keydown', onDown);
  window.addEventListener('keyup', onUp);
  window.addEventListener('blur', clear); // releasing focus drops the key state
  document.addEventListener('visibilitychange', clear);
}

export function useModifierHeld(): boolean {
  return useSyncExternalStore(
    (cb) => {
      ensureInstalled();
      subscribers.add(cb);
      return () => subscribers.delete(cb);
    },
    () => held,
    () => false,
  );
}
