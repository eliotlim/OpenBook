import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {render, cleanup, waitFor} from '@testing-library/react';
import {createDoc, docToJSON} from '../model';
import {BlockEditor} from '../BlockEditor';
import {ASSET_TOO_LARGE_MESSAGE, MAX_ASSET_BYTES, imageBlockFromFile, type ImageBlockProps} from '../imageBlock';
import {setAssetBridge, type AssetBridgeImpl} from '@/lib/assetBridge';
import {registerBlockEditorDoc} from '@/lib/aiBridge';

/**
 * Native image block — Assets A2: ingest uploads → an `assetId` (not a data-URL),
 * the view resolves an `assetId` → an object URL and revokes it on unmount, the
 * legacy data-URL → assetId migration runs once, and a legacy data-URL block
 * without an asset backend still renders directly (back-compat).
 */

// A minimal valid 1×1 transparent PNG as a base64 data URL (a real, decodable
// data URL so the migration's `dataUrlToBytes` recovers bytes to upload).
const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

/** An in-memory asset bridge; `puts()` counts uploads (migration-once assertion). */
function installMockBridge() {
  const assets = new Map<string, {bytes: Uint8Array; mime: string}>();
  let n = 0;
  let puts = 0;
  const impl: AssetBridgeImpl = {
    putAsset: (bytes, mime) => {
      puts += 1;
      const id = `asset-${(n += 1)}`;
      assets.set(id, {bytes: new Uint8Array(bytes), mime});
      return Promise.resolve({id});
    },
    getAsset: (id) => Promise.resolve(assets.get(id) ?? null),
  };
  setAssetBridge(impl);
  return {assets, puts: () => puts};
}

// Object-URL stubs (happy-dom may not implement them, and we want deterministic
// create/revoke tracking regardless).
let created: string[] = [];
let revoked: string[] = [];
const origCreate = URL.createObjectURL;
const origRevoke = URL.revokeObjectURL;

beforeEach(() => {
  created = [];
  revoked = [];
  (URL as unknown as {createObjectURL: unknown}).createObjectURL = vi.fn(() => {
    const url = `blob:mock/${created.length + 1}`;
    created.push(url);
    return url;
  });
  (URL as unknown as {revokeObjectURL: unknown}).revokeObjectURL = vi.fn((url: string) => {
    revoked.push(url);
  });
});

afterEach(() => {
  cleanup();
  setAssetBridge(null);
  (URL as unknown as {createObjectURL: unknown}).createObjectURL = origCreate;
  (URL as unknown as {revokeObjectURL: unknown}).revokeObjectURL = origRevoke;
});

describe('image block — ingest uploads to an assetId (Assets A2)', () => {
  it('uploads the file bytes and stores an assetId, never a data-URL', async () => {
    installMockBridge();
    const file = new File(['hello-bytes'], 'cat_pic.png', {type: 'image/png'});
    const res = await imageBlockFromFile(file, 'page-1');
    expect('block' in res).toBe(true);
    if (!('block' in res)) return;
    const props = res.block.props as unknown as ImageBlockProps;
    expect(props.assetId).toBeTruthy();
    expect(props.src).toBeUndefined();
    expect(props.alt).toBe('cat pic'); // alt still seeded from the file name
  });

  it('falls back to an inline data-URL when no page id / asset backend is available', async () => {
    installMockBridge();
    // No pageId → the asset store can't ref, so it inlines a data-URL instead.
    const res = await imageBlockFromFile(new File(['x'], 'p.png', {type: 'image/png'}));
    expect('block' in res).toBe(true);
    if (!('block' in res)) return;
    const props = res.block.props as unknown as ImageBlockProps;
    expect(props.assetId).toBeUndefined();
    expect(props.src?.startsWith('data:image/png')).toBe(true);
  });

  it('rejects an over-cap (>10 MiB) image with the soft too-large message (pre-check)', async () => {
    installMockBridge();
    // Fake an oversize File (size only; the pre-check returns before reading bytes).
    const big = {type: 'image/png', size: MAX_ASSET_BYTES + 1, name: 'big.png'} as unknown as File;
    const res = await imageBlockFromFile(big, 'page-1');
    expect('error' in res).toBe(true);
    if (!('error' in res)) return;
    expect(res.error).toBe(ASSET_TOO_LARGE_MESSAGE);
    expect(res.soft).toBe(true);
  });

  it('maps a server 413 to the soft too-large message (base64 overhead over the cap)', async () => {
    // A near-cap raw image can 413 once base64-inflated; the ingest must surface
    // the honest, soft too-large message — not a misleading "try again".
    setAssetBridge({
      putAsset: () => Promise.reject(new Error('OpenBook request failed (413 Payload Too Large): request body too large')),
      getAsset: () => Promise.resolve(null),
    });
    const res = await imageBlockFromFile(new File(['near-cap'], 'x.png', {type: 'image/png'}), 'page-1');
    expect('error' in res).toBe(true);
    if (!('error' in res)) return;
    expect(res.error).toBe(ASSET_TOO_LARGE_MESSAGE);
    expect(res.soft).toBe(true);
  });
});

