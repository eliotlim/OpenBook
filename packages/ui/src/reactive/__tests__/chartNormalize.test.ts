import {describe, it, expect} from 'vitest';
import {normalizeChartInput} from '../chartNormalize';

describe('normalizeChartInput', () => {
  it('bare number array becomes one series named after the fallback', () => {
    expect(normalizeChartInput([1, 2, 3], 'rate')).toEqual([{name: 'rate', data: [1, 2, 3]}]);
  });

  it('filters non-numeric entries out of a bare array', () => {
    expect(normalizeChartInput([1, 'two', null, 3, NaN], 'mixed')).toEqual([
      {name: 'mixed', data: [1, 3, NaN]},
    ]);
    // NaN is `typeof === 'number'` so it survives — caller's job to guard if undesired.
  });

  it('empty array returns no series (chart shows "no numeric data")', () => {
    expect(normalizeChartInput([], 'empty')).toEqual([]);
  });

  it('{series: [{name, data}]} multi-series shape preserves names', () => {
    const input = {
      series: [
        {name: 'principal', data: [100, 110, 120]},
        {name: 'interest', data: [5, 6, 7]},
      ],
    };
    expect(normalizeChartInput(input, 'mortgage')).toEqual([
      {name: 'principal', data: [100, 110, 120]},
      {name: 'interest', data: [5, 6, 7]},
    ]);
  });

  it('series without name falls back to fallback.index', () => {
    const input = {series: [{data: [1, 2]}, {name: 'B', data: [3, 4]}]};
    expect(normalizeChartInput(input, 'src')).toEqual([
      {name: 'src.0', data: [1, 2]},
      {name: 'B', data: [3, 4]},
    ]);
  });

  it('series with empty data is dropped', () => {
    const input = {series: [{name: 'A', data: []}, {name: 'B', data: [1, 2]}]};
    expect(normalizeChartInput(input, 'src')).toEqual([{name: 'B', data: [1, 2]}]);
  });

  it('returns [] for unsupported shapes', () => {
    expect(normalizeChartInput('hello', 'x')).toEqual([]);
    expect(normalizeChartInput(42, 'x')).toEqual([]);
    expect(normalizeChartInput(null, 'x')).toEqual([]);
    expect(normalizeChartInput(undefined, 'x')).toEqual([]);
    expect(normalizeChartInput({notSeries: []}, 'x')).toEqual([]);
    expect(normalizeChartInput({series: 'not-an-array'}, 'x')).toEqual([]);
  });
});
