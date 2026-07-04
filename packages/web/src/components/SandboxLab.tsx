import React, {useEffect} from 'react';
import {SandboxedHtml} from '@book.dev/ui';

/**
 * INTERNAL DEV HARNESS — not linked from the app. Exercises the reusable
 * {@link SandboxedHtml} renderer with untrusted-HTML fixtures so the real
 * cross-origin isolation can be asserted in a real browser (jsdom/happy-dom
 * cannot execute iframe scripts). Mirrors the /editor-lab pattern: a standalone
 * client-only page for building/testing a component before a block type exists.
 *
 * The e2e spec (packages/web/e2e/sandboxed-html.spec.ts) drives this route.
 */

// An interactive, self-contained artifact: inline JS wiring a counter button.
const COUNTER_HTML = `
<button id="btn" type="button" style="cursor:pointer;font:16px system-ui;padding:8px 14px">Count: 0</button>
<script>
  var n = 0;
  var b = document.getElementById('btn');
  b.addEventListener('click', function () { n += 1; b.textContent = 'Count: ' + n; });
</script>
`;

// A probe that ATTEMPTS to escape the sandbox and reports the outcome into its
// own DOM. Under the opaque origin every cross-origin access must throw, so the
// frame should render "BLOCKED" for each — that's the isolation proof.
const PROBE_HTML = `
<pre id="out" style="font:13px ui-monospace,monospace;white-space:pre-wrap">running…</pre>
<script>
  var out = document.getElementById('out');
  out.textContent = '';
  function line(t) { out.textContent += t + '\\n'; }
  try { line('parent-cookie:' + parent.document.cookie); } catch (e) { line('parent-cookie:BLOCKED'); }
  try { line('parent-dom:' + parent.document.getElementById('parent-secret').textContent); } catch (e) { line('parent-dom:BLOCKED'); }
  try { line('top-href:' + window.top.location.href); } catch (e) { line('top-href:BLOCKED'); }
  try { document.cookie = 'x=1'; line('own-cookie:' + (document.cookie || 'EMPTY')); } catch (e) { line('own-cookie:BLOCKED'); }
  line('has-parent:' + (window.parent !== window));
  line('scripts-run:yes');
</script>
`;

// A classic breakout payload: a stray </script> plus an attempt to overwrite the
// PARENT document title. Rendering via React's srcDoc prop means no attribute
// breakout is even possible; the opaque origin then blocks the parent write.
const BREAKOUT_HTML = `
<p id="before">before</p>
<img src="x" onerror="document.body.setAttribute('data-frame-onerror','ran')">
</script><script>try { window.parent.document.title = 'PWNED'; } catch (e) {}</script>
<p id="after">after</p>
`;

export default function SandboxLab(): React.ReactElement {
  // A stable parent title so the breakout spec can assert the frame never
  // overwrote it, and a parent-only secret the probe must fail to read.
  useEffect(() => {
    document.title = 'Sandbox Lab';
  }, []);

  return (
    <div style={{maxWidth: '44rem', margin: '0 auto', padding: '3rem 1.5rem'}}>
      <span style={{fontSize: 12, color: 'hsl(var(--muted-foreground))'}}>
        sandbox lab · internal — untrusted-HTML renderer harness
      </span>

      {/* Parent-only sensitive content the sandboxed frame must NOT be able to read. */}
      <div id="parent-secret" hidden>
        top-secret-parent-value
      </div>

      <h2 style={{fontSize: 15, fontWeight: 600, margin: '1.5rem 0 0.5rem'}}>Interactive artifact</h2>
      <div data-testid="demo-counter">
        <SandboxedHtml html={COUNTER_HTML} height={80} title="Counter demo" />
      </div>

      <h2 style={{fontSize: 15, fontWeight: 600, margin: '1.5rem 0 0.5rem'}}>Isolation probe</h2>
      <div data-testid="demo-probe">
        <SandboxedHtml html={PROBE_HTML} height={140} title="Isolation probe" />
      </div>

      <h2 style={{fontSize: 15, fontWeight: 600, margin: '1.5rem 0 0.5rem'}}>Breakout payload</h2>
      <div data-testid="demo-breakout">
        <SandboxedHtml html={BREAKOUT_HTML} height={100} title="Breakout payload" />
      </div>

      <h2 style={{fontSize: 15, fontWeight: 600, margin: '1.5rem 0 0.5rem'}}>Empty state</h2>
      <div data-testid="demo-empty">
        <SandboxedHtml html="" height={80} />
      </div>
    </div>
  );
}
