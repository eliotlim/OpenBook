import * as React from 'react';

import {cn} from '@/lib/utils';
import {Skeleton} from '@/components/ui/skeleton';
import {SANDBOX_FLAGS, wrapSandboxDocument} from '@/lib/srcdoc';

/**
 * Ambient Content-Security-Policy for every {@link SandboxedHtml} beneath the
 * provider. Default `undefined` = no CSP meta (the app's posture: the opaque
 * origin is the boundary; artifacts may load their own remote assets). The
 * standalone export viewer provides `EXPORT_ARTIFACT_CSP` so an exported file
 * keeps its zero-network promise even against adversarial artifacts. A context
 * (not a prop threaded through every block) because the block renderer is
 * shared verbatim between the app and the viewer bundle — only the mounting
 * shell knows which world it is.
 */
export const SandboxCspContext = React.createContext<string | undefined>(undefined);

/**
 * Render arbitrary UNTRUSTED HTML (AI-generated artifacts, imported/embedded
 * documents, published-page previews) inside a locked-down `<iframe srcdoc>`.
 * This is the one reusable surface every "HTML artifact" block/preview mounts,
 * so the security posture lives in one place ({@link SANDBOX_FLAGS}).
 *
 * ── Security model ──────────────────────────────────────────────────────────
 * The frame is sandboxed with {@link SANDBOX_FLAGS} and, deliberately, WITHOUT
 * `allow-same-origin`. That gives the document an *opaque* origin, which is the
 * whole guarantee:
 *  - Scripts inside the frame run, but at a foreign origin. They CANNOT read
 *    `parent.document`, `document.cookie`, `localStorage`/`sessionStorage`, or
 *    reach any app API with the user's session — the same-origin policy blocks
 *    every cross-origin property access, throwing `SecurityError`.
 *  - `window.top` / `window.parent` are reachable as opaque handles (you can't
 *    stop a frame from *seeing* it has a parent), but their document/properties
 *    are not readable, and navigation of the top frame is blocked because we
 *    never grant `allow-top-navigation`.
 *  - The srcdoc is passed to React's `srcDoc` prop, which serializes it as a DOM
 *    attribute (no HTML-string interpolation), so there is no attribute
 *    breakout to escape here. The centralized {@link escapeSrcdocAttribute}
 *    helper exists for the export path that builds the iframe as a raw string.
 *
 * What the sandbox does NOT do: it is not a network firewall. `allow-scripts`
 * lets the document fetch/`<img>`/`<a>` to arbitrary URLs. We accept this — HTML
 * artifacts are expected to load their own images/fonts/data, and an opaque
 * origin already blocks reading *our* cookies/DOM, so outbound requests carry no
 * ambient authority. Callers that need network isolation must add CSP at a
 * higher layer; that is out of scope for the isolation this component provides.
 *
 * Adding `allow-same-origin` would collapse all of the above and hand the
 * untrusted HTML the app origin (stored XSS) — see the constant's doc comment.
 * It is forbidden.
 */
