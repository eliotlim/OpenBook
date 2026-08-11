import {describe, expect, it} from 'vitest';
import type {FormSchema} from '@book.dev/sdk';
import {getCustomBlock} from '../registry';
import {registerFormBlock} from '../FormBlockView';
import {createDoc, decodeSnapshot, docToJSON, encodeSnapshot} from '../model';

describe('form block registration and wire shape', () => {
  it('registers an interactive slash item with fresh cryptographic ids', () => {
    registerFormBlock();
    const def = getCustomBlock('form');
    expect(def?.slash?.label).toBe('Form');
    expect(def?.slash?.group).toBe('interactive');

    const first = def!.slash!.make();
    const second = def!.slash!.make();
    expect(first.type).toBe('form');
    expect(first.props?.formId).not.toBe(second.props?.formId);
    expect(first.props?.submissionKey).not.toBe(second.props?.submissionKey);
    expect(first.props?.submissionKey).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(first.props?.schema).toMatchObject({
      formId: first.props?.formId,
      submissionKey: first.props?.submissionKey,
      enabled: true,
      fields: [],
    });
  });

  it('round-trips every FORM-1 gate prop through the CRDT JSON projection', () => {
    const schema: FormSchema = {
      formId: 'form-contact',
      submissionKey: 'abcdefghijklmnopqrstuv',
      enabled: true,
      databaseId: 'db-contacts',
      fields: [{id: 'email', kind: 'email', label: 'Email', required: true}],
      confirmation: {message: 'Received'},
    };
    const doc = createDoc([{
      id: 'form-block',
      type: 'form',
      props: {
        formId: schema.formId,
        submissionKey: schema.submissionKey,
        enabled: schema.enabled,
        databaseId: schema.databaseId,
        schema,
      },
    }]);

    const reopened = decodeSnapshot(encodeSnapshot(doc));
    const projected = docToJSON(reopened)[0];
    expect(JSON.parse(JSON.stringify(projected))).toEqual({
      id: 'form-block',
      type: 'form',
      props: {
        formId: 'form-contact',
        submissionKey: 'abcdefghijklmnopqrstuv',
        enabled: true,
        databaseId: 'db-contacts',
        schema,
      },
    });
  });
});
