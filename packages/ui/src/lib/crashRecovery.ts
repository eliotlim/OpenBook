// Crash-loop recovery for the poison-page problem (STAB-3).
//
// A page whose stored content throws while rendering blanks the app; because
// saving is doc-driven (not render-driven) the poison persists, and the startup
// resolver deterministically re-opens the last page — so the app dies again on
// every reload: a crash loop.
//
// The page-level error boundary records the offending page id here on catch, and
// the navigation startup resolver skips any recorded id so the app lands on Home
// instead of re-poisoning itself. The poisoned page stays reachable manually
// (the user can click it in the sidebar) — it just never AUTO-loads again.
//
// Scope is the browser tab session on purpose: sessionStorage survives a reload
// (which is how the loop would otherwise repeat) but a fresh app launch starts
// clean, so a page fixed out-of-band isn't quarantined forever.

const CRASH_KEY = 'openbook.crashedPageIds';

const read = (): Set<string> => {
  try {
    if (typeof sessionStorage === 'undefined') return new Set();
    const raw = sessionStorage.getItem(CRASH_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed.filter((v): v is string => typeof v === 'string')) : new Set();
  } catch {
    return new Set();
  }
};

const write = (ids: Set<string>): void => {
  try {
    if (typeof sessionStorage !== 'undefined') sessionStorage.setItem(CRASH_KEY, JSON.stringify([...ids]));
  } catch {
    // ignore storage failures — quarantine is best-effort
  }
};

/** Quarantine a page that threw while rendering, so startup won't auto-open it. */
export const markPageCrashed = (pageId: string): void => {
  if (!pageId) return;
  const ids = read();
  if (ids.has(pageId)) return;
  ids.add(pageId);
  write(ids);
};

/** The set of pages the startup resolver must skip (crashed this tab session). */
export const readCrashedPages = (): Set<string> => read();

/** True if `pageId` is quarantined (crashed earlier this session). */
export const isPageCrashed = (pageId: string | null | undefined): boolean =>
  !!pageId && read().has(pageId);

/** Clear one page's quarantine, or all of them when no id is given. */
export const clearCrashedPage = (pageId?: string): void => {
  if (!pageId) {
    try {
      if (typeof sessionStorage !== 'undefined') sessionStorage.removeItem(CRASH_KEY);
    } catch {
      // ignore
    }
    return;
  }
  const ids = read();
  if (ids.delete(pageId)) write(ids);
};
