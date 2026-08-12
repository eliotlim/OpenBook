/**
 * Whether a right-click belongs to the browser's editable-text menu instead of
 * an OpenBook context menu. The browser menu is the only surface that carries
 * spelling suggestions and the platform cut/copy/paste actions.
 */
export function shouldUseNativeEditableContextMenu(target: EventTarget | null): boolean {
  const targetEl = target instanceof Element ? target : null;
  if (!targetEl) return false;

  // Respect the nearest explicit contenteditable boundary: mention chips and
  // editor chrome opt out with contenteditable=false even when nested in text.
  const textControl = targetEl.closest('textarea, input') as HTMLTextAreaElement | HTMLInputElement | null;
  const editableBoundary = targetEl.closest('[contenteditable]') as HTMLElement | null;
  const editable = textControl ?? (editableBoundary?.getAttribute('contenteditable') !== 'false' ? editableBoundary : null);
  if (!editable) return false;

  // The page title and code source always need their native editable menu,
  // including when their caret is collapsed.
  if (targetEl.closest('.ob-page-title')) return true;
  if (targetEl.closest('.obe-codeblock') && targetEl.closest('[data-block-text]')) return true;

  if (textControl) {
    return textControl.selectionStart != null && textControl.selectionEnd != null
      ? textControl.selectionStart !== textControl.selectionEnd
      : false;
  }
  const selection = document.getSelection();
  return selection?.isCollapsed === false &&
    selection.rangeCount > 0 &&
    editable.contains(selection.getRangeAt(0).commonAncestorContainer);
}

/** The page menu also yields for selected read-only text under the pointer. */
export function shouldUseNativePageContextMenu(target: EventTarget | null): boolean {
  if (shouldUseNativeEditableContextMenu(target)) return true;
  const targetEl = target instanceof Element ? target : null;
  const selection = document.getSelection();
  if (!targetEl || selection?.isCollapsed !== false || selection.rangeCount === 0) return false;
  const range = selection.getRangeAt(0);
  const common = range.commonAncestorContainer;
  const commonEl = common instanceof Element ? common : common.parentElement;
  return commonEl != null && commonEl.contains(targetEl) && range.intersectsNode(targetEl);
}

/**
 * Run on the capture phase, before Radix's trigger handler. Stopping propagation
 * prevents Radix (and any enclosing OpenBook menu) from opening without
 * cancelling the event, so the browser still receives the native contextmenu.
 */
export function passEditableContextMenuToBrowser(event: {
  target: EventTarget | null;
  stopPropagation(): void;
}): void {
  if (shouldUseNativeEditableContextMenu(event.target)) event.stopPropagation();
}

/** Page-level variant that also preserves Copy for selected read-only text. */
export function passPageContextMenuToBrowser(event: {
  target: EventTarget | null;
  stopPropagation(): void;
}): void {
  if (shouldUseNativePageContextMenu(event.target)) event.stopPropagation();
}
