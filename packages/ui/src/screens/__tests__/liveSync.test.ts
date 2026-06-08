import {describe, it, expect} from 'vitest';
import {planBlockSync, isPersistWorthyChange, stableStringify, type SyncBlock} from '../liveSync';

const b = (id: string, type: string, data: unknown): SyncBlock => ({id, type, data});

describe('planBlockSync', () => {
  it('is a no-op for an identical snapshot (stops the save loop / layout shift)', () => {
    const blocks = [b('1', 'paragraph', {text: 'a'}), b('2', 'expr', {source: '1+1'})];
    // A fresh array with equal contents — the echo of our own save.
    const plan = planBlockSync(blocks, blocks.map((x) => ({...x, data: {...(x.data as object)}})), null);
    expect(plan).toEqual({deletes: [], updates: [], inserts: []});
  });

  it('treats key-reordered data as unchanged (the jsonb round-trip; no callout save loop)', () => {
    // Live save() emits insertion order; the server's jsonb stores keys sorted.
    const current = [b('c', 'callout', {variant: 'info', emoji: undefined, text: 'hi'})];
    const next = [b('c', 'callout', {text: 'hi', variant: 'info'})];
    expect(planBlockSync(current, next, null).updates).toEqual([]);
  });

  it('updates only the block whose data changed', () => {
    const current = [b('1', 'paragraph', {text: 'a'}), b('2', 'paragraph', {text: 'b'})];
    const next = [b('1', 'paragraph', {text: 'a'}), b('2', 'paragraph', {text: 'B!'})];
    const plan = planBlockSync(current, next, null);
    expect(plan.deletes).toEqual([]);
    expect(plan.inserts).toEqual([]);
    expect(plan.updates).toEqual([{id: '2', data: {text: 'B!'}}]);
  });

  it('never updates or deletes the focused block (protects the caret)', () => {
    const current = [b('1', 'paragraph', {text: 'a'}), b('2', 'paragraph', {text: 'b'})];
    const next = [b('1', 'paragraph', {text: 'CHANGED'})]; // block 2 removed, block 1 changed
    const plan = planBlockSync(current, next, '1');
    expect(plan.updates).toEqual([]); // block 1 is focused → not updated
    expect(plan.deletes).toEqual(['2']); // block 2 (not focused) still removed
  });

  it('deletes blocks missing from the incoming snapshot', () => {
    const current = [b('1', 'paragraph', {text: 'a'}), b('2', 'paragraph', {text: 'b'})];
    const next = [b('1', 'paragraph', {text: 'a'})];
    const plan = planBlockSync(current, next, null);
    expect(plan.deletes).toEqual(['2']);
    expect(plan.updates).toEqual([]);
    expect(plan.inserts).toEqual([]);
  });

  it('inserts added blocks anchored after their predecessor', () => {
    const current = [b('1', 'paragraph', {text: 'a'})];
    const next = [b('1', 'paragraph', {text: 'a'}), b('2', 'paragraph', {text: 'new'})];
    const plan = planBlockSync(current, next, null);
    expect(plan.inserts).toEqual([
      {id: '2', type: 'paragraph', data: {text: 'new'}, afterId: '1', index: 1},
    ]);
  });

  it('anchors a leading insert at the document start (afterId null)', () => {
    const current = [b('1', 'paragraph', {text: 'a'})];
    const next = [b('0', 'paragraph', {text: 'first'}), b('1', 'paragraph', {text: 'a'})];
    const plan = planBlockSync(current, next, null);
    expect(plan.inserts).toEqual([
      {id: '0', type: 'paragraph', data: {text: 'first'}, afterId: null, index: 0},
    ]);
  });

  it('ignores blocks without ids', () => {
    const current = [b('1', 'paragraph', {text: 'a'})];
    const next: SyncBlock[] = [{type: 'paragraph', data: {text: 'x'}}, b('1', 'paragraph', {text: 'a'})];
    const plan = planBlockSync(current, next, null);
    expect(plan).toEqual({deletes: [], updates: [], inserts: []});
  });
});

describe('stableStringify', () => {
  it('is order-insensitive for object keys and drops undefined, but keeps array order', () => {
    expect(stableStringify({a: 1, b: 2})).toBe(stableStringify({b: 2, a: 1}));
    expect(stableStringify({x: 1, y: undefined})).toBe(stableStringify({x: 1}));
    expect(stableStringify({n: {p: 1, q: 2}})).toBe(stableStringify({n: {q: 2, p: 1}}));
    expect(stableStringify([1, 2, 3])).not.toBe(stableStringify([3, 2, 1])); // array order matters
  });
});

describe('isPersistWorthyChange', () => {
  it('counts structural edits', () => {
    expect(isPersistWorthyChange({type: 'block-added'})).toBe(true);
    expect(isPersistWorthyChange({type: 'block-removed'})).toBe(true);
    expect(isPersistWorthyChange({type: 'block-moved'})).toBe(true);
  });

  it('ignores block-changed from blocks that fire it spuriously (no save loop)', () => {
    // Reactive recompute sources…
    expect(isPersistWorthyChange({type: 'block-changed', detail: {target: {name: 'expr'}}})).toBe(false);
    expect(isPersistWorthyChange({type: 'block-changed', detail: {target: {name: 'chart'}}})).toBe(false);
    expect(isPersistWorthyChange({type: 'block-changed', detail: {target: {name: 'slider'}}})).toBe(false);
    // …and third-party blocks that re-normalize on mount/update (genuine edits
    // to these reach autosave via the `input` listener instead).
    expect(isPersistWorthyChange({type: 'block-changed', detail: {target: {name: 'table'}}})).toBe(false);
    expect(isPersistWorthyChange({type: 'block-changed', detail: {target: {name: 'checklist'}}})).toBe(false);
    expect(isPersistWorthyChange({type: 'block-changed'})).toBe(false);
  });

  it('counts block-changed from edit-signaling blocks (no input event of their own)', () => {
    expect(isPersistWorthyChange({type: 'block-changed', detail: {target: {name: 'subpage'}}})).toBe(true);
    expect(isPersistWorthyChange({type: 'block-changed', detail: {target: {name: 'callout'}}})).toBe(true);
    expect(isPersistWorthyChange({type: 'block-changed', detail: {target: {name: 'accordion'}}})).toBe(true);
    expect(isPersistWorthyChange({type: 'block-changed', detail: {target: {name: 'divider'}}})).toBe(true);
  });

  it('handles arrays and missing events', () => {
    expect(isPersistWorthyChange([{type: 'block-changed', detail: {target: {name: 'expr'}}}, {type: 'block-added'}])).toBe(true);
    expect(isPersistWorthyChange(undefined)).toBe(false);
  });
});
