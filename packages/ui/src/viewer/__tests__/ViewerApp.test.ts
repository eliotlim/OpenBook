import {describe, expect, it} from 'vitest';
import {pagesOf} from '../ViewerApp';
import type {LibraryBundleJson} from '../types';

describe('pagesOf — exporter/viewer trust boundary (UP-4)', () => {
  it('hands an unlisted page in a dirty bundle to the renderer', () => {
    const source: LibraryBundleJson = {
      pages: [{id: 'hidden-but-present', name: 'Dirty bundle page', listed: false, data: {}}],
      databases: [],
    };

    // Cleanliness belongs to gatherSite. The standalone viewer is deliberately
    // faithful to arbitrary/legacy bundles and does not reinterpret metadata.
    expect(pagesOf(source)).toEqual([
      {id: 'hidden-but-present', name: 'Dirty bundle page', icon: null, data: {}},
    ]);
  });
});
