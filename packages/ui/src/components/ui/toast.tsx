import {useSyncExternalStore} from 'react';
import {X} from 'lucide-react';
import {IconButton} from '@/components/ui/icon-button';
import {t} from '@/i18n';

/**
 * A minimal toast layer: a module-singleton queue (the same bridge pattern as
 * `pageSaveStatus`) so any code — providers, menus, plain libs — can call
 * {@link showToast} without threading React context, and a single
 * {@link ToastHost} mounted in DefaultLayout renders the stack.
 *
 * First consumer: the "Moved to trash — Undo" affordance. Deliberately small —
 * no variants, no promise tracking — grow it only when a real need appears.
 *
 * A11y notes (adversarial review, 2026-07-03): the live region is mounted
 * permanently (content arriving *with* a fresh `aria-live` node is not
 * announced by most screen readers), items carry no extra `role` (the
 * container already announces), and hovering or focusing the stack pauses
 * auto-dismiss so an Undo is reachable at leisure (WCAG 2.2.1).
 */

export interface ToastInput {
  message: string;
  /** Optional action rendered as a button (e.g. "Undo"). Dismisses the toast. */
  actionLabel?: string;
  onAction?: () => void;
  /** Auto-dismiss delay; defaults to 7s (toasts with an action deserve slack).
   *  Pass `Infinity` for a persistent toast that only dismisses explicitly
   *  (close button / action) — e.g. "security update ready, restart". */
  durationMs?: number;
}

interface ToastItem extends ToastInput {
  id: number;
  durationMs: number;
}

let items: ToastItem[] = [];
let seq = 0;
let version = 0;
let paused = false;
const listeners = new Set<() => void>();
const timers = new Map<number, ReturnType<typeof setTimeout>>();
// Dialogs and their floating children use z-50; notifications must stay above
// them so feedback remains visible when an action leaves a dialog open.
const TOAST_LAYER_Z_INDEX = 100;

const notify = (): void => {
  version += 1;
  listeners.forEach((cb) => cb());
};

export function dismissToast(id: number): void {
  const timer = timers.get(id);
  if (timer) clearTimeout(timer);
  timers.delete(id);
  items = items.filter((item) => item.id !== id);
  notify();
}

const arm = (item: ToastItem): void => {
  // Persistent toast: no timer at all (setTimeout would coerce Infinity to 0
  // and dismiss immediately). Dismissal is the close button or the action.
  if (!Number.isFinite(item.durationMs)) return;
  timers.set(
    item.id,
    setTimeout(() => dismissToast(item.id), item.durationMs),
  );
};

/** Pause auto-dismiss while the pointer or focus is on the stack. */
const pauseAll = (): void => {
  if (paused) return;
  paused = true;
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
};

/** Resume auto-dismiss (each surviving toast gets its full duration again). */
const resumeAll = (): void => {
  if (!paused) return;
  paused = false;
  for (const item of items) arm(item);
};

/** Show a toast. Returns its id (usable with {@link dismissToast}). */
export function showToast(input: ToastInput): number {
  const id = ++seq;
  const item: ToastItem = {...input, id, durationMs: input.durationMs ?? 7000};
  items = [...items, item];
  if (!paused) arm(item);
  notify();
  return id;
}

const subscribe = (cb: () => void): (() => void) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};
const getVersion = (): number => version;

/** The toast stack — bottom-centred, above everything. Mount exactly once.
 *  The live region stays mounted even while empty (see the a11y note above). */
export function ToastHost() {
  useSyncExternalStore(subscribe, getVersion, getVersion);
  return (
    <div
      data-toast-host
      className="pointer-events-none fixed inset-x-0 bottom-6 flex flex-col items-center gap-2 print:hidden"
      style={{zIndex: TOAST_LAYER_Z_INDEX}}
      aria-live="polite"
      onMouseEnter={pauseAll}
      onMouseLeave={resumeAll}
      onFocus={pauseAll}
      onBlur={resumeAll}
    >
      {items.map((item) => (
        <div
          key={item.id}
          className="pointer-events-auto flex items-center gap-2 rounded-md border border-border bg-popover px-3 py-2 text-sm text-popover-foreground shadow-overlay"
        >
          <span className="min-w-0">{item.message}</span>
          {item.actionLabel && (
            <button
              type="button"
              className="shrink-0 cursor-pointer rounded px-1.5 py-0.5 font-medium text-primary transition-colors hover:bg-hover"
              onClick={() => {
                item.onAction?.();
                dismissToast(item.id);
              }}
            >
              {item.actionLabel}
            </button>
          )}
          <IconButton size="sm" aria-label={t('common.close')} onClick={() => dismissToast(item.id)}>
            <X className="h-4 w-4" />
          </IconButton>
        </div>
      ))}
    </div>
  );
}
