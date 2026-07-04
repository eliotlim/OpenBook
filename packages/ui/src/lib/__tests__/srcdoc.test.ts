import {describe, it, expect} from 'vitest';

import {SANDBOX_FLAGS, escapeSrcdocAttribute, wrapSandboxDocument} from '../srcdoc';

/**
 * The escaping helper is the load-bearing security primitive for the export
 * path that builds `<iframe srcdoc="…">` as a raw HTML string. These tests
 * assert that adversarial payloads stay INSIDE the double-quoted attribute
 * value and cannot break out into the host page.
 *
 * We validate breakout containment structurally: build the real
 * `<iframe srcdoc="…">…` string, parse it with the browser's HTML parser
 * (happy-dom), and assert the iframe's `srcdoc` attribute round-trips to the
 * ORIGINAL untrusted payload — i.e. nothing leaked out of the attribute as
 * sibling markup. jsdom/happy-dom won't execute the frame's scripts, but the
 * parse-level containment check is exactly what proves no attribute breakout.
 */
function renderIntoAttribute(payload: string): {srcdoc: string | null; siblingHtml: string} {
  const wrapper = document.createElement('div');
  wrapper.innerHTML = `<iframe sandbox="${SANDBOX_FLAGS}" srcdoc="${escapeSrcdocAttribute(payload)}"></iframe><b id="sentinel">safe</b>`;
  const iframe = wrapper.querySelector('iframe');
  const sentinel = wrapper.querySelector('#sentinel');
  return {
    srcdoc: iframe?.getAttribute('srcdoc') ?? null,
    // The sentinel must remain the iframe's only following sibling; a breakout
    // would inject attacker nodes between the iframe and it.
    siblingHtml: sentinel ? (sentinel.previousElementSibling?.tagName ?? '') : 'MISSING',
  };
}

describe('escapeSrcdocAttribute', () => {
  it('encodes exactly the attribute-breakout characters (&, ", \')', () => {
    expect(escapeSrcdocAttribute('&')).toBe('&amp;');
    expect(escapeSrcdocAttribute('"')).toBe('&quot;');
    expect(escapeSrcdocAttribute('\'')).toBe('&#39;');
  });

  it('does NOT encode < or > so the frame document still renders', () => {
    // These are literal inside a quoted attribute; escaping them would make the
    // srcdoc show markup as text instead of rendering it.
    expect(escapeSrcdocAttribute('<div>hi</div>')).toBe('<div>hi</div>');
  });

  it('encodes & first so existing entities do not double-decode', () => {
    // If & weren't escaped first, `&quot;` in input would decode to a real quote.
    expect(escapeSrcdocAttribute('&quot;')).toBe('&amp;quot;');
  });

  it('contains a classic "></iframe><script> breakout payload', () => {
    const payload = '"></iframe><script>steal(document.cookie)</script>';
    const {srcdoc, siblingHtml} = renderIntoAttribute(payload);
    // The whole payload round-trips as the srcdoc attribute value...
    expect(srcdoc).toBe(payload);
    // ...and no injected node appears before the sentinel: only the iframe.
    expect(siblingHtml).toBe('IFRAME');
  });

  it('contains a bare </script> payload', () => {
    const payload = '<p>ok</p></script><script>alert(1)</script>';
    const {srcdoc} = renderIntoAttribute(payload);
    expect(srcdoc).toBe(payload);
  });

  it('contains a </iframe>-with-quote breakout payload', () => {
    const payload = 'x" onload="alert(1)"></iframe>';
    const {srcdoc, siblingHtml} = renderIntoAttribute(payload);
    expect(srcdoc).toBe(payload);
    expect(siblingHtml).toBe('IFRAME');
    // The spoofed onload must NOT have become a real attribute on the iframe.
    const wrapper = document.createElement('div');
    wrapper.innerHTML = `<iframe srcdoc="${escapeSrcdocAttribute(payload)}"></iframe>`;
    expect(wrapper.querySelector('iframe')?.hasAttribute('onload')).toBe(false);
  });

  it('preserves emoji and non-Latin text verbatim', () => {
    const payload = '<p>Hello 🌍 café 日本語</p>';
    expect(escapeSrcdocAttribute(payload)).toBe(payload);
    const {srcdoc} = renderIntoAttribute(payload);
    expect(srcdoc).toBe(payload);
  });

  it('contains nested srcdoc content (an iframe-within-the-payload)', () => {
    const payload = '<iframe srcdoc="&lt;b&gt;nested&lt;/b&gt;"></iframe>';
    const {srcdoc, siblingHtml} = renderIntoAttribute(payload);
    expect(srcdoc).toBe(payload);
    expect(siblingHtml).toBe('IFRAME');
  });
});

describe('wrapSandboxDocument', () => {
  it('prepends a standards-mode doctype + utf-8 charset', () => {
    expect(wrapSandboxDocument('<p>hi</p>')).toBe('<!doctype html><meta charset="utf-8"><p>hi</p>');
  });

  it('does not escape the untrusted body (it is raw document source)', () => {
    // Inside document source (not an attribute/script), these tags are just
    // parsed as part of the frame document — no escaping is applied.
    const body = '</script><iframe></iframe>';
    expect(wrapSandboxDocument(body)).toContain(body);
  });
});

describe('SANDBOX_FLAGS', () => {
  it('grants scripts/popups/forms/modals', () => {
    expect(SANDBOX_FLAGS).toBe('allow-scripts allow-popups allow-forms allow-modals');
  });

  it('NEVER grants allow-same-origin (the security boundary)', () => {
    expect(SANDBOX_FLAGS).not.toContain('allow-same-origin');
  });
});
