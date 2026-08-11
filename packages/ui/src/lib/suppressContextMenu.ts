export interface SuppressibleContextMenuEvent {
  target: EventTarget | null;
  preventDefault(): void;
}

/** Keep native editing menus, while suppressing browser chrome elsewhere. */
export function suppressContextMenu(event: SuppressibleContextMenuEvent): void {
  const target = event.target;
  if (target instanceof Element) {
    if (target.closest('input, textarea, select')) return;

    // The nearest explicit contenteditable value wins. This handles descendants
    // of an editor as well as contenteditable="false" islands inside one.
    const editable = target.closest('[contenteditable]');
    if (editable && editable.getAttribute('contenteditable')?.toLowerCase() !== 'false') return;
  }

  event.preventDefault();
}
