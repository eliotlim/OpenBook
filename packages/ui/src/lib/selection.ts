/**
 * Tracks the user's most recent DOCUMENT text selection so the assistant can
 * pass it as context. A module-level `selectionchange` listener (installed once
 * on the client) keeps the last meaningful selection even after focus moves to a
 * composer — by the time the user clicks into the assistant input the live
 * selection has collapsed, so capturing it in the panel would be too late.
 *
 * Selections inside app chrome (the assistant panel, inputs, textareas) are
 * ignored, so only real document selections are remembered.
 */
let last = '';

if (typeof document !== 'undefined') {
  document.addEventListener('selectionchange', () => {
    const sel = window.getSelection();
    const text = sel?.toString().trim() ?? '';
    if (!text) return;
    const node = sel?.anchorNode ?? null;
    const el = node instanceof Element ? node : node?.parentElement ?? null;
    if (el?.closest('[data-agent-panel], input, textarea')) return;
    last = text;
  });
}

/** The last document text selection (excluding app chrome), or '' if none. */
export const lastSelection = (): string => last;
