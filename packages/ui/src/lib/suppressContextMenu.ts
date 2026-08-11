/** Prevent the browser/WebView menu from appearing over app-owned window chrome. */
export function suppressContextMenu(event: Pick<Event, 'preventDefault'>): void {
  event.preventDefault();
}
