import {describe, expect, it} from 'vitest';
import {prepareEvalRequest, referencedIdentifiers, UNSUPPORTED_SCOPE_ERROR} from '../scopeMarshal';

describe('sandbox scope marshalling', () => {
  it('extracts referenced identifiers without copying strings, comments, or property names', () => {
    const names = referencedIdentifiers(`
      total + scope.class + group.field.value
      // ignoredComment
      /* ignoredBlock */ "ignoredString";
    `);
    expect([...names]).toEqual(expect.arrayContaining(['total', 'scope', 'class', 'group']));
    expect(names).not.toContain('field');
    expect(names).not.toContain('value');
    expect(names).not.toContain('ignoredComment');
    expect(names).not.toContain('ignoredBlock');
    expect(names).not.toContain('ignoredString');
  });

  it('copies only referenced structured-clone values', () => {
    const ignored = () => 'host function';
    const prepared = prepareEvalRequest({
      kind: 'expression',
      source: 'series[1] + place.lat',
      scope: {
        series: [1, 2, 3],
        place: {lat: 1.25, lng: 103.8, label: 'Singapore'},
        ignored,
      },
    });
    expect(prepared).toMatchObject({
      scope: {series: [1, 2, 3], place: {lat: 1.25, lng: 103.8, label: 'Singapore'}},
    });
    expect((prepared as {scope: Record<string, unknown>}).scope).not.toHaveProperty('ignored');
  });

  it('turns a referenced unsupported host value into a defined evaluator error', () => {
    const prepared = prepareEvalRequest({
      kind: 'expression',
      source: 'hostFunction()',
      scope: {hostFunction: () => 42},
    });
    expect(prepared).toEqual({error: `${UNSUPPORTED_SCOPE_ERROR}: function`});
  });
});
