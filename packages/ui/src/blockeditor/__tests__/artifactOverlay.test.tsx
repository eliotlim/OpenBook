import {afterEach, describe, expect, it} from 'vitest';
import {render, cleanup, waitFor, fireEvent} from '@testing-library/react';
import {createDoc} from '../model';
import {BlockEditor} from '../BlockEditor';
import {SANDBOX_FLAGS} from '@/lib/srcdoc';
import {setAssetBridge, type AssetBridgeImpl} from '@/lib/assetBridge';

/**
 * The artifact "run full-window" overlay (ArtifactOverlay): an expand
 * affordance on the block's frame opens the sandboxed document edge-to-edge in
 * a portaled overlay; Esc / the always-visible close button return to the page.
 *
 * State contract under test: the overlay is a CLEAN RE-INSTANTIATION (a second
 * sandboxed frame from the same source) while the INLINE frame stays mounted
 * and untouched — the same iframe element across expand/collapse.
 */

function installBridge(html: string): void {
  const bytes = new TextEncoder().encode(html);
  const impl: AssetBridgeImpl = {
    putAsset: () => Promise.resolve({id: 'A1'}),
    getAsset: (id) => Promise.resolve(id === 'A1' ? {bytes, mime: 'application/octet-stream'} : null),
  };
  setAssetBridge(impl);
}

afterEach(() => {
  cleanup();
  setAssetBridge(null);
});

const DOC_HTML = '<h1 id="inner">running artifact</h1>';

async function mountArtifact(opts: {readOnly?: boolean} = {}) {
  installBridge(DOC_HTML);
  const doc = createDoc([{id: 'art', type: 'htmlArtifact', props: {assetId: 'A1', title: 'Demo'}}]);
  const view = render(<BlockEditor doc={doc} pageId="page-1" readOnly={opts.readOnly} />);
  await waitFor(() => expect(view.container.querySelector('.obe-artifact iframe')).toBeTruthy());
  return view;
}

describe('artifact expand affordance', () => {
  it('renders on the frame — and stays available in read-only (a viewing affordance)', async () => {
    const editable = await mountArtifact();
    expect(editable.container.querySelector('.obe-artifact-expand')).toBeTruthy();
    cleanup();
    const readOnly = await mountArtifact({readOnly: true});
    // Authoring chrome is gone, but the expand (viewing) control remains.
    expect(readOnly.container.querySelector('.obe-artifact-resize')).toBeNull();
    expect(readOnly.container.querySelector('.obe-artifact-expand')).toBeTruthy();
  });

  it('opens a full-window overlay with a SECOND sandboxed frame (same posture, same source)', async () => {
    const {container} = await mountArtifact();
    fireEvent.click(container.querySelector('.obe-artifact-expand')!);

    // The overlay portals to <body>; its frame is a fresh instance (clean
    // re-instantiation — documented contract), same sandbox flags + srcdoc.
    const overlay = await waitFor(() => {
      const el = document.querySelector('[data-testid="artifact-overlay"]');
      expect(el).toBeTruthy();
      return el!;
    });
    const overlayFrame = overlay.querySelector('iframe') as HTMLIFrameElement;
    expect(overlayFrame).toBeTruthy();
    expect(overlayFrame.getAttribute('sandbox')).toBe(SANDBOX_FLAGS);
    expect(overlayFrame.getAttribute('sandbox')).not.toContain('allow-same-origin');
    expect(overlayFrame.getAttribute('srcdoc')).toContain('running artifact');
    // The inline frame is still mounted underneath, untouched.
    expect(container.querySelector('.obe-artifact iframe')).toBeTruthy();
  });

  it('the close button collapses the overlay; the INLINE frame element survives untouched', async () => {
    const {container} = await mountArtifact();
    const inlineBefore = container.querySelector('.obe-artifact iframe');
    fireEvent.click(container.querySelector('.obe-artifact-expand')!);
    await waitFor(() => expect(document.querySelector('[data-testid="artifact-overlay"]')).toBeTruthy());

    // The always-visible close button (focus-recovery affordance) closes it.
    fireEvent.click(document.querySelector('[data-testid="artifact-overlay"] button[aria-label="Close full window"]')!);
    await waitFor(() => expect(document.querySelector('[data-testid="artifact-overlay"]')).toBeNull());
    // Same inline iframe ELEMENT before and after — never reparented/reloaded.
    expect(container.querySelector('.obe-artifact iframe')).toBe(inlineBefore);
  });

  it('Escape closes the overlay (Radix topmost-layer dismiss)', async () => {
    const {container} = await mountArtifact();
    fireEvent.click(container.querySelector('.obe-artifact-expand')!);
    const overlay = await waitFor(() => {
      const el = document.querySelector('[data-testid="artifact-overlay"]');
      expect(el).toBeTruthy();
      return el as HTMLElement;
    });
    fireEvent.keyDown(overlay, {key: 'Escape'});
    await waitFor(() => expect(document.querySelector('[data-testid="artifact-overlay"]')).toBeNull());
  });
});
