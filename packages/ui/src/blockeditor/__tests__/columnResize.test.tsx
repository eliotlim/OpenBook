import {afterEach, describe, expect, it, vi} from 'vitest';
import {cleanup, fireEvent, render, screen} from '@testing-library/react';
import {
  columnBoundaryFromPointer,
  COLUMN_GRID_UNITS,
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
  it('spreads fallback remainders and never creates zero-width imported columns', () => {
    expect(normalizeColumnSpans([undefined, undefined, undefined, undefined, undefined])).toEqual([3, 3, 2, 2, 2]);
    expect(normalizeColumnSpans(Array(13).fill(undefined))).toEqual(Array(13).fill(1));
  });

  it('cascades through 1-unit neighbours in either direction', () => {
    expect(resizeColumnBoundary([5, 1, 1, 1, 4], 0, 7)).toEqual([7, 1, 1, 1, 2]);
    expect(resizeColumnBoundary([5, 1, 1, 1, 4], 3, 6)).toEqual([3, 1, 1, 1, 6]);
  });

  it('uses the real 12-track grid pitch for internal and trailing boundaries', () => {
    const left = 100;
    const gap = 20;
    const width = 1240;
    const pitch = (width + gap) / COLUMN_GRID_UNITS;
    const track = (width - gap * (COLUMN_GRID_UNITS - 1)) / COLUMN_GRID_UNITS;
    expect(pitch).toBeCloseTo(track + gap);

    const boundaryCentre = left + pitch * 8 - gap / 2;
    expect(columnBoundaryFromPointer(boundaryCentre, left, pitch, gap)).toBe(8);
    expect(columnBoundaryFromPointer(boundaryCentre + pitch * 0.49, left, pitch, gap)).toBe(8);
    expect(columnBoundaryFromPointer(boundaryCentre + pitch * 0.51, left, pitch, gap)).toBe(9);
    expect(trailingColumnBoundaryFromPointer(boundaryCentre + pitch, boundaryCentre, 8, pitch)).toBe(7);
  });
});

describe('column separators', () => {
  it('renders a five-column fallback across all 12 units', () => {
    const {container} = render(<BlockEditor doc={createDoc([columns(Array(5).fill(undefined))])} />);
    const rendered = [...container.querySelectorAll<HTMLElement>('.obe-columns > .obe-column')]
      .map((column) => Number(column.style.gridColumn.replace('span ', '')));
    expect(rendered).toEqual([3, 3, 2, 2, 2]);
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

  it('writes only spans changed by the resize', () => {
    const doc = createDoc([columns([5, undefined, 1, 1, 4])]);
    render(<BlockEditor doc={doc} />);

    fireEvent.keyDown(screen.getByRole('separator', {name: 'Resize columns 1 and 2'}), {key: 'ArrowRight'});
    expect(docToJSON(doc)[0].children!.map((column) => column.props?.span)).toEqual([6, 1, 1, 1, 4]);
  });

  it('captures pointer drags on the divider and restores iframe hit testing on capture loss', () => {
    const doc = createDoc([columns([5, 1, 1, 1, 4])]);
    const {container} = render(<BlockEditor doc={doc} />);
    const wrap = container.querySelector<HTMLElement>('.obe-columns')!;
    wrap.style.columnGap = '20px';
    vi.spyOn(wrap, 'getBoundingClientRect').mockReturnValue({
      x: 100,
      y: 0,
      left: 100,
      top: 0,
      right: 1340,
      bottom: 500,
      width: 1240,
      height: 500,
      toJSON: () => ({}),
    });
    const frame = document.createElement('iframe');
    wrap.append(frame);
    const divider = screen.getByRole('separator', {name: 'Resize columns 4 and 5'});
    const setPointerCapture = vi.fn();
    Object.defineProperty(divider, 'setPointerCapture', {configurable: true, value: setPointerCapture});

    fireEvent.pointerDown(divider, {pointerId: 7, clientX: 930});
    expect(setPointerCapture).toHaveBeenCalledWith(7);
    expect(frame.style.pointerEvents).toBe('none');

    fireEvent.pointerMove(window, {pointerId: 7, clientX: 825});
    expect(storedSpans(doc)).toEqual([5, 1, 1, 1, 4]);
    fireEvent.pointerMove(divider, {pointerId: 7, clientX: 825});
    expect(storedSpans(doc)).toEqual([4, 1, 1, 1, 5]);

    fireEvent.lostPointerCapture(divider, {pointerId: 7});
    expect(frame.style.pointerEvents).toBe('');
    fireEvent.pointerMove(divider, {pointerId: 7, clientX: 720});
    expect(storedSpans(doc)).toEqual([4, 1, 1, 1, 5]);
  });
});
