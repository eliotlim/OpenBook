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
 * The Content-Security-Policy injected into sandboxed artifacts rendered in a
 * STANDALONE EXPORT (the viewer bundle provides it via `SandboxCspContext`).
 *
 * Rationale: in the app, an artifact loading its own remote images/data is an
 * accepted trade-off (see the SandboxedHtml doc — the opaque origin already
 * strips ambient authority). An exported file should stay quiet when opened,
 * so the export context tightens what it can. The HONEST contract:
 *
 *  - CLOSED by this CSP: every passive/scripted sub-resource load — fetch/XHR/
 *    WebSocket/beacon (`connect-src` via `default-src 'none'`), `<img>`,
 *    media, fonts, CSS `url()` — plus form posts (`form-action 'none'`) and
 *    nested frames (no `frame-src`). Inline script/style and `data:`/`blob:`
 *    media stay allowed so real artifacts keep working.
 *
 *  - NOT closed (the irreducible residual of sandbox + meta-CSP, mirroring the
 *    SandboxedHtml "not a network firewall" caveat): CSP fetch directives do
 *    not govern NAVIGATION. With `allow-scripts` an artifact may navigate its
 *    OWN frame (`location.href = 'https://…'`) — only *top*-navigation is
 *    sandbox-gated (correctly not granted) — and `allow-popups` (an owner
 *    posture decision) permits gesture-gated `window.open`. Best-effort
 *    `navigate-to 'none'` is included for engines that implement it; where
 *    unsupported it is ignored. Net: an adversarial artifact cannot *silently*
 *    exfiltrate via sub-resource loads, but frame self-navigation on open
 *    remains possible — a visible act (the artifact replaces itself with the
 *    destination) rather than a quiet beacon.
 *
 * Delivered as a `<meta http-equiv>` inside the srcdoc document (the only CSP
 * channel available to a file:// export). Meta-CSP caveats accepted: it cannot
 * carry `frame-ancestors`/`report-uri` (not needed here), and it governs the
 * document from its position — {@link wrapSandboxDocument} places it before
 * any untrusted markup.
 */
export const EXPORT_ARTIFACT_CSP =
  'default-src \'none\'; script-src \'unsafe-inline\' \'unsafe-eval\'; style-src \'unsafe-inline\'; ' +
  'img-src data: blob:; media-src data: blob:; font-src data:; form-action \'none\'; navigate-to \'none\'';

/**
 * Wrap untrusted HTML in a minimal standards-mode document shell: a UTF-8
 * charset (so emoji and non-Latin text render correctly inside the frame),
 * optionally a Content-Security-Policy meta (`opts.csp` — the export context
 * passes {@link EXPORT_ARTIFACT_CSP}), and the untrusted markup as the
 * document body source.
 *
 * The untrusted HTML is appended as raw document *source*, not into an
 * attribute or a `<script>`, so no escaping is applied or needed — any tags it
 * contains (including `</script>` / `</iframe>`) are simply parsed as part of
 * the sandboxed document. A caller-supplied full `<!doctype html>…` document is
 * fine too: the extra leading doctype/charset is ignored by the parser. The
 * CSP meta lands in the implied `<head>` BEFORE any untrusted markup, so it
 * governs the whole document (a CSP can only tighten; the untrusted content
 * cannot lift it).
 *
 * The result is passed verbatim to the iframe (via React's `srcDoc` prop in the
 * component, or through {@link escapeSrcdocAttribute} when serialized to an HTML
 * string in the export pipeline — that helper's contract is QUOTED attributes
 * only).
 */
export function wrapSandboxDocument(html: string, opts: {csp?: string} = {}): string {
  const csp = opts.csp
    ? `<meta http-equiv="Content-Security-Policy" content="${escapeSrcdocAttribute(opts.csp)}">`
    : '';
  return `<!doctype html><meta charset="utf-8">${csp}${html}`;
}