describe('image block — view resolves an assetId → object URL (Assets A2)', () => {
  it('fetches the asset, renders the object URL, and revokes it on unmount', async () => {
    const {assets} = installMockBridge();
    assets.set('A1', {bytes: new Uint8Array([1, 2, 3, 4]), mime: 'image/png'});
    const doc = createDoc([{id: 'img', type: 'image', props: {assetId: 'A1'}}]);
    const {container, unmount} = render(<BlockEditor doc={doc} pageId="page-1" />);

    await waitFor(() => expect(container.querySelector('img.obe-image-img')).toBeTruthy());
    const img = container.querySelector('img.obe-image-img') as HTMLImageElement;
    expect(created.length).toBe(1);
    expect(img.getAttribute('src')).toBe(created[0]); // the resolved object URL

    unmount();
    expect(revoked).toContain(created[0]); // revoked on unmount → no leak
  });

  it('shows a broken state when the asset is missing / unreadable', async () => {
    installMockBridge(); // empty store → getAsset('gone') resolves null
    const doc = createDoc([{id: 'img', type: 'image', props: {assetId: 'gone'}}]);
    const {container} = render(<BlockEditor doc={doc} pageId="page-1" />);
    await waitFor(() => expect(container.querySelector('.obe-image-placeholder')).toBeTruthy());
    expect(container.querySelector('img.obe-image-img')).toBeNull();
    expect(created.length).toBe(0); // nothing to render, nothing created
  });
});

describe('image block — legacy data-URL migration (Assets A2)', () => {
  it('migrates a data-URL block to an assetId exactly once and drops the inline src', async () => {
    const {puts} = installMockBridge();
    const doc = createDoc([{id: 'img', type: 'image', props: {src: TINY_PNG}}]);
    // The view sources the pageId from the doc↔page registry (aiBridge).
    const unregister = registerBlockEditorDoc('page-1', doc);
    render(<BlockEditor doc={doc} pageId="page-1" />);

    await waitFor(() => {
      const b = docToJSON(doc).find((x) => x.id === 'img');
      expect(b?.props?.assetId).toBeTruthy();
    });
    const b = docToJSON(doc).find((x) => x.id === 'img');
    expect(b?.props?.src).toBeUndefined(); // inline base64 dropped from the CRDT
    expect(puts()).toBe(1); // uploaded exactly once (guarded against re-upload)
    unregister();
  });

  it('a legacy data-URL block renders directly with no asset backend (no migration)', async () => {
    setAssetBridge(null); // no bridge → nothing to migrate to
    const doc = createDoc([{id: 'img', type: 'image', props: {src: TINY_PNG}}]);
    const {container} = render(<BlockEditor doc={doc} pageId="page-1" />);
    const img = container.querySelector('img.obe-image-img') as HTMLImageElement;
    expect(img).toBeTruthy();
    expect(img.getAttribute('src')).toBe(TINY_PNG); // rendered directly

    await Promise.resolve();
    const b = docToJSON(doc).find((x) => x.id === 'img');
    expect(b?.props?.src).toBe(TINY_PNG); // untouched
    expect(b?.props?.assetId).toBeUndefined();
  });
});
