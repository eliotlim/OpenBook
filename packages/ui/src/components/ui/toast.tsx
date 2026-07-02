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
 */

export interface ToastInput {
  message: string;
  /** Optional action rendered as a button (e.g. "Undo"). Dismisses the toast. */
  actionLabel?: string;
  onAction?: () => void;
  /** Auto-dismiss delay; defaults to 6s. */
  durationMs?: number;
}

interface ToastItem extends ToastInput {
  id: number;
}

let items: ToastItem[] = [];
let seq = 0;
let version = 0;
const listeners = new Set<() => void>();
const timers = new Map<number, ReturnType<typeof setTimeout>>();

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

/** Show a toast. Returns its id (usable with {@link dismissToast}). */
export function showToast(input: ToastInput): number {
  const id = ++seq;
  items = [...items, {...input, id}];
  timers.set(
    id,
    setTimeout(() => dismissToast(id), input.durationMs ?? 6000),
  );
  notify();
  return id;
}

const subscribe = (cb: () => void): (() => void) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};
const getVersion = (): number => version;

/** The toast stack — bottom-centred, above everything. Mount exactly once. */
export function ToastHost() {
  useSyncExternalStore(subscribe, getVersion, getVersion);
  if (items.length === 0) return null;
  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-6 z-[100] flex flex-col items-center gap-2 print:hidden"
      aria-live="polite"
    >
      {items.map((item) => (
        <div
          key={item.id}
          className="pointer-events-auto flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm shadow-lift"
          role="status"
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
            <X className="h-3.5 w-3.5" />
          </IconButton>
        </div>
      ))}
    </div>
  );
}
