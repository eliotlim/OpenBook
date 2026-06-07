/**
 * Best-effort DOM enhancements applied to a live EditorJS holder, driven by a
 * MutationObserver:
 *  - **autocorrect off** on verbatim fields (the code tool's `<textarea>`), and
 *  - **preselect the first item** of the block/slash popover so Enter inserts it.
 *
 * Both poke EditorJS internals (its `.ce-popover` markup and `Flipper`), so they
 * are intentionally defensive — if the markup shifts they simply no-op.
 *
 * It also keeps inline page-mention anchors (`a.ob-mention`) showing each linked
 * page's current title/icon, re-applying when the page list changes.
 */
import {pageLinks, subscribePageLinks} from '@/lib/pageLinks';

/** Turn off autocorrect/autocapitalize/spellcheck on a verbatim field. */
export function disableAutocorrect(el: Element): void {
  el.setAttribute('autocorrect', 'off');
  el.setAttribute('autocapitalize', 'off');
  el.setAttribute('spellcheck', 'false');
}

// EditorJS's Flipper switches on the legacy `keyCode`, which the KeyboardEvent
// constructor ignores in its init dict — define it (and `which`) explicitly.
function arrowDownEvent(): KeyboardEvent {
  const ev = new KeyboardEvent('keydown', {key: 'ArrowDown', bubbles: true, cancelable: true});
  Object.defineProperty(ev, 'keyCode', {get: () => 40});
  Object.defineProperty(ev, 'which', {get: () => 40});
  return ev;
}

/**
 * If the block/slash popover is open with nothing focused, nudge EditorJS's
 * Flipper (which listens for ArrowDown on `document`) to focus the first
 * selectable item, so the user can press Enter to insert it. No-op otherwise.
 */
export function preselectFirstPopoverItem(holder: HTMLElement): void {
  const popover = holder.querySelector('.ce-popover--opened');
  if (!popover) return;
  if (popover.querySelector('.ce-popover-item--focused')) return;
  const firstItem = popover.querySelector(
    '.ce-popover-item:not(.ce-popover-item--hidden):not(.ce-popover-item-separator):not(.ce-popover-item--no-focus)',
  );
  if (!firstItem) return;
  // Dispatch on the popover (an Element) — it bubbles to the document listener
  // EditorJS's Flipper uses, but keeps `e.target` an Element so other keydown
  // handlers that call `e.target.closest(...)` don't choke on `document`.
  popover.dispatchEvent(arrowDownEvent());
}

function applyAutocorrectOff(holder: HTMLElement): void {
  holder.querySelectorAll('textarea:not([data-ob-noac])').forEach((ta) => {
    disableAutocorrect(ta);
    ta.setAttribute('data-ob-noac', '');
  });
}

/** Keep each inline mention showing its page's current icon + title. */
function refreshMentions(holder: HTMLElement): void {
  holder.querySelectorAll('a.ob-mention[data-page-id]').forEach((a) => {
    const id = a.getAttribute('data-page-id');
    if (!id) return;
    const desired = `${pageLinks.icon(id)} ${pageLinks.label(id)}`;
    if (a.textContent !== desired) a.textContent = desired;
  });
}

/**
 * Install the enhancements on a holder. Runs once, then on every relevant DOM
 * mutation (new blocks, popover open/filter) and whenever the page list changes
 * (mention titles). Returns a disposer.
 */
export function installEditorChrome(holder: HTMLElement): () => void {
  const run = (): void => {
    applyAutocorrectOff(holder);
    preselectFirstPopoverItem(holder);
    refreshMentions(holder);
  };
  run();
  const observer = new MutationObserver(run);
  observer.observe(holder, {childList: true, subtree: true, attributes: true, attributeFilter: ['class']});
  const unsubscribe = subscribePageLinks(run);
  return () => {
    observer.disconnect();
    unsubscribe();
  };
}
