/**
 * Cross-page group sync. Groups that share a `sync` key mirror their input
 * values, so the same "settings" group placed on two pages stays in lockstep.
 *
 * v1 is a localStorage-backed value mirror with cross-tab `storage` events and
 * in-tab subscribers (so the primary pane and the split pane sync too). It's
 * same-browser; a server-backed sync that spans devices is the next step. The
 * shape is deliberately small — `{field: value}` — and callers guard writes
 * against no-ops, so a value adopted from the store never echoes back.
 */

type Values = Record<string, unknown>;

const PREFIX = 'openbook.groupsync.';
const cache = new Map<string, Values>();
const subs = new Map<string, Set<() => void>>();

function load(key: string): Values {
  const hit = cache.get(key);
  if (hit) return hit;
  let val: Values = {};
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(PREFIX + key) : null;
    if (raw) val = JSON.parse(raw) as Values;
  } catch {
    // private mode / malformed — treat as empty
  }
  cache.set(key, val);
  return val;
}

/** The values currently shared under a key (a copy). */
export const readGroupSync = (key: string): Values => ({...load(key)});

/**
 * Merge `values` into a sync key. Returns whether anything actually changed,
 * so a caller adopting shared state doesn't echo it straight back. Notifies
 * in-tab subscribers and (via localStorage) other tabs.
 */
export function writeGroupSync(key: string, values: Values): boolean {
  const current = load(key);
  const next = {...current};
  let changed = false;
  for (const [k, v] of Object.entries(values)) {
    if (!valueEqual(current[k], v)) {
      next[k] = v;
      changed = true;
    }
  }
  if (!changed) return false;
  cache.set(key, next);
  try {
    localStorage?.setItem(PREFIX + key, JSON.stringify(next));
  } catch {
    // quota / private mode — in-tab sync still works via the cache
  }
  notify(key);
  return true;
}

export function subscribeGroupSync(key: string, cb: () => void): () => void {
  let set = subs.get(key);
  if (!set) {
    set = new Set();
    subs.set(key, set);
  }
  set.add(cb);
  return () => {
    set!.delete(cb);
  };
}

function notify(key: string): void {
  subs.get(key)?.forEach((cb) => cb());
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Loose deep equality for the small value shapes inputs publish: scalars,
 * arrays, and plain objects (e.g. the `location` input's `{lat,lng,label}`).
 *
 * Object-valued inputs MUST compare structurally, not by reference. A render
 * recomputes `inputValue` into a fresh object each time, so a reference compare
 * always reports "changed" — which makes the GroupView publish effect re-write
 * the store and `notify()` every synced pane on every edit (a latent publish↔
 * adopt ping-pong once any object-valued input gains a real `setInputValue`).
 */
export function valueEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => valueEqual(x, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    return keys.every(
      (k) => Object.prototype.hasOwnProperty.call(b, k) && valueEqual(a[k], b[k]),
    );
  }
  return false;
}

// Another tab wrote the shared store — drop our cache and re-notify.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (!e.key || !e.key.startsWith(PREFIX)) return;
    const key = e.key.slice(PREFIX.length);
    cache.delete(key);
    notify(key);
  });
}
