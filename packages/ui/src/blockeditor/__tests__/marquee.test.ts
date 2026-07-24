import {describe, it, expect} from 'vitest';
import {marqueeRect, rectsIntersect, rowsInMarquee, shiftClickRange, type Rect} from '../marquee';

describe('marqueeRect', () => {
  it('normalises corners dragged in any direction', () => {
    const forward = marqueeRect(10, 20, 30, 40);
    expect(forward).toEqual({left: 10, top: 20, right: 30, bottom: 40});
    // Dragging up-and-left yields the same rect.
    expect(marqueeRect(30, 40, 10, 20)).toEqual(forward);
  });
});

describe('rectsIntersect', () => {
  const box: Rect = {left: 0, top: 0, right: 100, bottom: 100};
  it('detects overlap', () => {
    expect(rectsIntersect(box, {left: 50, top: 50, right: 150, bottom: 150})).toBe(true);
  });
  it('rejects a fully separated rect', () => {
    expect(rectsIntersect(box, {left: 200, top: 0, right: 300, bottom: 100})).toBe(false);
  });
  it('counts a touching edge as intersecting (grazing marquee still hits)', () => {
    expect(rectsIntersect(box, {left: 100, top: 0, right: 200, bottom: 100})).toBe(true);
  });
});

describe('rowsInMarquee', () => {
  // Five stacked rows, 20px tall each with a 2px gap.
  const rows = [0, 1, 2, 3, 4].map((i) => ({
    id: `r${i}`,
    rect: {left: 0, top: i * 22, right: 200, bottom: i * 22 + 20} as Rect,
  }));

  it('selects only the rows the rectangle crosses, preserving order', () => {
    // A rect from y=10 (inside r0) to y=50 (inside r2) grabs r0, r1, r2.
    const hit = rowsInMarquee(marqueeRect(20, 10, 180, 50), rows);
    expect(hit).toEqual(['r0', 'r1', 'r2']);
  });

  it('selects nothing when the rect sits in the gutter beside the rows', () => {
    // A rect entirely left of the rows (rows start at x=0).
    expect(rowsInMarquee(marqueeRect(-80, 0, -20, 200), rows)).toEqual([]);
  });

  it('grabs a middle band (3 of 5) — the acceptance shape', () => {
    // y 25..85 spans r1 (22-42), r2 (44-64), r3 (66-86); r4 starts at 88.
    const hit = rowsInMarquee(marqueeRect(20, 25, 180, 85), rows);
    expect(hit).toEqual(['r1', 'r2', 'r3']);
  });
});

describe('shiftClickRange', () => {
  const order = ['a', 'b', 'c', 'd', 'e'];

  it('extends downward from the nearest selected block', () => {
    // b selected, shift-click e -> b..e contiguous.
    expect(shiftClickRange(order, new Set(['b']), 'e', null)).toEqual(['b', 'c', 'd', 'e']);
  });

  it('extends upward from the nearest selected block', () => {
    expect(shiftClickRange(order, new Set(['d']), 'a', null)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('anchors on the NEAREST selected block when several are selected', () => {
    // a and d selected, shift-click e -> anchor is d (nearest), yields d..e.
    expect(shiftClickRange(order, new Set(['a', 'd']), 'e', null)).toEqual(['d', 'e']);
  });

  it('with no selection, extends from the focused block to the target', () => {
    expect(shiftClickRange(order, new Set(), 'd', 'b')).toEqual(['b', 'c', 'd']);
  });

  it('with no selection and no focus, selects just the target', () => {
    expect(shiftClickRange(order, new Set(), 'c', null)).toEqual(['c']);
  });

  it('ignores a target that is not a top-level block', () => {
    expect(shiftClickRange(order, new Set(['a']), 'zzz', null)).toEqual(['a']);
  });
});
