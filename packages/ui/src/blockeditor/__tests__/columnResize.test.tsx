import {afterEach, describe, expect, it} from 'vitest';
import {cleanup, fireEvent, render, screen} from '@testing-library/react';
import {
  columnBoundaryFromPointer,
  columnGridUnit,
  createDoc,
  docToJSON,
  normalizeColumnSpans,
  resizeColumnBoundary,
  trailingColumnBoundaryFromPointer,
  type NewBlock,
} from '../model';
import {BlockEditor} from '../BlockEditor';

afterEach(() => cleanup());

const columns = (spans: Array<number | undefined>): NewBlock => ({
  id: 'layout',
  type: 'columns',
  children: spans.map((span, i) => ({
    id: `col-${i}`,
    type: 'column',
    ...(span === undefined ? {} : {props: {span}}),
    children: [{id: `text-${i}`, type: 'paragraph', text: `Column ${i + 1}`}],
  })),
});

const storedSpans = (doc: ReturnType<typeof createDoc>): number[] =>
  docToJSON(doc)[0].children!.map((column) => column.props?.span as number);

describe('column span math', () => {
  it('fills all 12 units for five missing spans, with the last column absorbing the remainder', () => {
    expect(normalizeColumnSpans([undefined, undefined, undefined, undefined, undefined])).toEqual([2, 2, 2, 2, 4]);
  });

  it('cascades through 1-unit neighbours in either direction', () => {
    expect(resizeColumnBoundary([5, 1, 1, 1, 4], 0, 7)).toEqual([7, 1, 1, 1, 2]);
    expect(resizeColumnBoundary([5, 1, 1, 1, 4], 3, 6)).toEqual([3, 1, 1, 1, 6]);
  });

  it('subtracts rendered gaps and tracks the absolute pointer within rounding', () => {
    const left = 100;
    const gap = 20;
    const unit = columnGridUnit(1240, gap, 5);
    expect(unit).toBeCloseTo((1240 - gap * 4) / 12);

    const boundaryCentre = left + unit * 8 + gap * 3.5;
    expect(columnBoundaryFromPointer(boundaryCentre, left, unit, gap, 3)).toBe(8);
    expect(columnBoundaryFromPointer(boundaryCentre + unit * 0.49, left, unit, gap, 3)).toBe(8);
    expect(columnBoundaryFromPointer(boundaryCentre + unit * 0.51, left, unit, gap, 3)).toBe(9);
    expect(trailingColumnBoundaryFromPointer(boundaryCentre + unit, boundaryCentre, 8, unit)).toBe(7);
  });
});

describe('column separators', () => {
  it('renders a five-column fallback across all 12 units', () => {
    const {container} = render(<BlockEditor doc={createDoc([columns(Array(5).fill(undefined))])} />);
    const rendered = [...container.querySelectorAll<HTMLElement>('.obe-columns > .obe-column')]
      .map((column) => Number(column.style.gridColumn.replace('span ', '')));
    expect(rendered).toEqual([2, 2, 2, 2, 4]);
    expect(rendered.reduce((sum, span) => sum + span, 0)).toBe(12);
  });

  it('resizes the last column by keyboard after its neighbour reaches one unit', () => {
    const doc = createDoc([columns([5, 1, 1, 1, 4])]);
    render(<BlockEditor doc={doc} />);

    const beforeLast = screen.getByRole('separator', {name: 'Resize columns 4 and 5'});
    expect(beforeLast.getAttribute('aria-valuemin')).toBe('4');
    expect(beforeLast.getAttribute('aria-valuemax')).toBe('11');
    expect(beforeLast.getAttribute('aria-valuenow')).toBe('8');
    fireEvent.keyDown(beforeLast, {key: 'ArrowLeft'});
    expect(storedSpans(doc)).toEqual([4, 1, 1, 1, 5]);
    expect(screen.getByRole('separator', {name: 'Resize columns 4 and 5'}).getAttribute('aria-valuenow')).toBe('7');

    const trailing = screen.getByRole('separator', {name: 'Resize last column'});
    expect(trailing.getAttribute('aria-valuenow')).toBe('5');
    fireEvent.keyDown(trailing, {key: 'ArrowRight'});
    expect(storedSpans(doc)).toEqual([3, 1, 1, 1, 6]);
    expect(screen.getByRole('separator', {name: 'Resize last column'}).getAttribute('aria-valuenow')).toBe('6');
  });
});
