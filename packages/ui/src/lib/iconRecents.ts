/**
 * Recently-picked page icons (emoji glyphs and `lucide:<Name>` refs alike),
 * persisted to localStorage so the icon picker can surface them first. Plain
 * module-level helpers — no React — so any call site can record a pick.
 */
const KEY = 'openbook.iconRecents';
const MAX = 24;

export function readIconRecents(): string[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(KEY);
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(arr) ? arr.filter((v): v is string => typeof v === 'string').slice(0, MAX) : [];
  } catch {
    return [];
  }
}

/** Move `value` to the front of the recents list (deduped), capped at {@link MAX}. */
export function pushIconRecent(value: string): void {
  if (typeof localStorage === 'undefined' || !value) return;
  try {
    const next = [value, ...readIconRecents().filter((v) => v !== value)].slice(0, MAX);
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // ignore (private mode / quota)
  }
}
