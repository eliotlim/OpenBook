import {describe, expect, it} from 'vitest';
import {
  latestSnapshotAuthor,
  stampSnapshotAuthors,
  stampSnapshotAuthorsPerBlock,
  stampSnapshotMtimes,
  type PageSnapshot,
} from '@book.dev/sdk';

const snap = (blocks: Array<{id: string; text: string}>): PageSnapshot => ({
  editorjs: {blocks: blocks.map((b) => ({id: b.id, type: 'paragraph', data: {text: b.text}}))},
  values: [],
  names: [],
});

describe('snapshot authorship (OB-170)', () => {
  it('attributes changed blocks to the verified author, carrying unchanged ones', () => {
    const v1 = stampSnapshotAuthors(null, snap([{id: 'a', text: 'A'}, {id: 'b', text: 'B'}]), 'iss#alice');
    expect(new Map(v1.authors)).toEqual(new Map([['a', 'iss#alice'], ['b', 'iss#alice']]));

    // Bob edits only block b.
    const v2 = stampSnapshotAuthors(v1, snap([{id: 'a', text: 'A'}, {id: 'b', text: 'B2'}]), 'iss#bob');
    expect(new Map(v2.authors)).toEqual(new Map([['a', 'iss#alice'], ['b', 'iss#bob']]));
  });

  it('records nothing for an unverified / empty subject', () => {
    expect(stampSnapshotAuthors(null, snap([{id: 'a', text: 'A'}]), '').authors).toBeUndefined();
  });

  it('an anonymous edit clears a block’s verified author rather than keeping it', () => {
    const v1 = stampSnapshotAuthors(null, snap([{id: 'a', text: 'A'}]), 'iss#alice');
    const v2 = stampSnapshotAuthors(v1, snap([{id: 'a', text: 'changed'}]), ''); // anonymous
    expect(v2.authors).toBeUndefined();
  });

  it('latestSnapshotAuthor returns the newest attributed author (via mtimes)', () => {
    const v1 = stampSnapshotAuthors(
      null,
      stampSnapshotMtimes(null, snap([{id: 'a', text: 'A'}]), '2026-01-01T00:00:00.000Z'),
      'iss#alice',
    );
    const v2 = stampSnapshotAuthors(
      v1,
      stampSnapshotMtimes(v1, snap([{id: 'a', text: 'A'}, {id: 'b', text: 'B'}]), '2026-02-01T00:00:00.000Z'),
      'iss#bob',
    );
    expect(latestSnapshotAuthor(v2)).toBe('iss#bob');
    expect(latestSnapshotAuthor(snap([{id: 'a', text: 'A'}]))).toBeNull();
  });
});

describe('per-block snapshot authorship (Collab T9 server-authoritative persist)', () => {
  it('credits each changed block to a DIFFERENT principal from the map', () => {
    // One converged checkpoint merges Alice's edit to `a` and Bob's to `b`.
    const v1 = stampSnapshotAuthorsPerBlock(
      null,
      snap([{id: 'a', text: 'A'}, {id: 'b', text: 'B'}]),
      new Map([['a', 'iss#alice'], ['b', 'iss#bob']]),
    );
    expect(new Map(v1.authors)).toEqual(new Map([['a', 'iss#alice'], ['b', 'iss#bob']]));
  });

  it('keeps an unchanged block’s prior author and re-attributes only the changed one', () => {
    const v1 = stampSnapshotAuthorsPerBlock(
      null,
      snap([{id: 'a', text: 'A'}, {id: 'b', text: 'B'}]),
      new Map([['a', 'iss#alice'], ['b', 'iss#alice']]),
    );
    // Only `b` changes; its map entry is Bob. `a` is untouched → keeps Alice even though
    // the map (a since-last-checkpoint record) no longer mentions it.
    const v2 = stampSnapshotAuthorsPerBlock(
      v1,
      snap([{id: 'a', text: 'A'}, {id: 'b', text: 'B2'}]),
      new Map([['b', 'iss#bob']]),
    );
    expect(new Map(v2.authors)).toEqual(new Map([['a', 'iss#alice'], ['b', 'iss#bob']]));
  });

  it('a guest (empty subject) change clears the block’s verified author — never forged', () => {
    const v1 = stampSnapshotAuthorsPerBlock(null, snap([{id: 'a', text: 'A'}]), new Map([['a', 'iss#alice']]));
    const v2 = stampSnapshotAuthorsPerBlock(v1, snap([{id: 'a', text: 'guest'}]), new Map([['a', '']]));
    expect(v2.authors).toBeUndefined();
  });

  it('a changed block absent from the map is left un-attributed (honest, not forged)', () => {
    const v1 = stampSnapshotAuthorsPerBlock(null, snap([{id: 'a', text: 'A'}]), new Map([['a', 'iss#alice']]));
    // `a` changed but the map is empty (an untracked change) → cleared, not carried.
    const v2 = stampSnapshotAuthorsPerBlock(v1, snap([{id: 'a', text: 'changed'}]), new Map());
    expect(v2.authors).toBeUndefined();
  });
});
