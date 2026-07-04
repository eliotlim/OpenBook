/**
 * Sandboxed-HTML security primitives — the single source of truth for how
 * OpenBook renders *untrusted* HTML (AI-generated artifacts, imported/embedded
 * documents, published-page previews). Pure functions and constants only, with
 * NO React dependency, so the export pipeline (which builds `<iframe srcdoc>`
 * as an HTML string, off the DOM) reuses the exact same escaping and posture as
 * the live {@link SandboxedHtml} component. One place to change the contract.
 */

/**
 * The iframe `sandbox` attribute for every untrusted-HTML surface. Kept as ONE
 * exported constant so the security posture is a one-line edit reviewed in
 * isolation.
 *
 * What each token grants the untrusted document:
 *  - `allow-scripts` — run its own inline JS (interactive artifacts need this).
 *  - `allow-popups`  — `window.open` / `target="_blank"` links (popups inherit
 *                      the sandbox, so they stay sandboxed too).
 *  - `allow-forms`   — submit forms (a form artifact posts to its own action).
 *  - `allow-modals`  — `alert`/`confirm`/`prompt` inside the frame (they block
 *                      only the frame, not the host app).
 *
 * NEVER add `allow-same-origin`. With BOTH `allow-scripts` and
 * `allow-same-origin`, the frame runs at the APP's origin: the untrusted script
 * could then read `parent.document`, steal cookies / `localStorage`, call app
 * APIs with the user's session, and remove its own `sandbox` attribute — i.e.
 * turn any embedded artifact into stored XSS against the whole workspace.
 * Omitting it forces an *opaque* origin: scripts run, but cross-origin rules
 * wall the frame off from the parent document, cookies, and same-origin
 * storage. This exclusion is the entire security guarantee of this module — do
 * not relax it without a security review.
 */
export const SANDBOX_FLAGS = 'allow-scripts allow-popups allow-forms allow-modals';

/**
 * Escape a string so it is safe to place inside a DOUBLE-QUOTED HTML attribute
 * value — specifically the `srcdoc="…"` attribute — when building an iframe as
 * a raw HTML string (the export path; React's JSX escapes the `srcDoc` prop for
 * us, so the live component does not need this).
 *
 * We escape only `&`, `"`, and `'`. That is exactly, and only, what can break
 * out of a quoted attribute value: the matching quote ends the value, and `&`
 * must be encoded so existing entities round-trip. Crucially we DO NOT escape
 * `<` / `>` — inside a quoted attribute they are literal text, and the whole
 * point of `srcdoc` is that the browser re-parses the (decoded) value as the
 * frame's HTML document, so the untrusted markup must survive intact to render.
 *
 * This is what neutralizes classic breakout payloads: an attacker string like
 * `"></iframe><script>steal()</script>` cannot terminate the `srcdoc` attribute
 * (its `"` becomes `&quot;`), so `</iframe>` / `<script>` stay *inside* the
 * attribute and land in the sandboxed document rather than the host page. Bare
 * `<` / `>` and `</script>` / `</iframe>` sequences are harmless here precisely
 * because they never touch a `<script>` context or an unquoted attribute.
 */
export function escapeSrcdocAttribute(html: string): string {
  return html
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Wrap untrusted HTML in a minimal standards-mode document shell: a UTF-8
 * charset (so emoji and non-Latin text render correctly inside the frame) and
 * the untrusted markup as the document body source.
 *
 * The untrusted HTML is appended as raw document *source*, not into an
 * attribute or a `<script>`, so no escaping is applied or needed — any tags it
 * contains (including `</script>` / `</iframe>`) are simply parsed as part of
 * the sandboxed document. A caller-supplied full `<!doctype html>…` document is
 * fine too: the extra leading doctype/charset is ignored by the parser.
 *
 * The result is passed verbatim to the iframe (via React's `srcDoc` prop in the
 * component, or through {@link escapeSrcdocAttribute} when serialized to an HTML
 * string in the export pipeline).
 */
export function wrapSandboxDocument(html: string): string {
  return `<!doctype html><meta charset="utf-8">${html}`;
}
