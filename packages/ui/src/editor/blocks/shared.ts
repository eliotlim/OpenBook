import type {SanitizerConfig} from '@editorjs/editorjs';

/**
 * Inline markup our rich-text fields keep through EditorJS's save sanitization:
 * the inline tools we register (bold, italic, marker, inline-code) plus the
 * `@`-mention anchor (mirrors `PageLinkInlineTool.sanitize` in editor/pageMention).
 * Apply this to every contenteditable data key (e.g. `{text: RICH_TEXT_SANITIZE}`).
 */
export const RICH_TEXT_SANITIZE: SanitizerConfig = {
  b: true,
  i: true,
  u: true,
  s: true,
  br: true,
  mark: {class: true},
  code: {class: true},
  a: {href: true, class: true, 'data-page-id': true, contenteditable: true},
};

/** Create a contenteditable rich-text region with a placeholder. */
export function makeEditable(opts: {className: string; html?: string; placeholder?: string}): HTMLDivElement {
  const el = document.createElement('div');
  el.className = opts.className;
  el.contentEditable = 'true';
  el.innerHTML = opts.html ?? '';
  if (opts.placeholder) el.dataset.placeholder = opts.placeholder;
  // Verbatim-friendly: callout/accordion bodies are prose, but keep the browser
  // from auto-capitalising the first letter mid-edit on touch keyboards.
  el.spellcheck = true;
  return el;
}

/** A namespaced SVG icon string for toolbox / tunes entries. */
export const icon = (paths: string): string =>
  `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
