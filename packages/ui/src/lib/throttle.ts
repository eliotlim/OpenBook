/**
 * A leading+trailing throttle: the first call fires immediately, then at most one
 * call per `ms` window, and a final trailing call carries the last arguments seen
 * during the window so the end state is never dropped. Used to rate-limit the
 * local caret broadcast into awareness (~10Hz) so a fast-moving selection doesn't
 * flood the relay, while the resting position still lands.
 */
export interface Throttled<A extends unknown[]> {
  (...args: A): void;
  /** Drop any pending trailing call (e.g. on blur, when clearing immediately). */
  cancel(): void;
}

export function throttle<A extends unknown[]>(fn: (...args: A) => void, ms: number): Throttled<A> {
  // -Infinity so the very first call always fires on the leading edge, regardless
  // of the absolute clock value (keeps it deterministic under fake timers too).
  let last = Number.NEGATIVE_INFINITY;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: A | null = null;

  const invoke = (args: A): void => {
    last = Date.now();
    fn(...args);
  };

  const throttled = ((...args: A): void => {
    const now = Date.now();
    const remaining = ms - (now - last);
    pending = args;
    if (remaining <= 0) {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      invoke(args);
      pending = null;
      return;
    }
    if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        if (pending) {
          invoke(pending);
          pending = null;
        }
      }, remaining);
    }
  }) as Throttled<A>;

  throttled.cancel = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    pending = null;
  };

  return throttled;
}