export interface SandboxedHtmlProps {
  /** The untrusted HTML document/fragment to render. */
  html: string;
  /**
   * Frame height in CSS pixels. Fixed and prop-driven by design (default 320).
   *
   * Auto-resize (postMessage from the frame with its `scrollHeight`) is
   * DEFERRED, not forgotten: under the opaque origin the parent can still
   * receive a `message` and verify `event.source === iframe.contentWindow`, so
   * reading a clamped number would be safe *in principle* — but the height
   * would have to be reported by a trusted shim injected INTO the same document
   * as the untrusted, script-enabled content, which could suppress or spoof it.
   * The value is purely cosmetic and always needs clamping anyway, so a fixed
   * prop height is the deterministic, safe default for the spike. Revisit if a
   * concrete artifact type needs fluid height.
   */
  height?: number;
  /** Accessible title for the frame (screen readers, and required by a11y). */
  title?: string;
  /**
   * Text for the empty state (no HTML yet). The component is deliberately
   * provider-free (it also mounts inside the block editor's bare React root),
   * so it cannot call the i18n hook itself — callers pass an already-translated
   * string; the default is the English fallback.
   */
  emptyLabel?: string;
  /** Text for the error state — same provider-free contract as `emptyLabel`. */
  errorLabel?: string;
  /**
   * Content-Security-Policy meta injected into the sandboxed document (see
   * `wrapSandboxDocument`). Defaults to the ambient {@link SandboxCspContext}
   * value; pass explicitly to override. Tightens only — it can never widen the
   * sandbox.
   */
  csp?: string;
  /**
   * Fill the parent instead of using the fixed pixel `height` — for surfaces
   * that size the frame themselves (the full-window artifact overlay). The
   * sandbox posture is identical; only the sizing strategy changes.
   */
  fill?: boolean;
  className?: string;
}

const DEFAULT_HEIGHT = 320;

type LoadState = 'loading' | 'ready' | 'error';

/**
 * @see SandboxedHtmlProps for the full security model.
 */
export function SandboxedHtml({
  html,
  height = DEFAULT_HEIGHT,
  title = 'Sandboxed HTML content',
  emptyLabel = 'Nothing to preview yet.',
  errorLabel = 'This content could not be displayed.',
  csp,
  fill = false,
  className,
}: SandboxedHtmlProps): React.ReactElement {
  const ambientCsp = React.useContext(SandboxCspContext);
  const [state, setState] = React.useState<LoadState>('loading');
  const isEmpty = html.trim().length === 0;
  // `fill` sizes via the parent (h-full); otherwise the fixed prop height.
  const sizeStyle = fill ? undefined : {height};

  // Re-enter the loading state whenever the source changes, so the skeleton
  // reappears while the new document paints instead of flashing stale content.
  React.useEffect(() => {
    if (isEmpty) return;
    setState('loading');
  }, [html, isEmpty]);

  if (isEmpty) {
    return (
      <div
        className={cn(
          'flex items-center justify-center rounded-md border border-dashed border-border bg-muted/30 text-sm text-muted-foreground',
          fill && 'h-full',
          className,
        )}
        style={sizeStyle}
        data-testid="sandboxed-html-empty"
      >
        {emptyLabel}
      </div>
    );
  }

  const srcDoc = wrapSandboxDocument(html, {csp: csp ?? ambientCsp});

  return (
    <div className={cn('relative overflow-hidden rounded-md border border-border bg-background', fill && 'h-full', className)}>
      {state === 'loading' && (
        <Skeleton className="absolute inset-0 rounded-md" data-testid="sandboxed-html-loading" />
      )}
      {state === 'error' && (
        <div
          className="absolute inset-0 flex items-center justify-center bg-muted/30 text-sm text-muted-foreground"
          data-testid="sandboxed-html-error"
        >
          {errorLabel}
        </div>
      )}
      <iframe
        // NB: no `allow-same-origin` — the opaque origin is the security
        // boundary. See the component doc comment before touching the sandbox.
        sandbox={SANDBOX_FLAGS}
        // Explicitly empty permissions policy: no camera/mic/geolocation/etc.
        // The opaque origin already denies powerful features (permission grants
        // key on origin), so this is self-documenting posture, not the boundary.
        allow=""
        srcDoc={srcDoc}
        title={title}
        // `referrerPolicy` keeps the app's URL out of any request the frame
        // makes; the opaque origin already scrubs the Origin header.
        referrerPolicy="no-referrer"
        loading="lazy"
        onLoad={() => setState('ready')}
        onError={() => setState('error')}
        className={cn('block w-full border-0 bg-background', fill && 'h-full')}
        style={sizeStyle}
        data-testid="sandboxed-html-frame"
      />
    </div>
  );
}

export default SandboxedHtml;
