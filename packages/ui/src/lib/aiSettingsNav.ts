/**
 * A tiny bridge between the Settings nav rail and the AI settings panel. The
 * nav's per-provider sub-items call {@link focusAiProvider}; the AI panel (which
 * owns the provider accordions) registers a handler that expands the matching
 * accordion and scrolls it into view. Mirrors the kitPanel / reviewPane bridges
 * — it lets two sibling components coordinate without threading state through the
 * settings shell.
 *
 * If the AI panel isn't mounted yet (the sub-item was clicked from another tab),
 * the request is held and replayed when the panel registers.
 */
export type AiProviderFocus = (provider: string) => void;

let handler: AiProviderFocus | null = null;
let pending: string | null = null;

export function focusAiProvider(provider: string): void {
  if (handler) handler(provider);
  else pending = provider;
}

export function registerAiProviderFocus(fn: AiProviderFocus | null): void {
  handler = fn;
  if (fn && pending) {
    const p = pending;
    pending = null;
    fn(p);
  }
}
