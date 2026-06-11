import {describe, expect, it} from 'vitest';
import {extent, funnelRows, linePoints, pieArcs, ticks, toLabelled, toPoints, toSeries} from '../chartMath';

describe('toSeries', () => {
  it('wraps a number array as one series', () => {
    expect(toSeries([1, 2, 3])).toEqual([{name: '', values: [1, 2, 3]}]);
  });

  it('names series from an object of arrays (overlays)', () => {
    expect(toSeries({a: [1, 2], b: [3, 4]})).toEqual([
      {name: 'a', values: [1, 2]},
      {name: 'b', values: [3, 4]},
    ]);
  });

  it('takes y from point arrays and accepts nested arrays', () => {
    expect(toSeries([{x: 0, y: 5}, {x: 1, y: 7}])).toEqual([{name: '', values: [5, 7]}]);
    expect(toSeries([[1, 2], [3, 4]])).toEqual([
      {name: 's1', values: [1, 2]},
      {name: 's2', values: [3, 4]},
    ]);
  });

  it('rejects junk quietly', () => {
    expect(toSeries('nope')).toEqual([]);
    expect(toSeries([1, 'x'])).toEqual([]);
    expect(toSeries(undefined)).toEqual([]);
    expect(toSeries([])).toEqual([]);
  });
});

describe('toLabelled', () => {
  it('pairs values with provided labels, falling back to #n', () => {
    expect(toLabelled([5, 3], ['A'])).toEqual([
      {label: 'A', value: 5},
      {label: '#2', value: 3},
    ]);
  });

  it('reads {label: value} objects directly', () => {
    expect(toLabelled({Visits: 100, Sales: 20}, [])).toEqual([
      {label: 'Visits', value: 100},
      {label: 'Sales', value: 20},
    ]);
  });
});

describe('toPoints', () => {
  it('passes {x,y} arrays through and indexes plain numbers', () => {
    expect(toPoints([{x: 2, y: 3}])).toEqual([{x: 2, y: 3}]);
    expect(toPoints([7, 9])).toEqual([
      {x: 0, y: 7},
      {x: 1, y: 9},
    ]);
  });
});

describe('extent / ticks / linePoints', () => {
  it('anchors the extent at zero and never collapses', () => {
    expect(extent([5, 10])).toEqual({min: 0, max: 10});
    expect(extent([0, 0])).toEqual({min: -1, max: 1});
    expect(extent([-5, 5]).min).toBe(-5);
  });

  it('produces round ticks inside the extent', () => {
    const t = ticks({min: 0, max: 10});
    expect(t).toContain(0);
    expect(t).toContain(10);
    expect(t.every((v) => v >= 0 && v <= 10)).toBe(true);
  });

  it('spreads line points across the padded width', () => {
    const pts = linePoints([0, 10], {min: 0, max: 10}, 100, 50, 10).split(' ');
    expect(pts[0]).toBe('10,40'); // min value at left/bottom
    expect(pts[1]).toBe('90,10'); // max value at right/top
  });
});

describe('pieArcs', () => {
  it('splits the circle by value and reports fractions', () => {
    const arcs = pieArcs([1, 1, 2], 50, 50, 40);
    expect(arcs).toHaveLength(3);
    expect(arcs.map((a) => a.fraction)).toEqual([0.25, 0.25, 0.5]);
    expect(arcs[0].path).toContain('A 40 40');
  });

  it('handles a single full slice without collapsing the arc', () => {
    const [arc] = pieArcs([5], 50, 50, 40);
    expect(arc.fraction).toBe(1);
    expect(arc.path.length).toBeGreaterThan(20);
  });

  it('returns nothing for non-positive totals', () => {
    expect(pieArcs([0, -2], 50, 50, 40)).toEqual([]);
  });
});

describe('funnelRows', () => {
  it('centres each stage scaled to the max', () => {
    const rows = funnelRows([100, 50], 200, 100, 0);
    expect(rows[0]).toMatchObject({x: 0, width: 200});
    expect(rows[1]).toMatchObject({x: 50, width: 100});
    expect(rows[0].height).toBe(50);
  });
});
