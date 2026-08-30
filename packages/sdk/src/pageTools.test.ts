import {describe, expect, it} from 'vitest';
import {COVER_GRADIENTS, buildPageAppearancePatch} from './pageTools';
import {COVER_PROPERTY_ID} from './pageProperties';

describe('buildPageAppearancePatch cover validation', () => {
  it('rejects arbitrary gradient css and resolves a curated gradient id', () => {
    expect(() => buildPageAppearancePatch({cover: {kind: 'gradient', css: 'url(https://beacon.invalid)'} as never})).toThrow();
    expect(buildPageAppearancePatch({cover: {kind: 'gradient', gradientId: 'ocean'}})[COVER_PROPERTY_ID]).toEqual({
      kind: 'gradient',
      css: COVER_GRADIENTS.find(({id}) => id === 'ocean')!.css,
    });
  });

  it.each(['http://example.com/cover.jpg', 'javascript:alert(1)'])('rejects unsafe image URL %s', (url) => {
    expect(() => buildPageAppearancePatch({cover: {kind: 'image', url}})).toThrow('cover.url must be https or an OpenBook asset URL');
  });

  it.each(['https://example.com/cover.jpg', '/api/assets/cover-id'])('accepts safe image URL %s', (url) => {
    expect(buildPageAppearancePatch({cover: {kind: 'image', url}})[COVER_PROPERTY_ID]).toEqual({kind: 'image', url});
  });
});
