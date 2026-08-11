import {describe, expect, it} from 'vitest';
import type {StoredPage} from '@book.dev/sdk';
import {constantTimeSubmissionKeyEqual, findFormInPage} from './formAccess';

const pageWith = (blocks: unknown[], blockdoc: unknown = undefined): Pick<StoredPage, 'data'> => ({
  data: {editorjs: {blocks}, values: [], names: [], ...(blockdoc === undefined ? {} : {blockdoc})},
});

describe('constantTimeSubmissionKeyEqual', () => {
  it('accepts identical keys and rejects wrong content or length', () => {
    expect(constantTimeSubmissionKeyEqual('same-key', 'same-key')).toBe(true);
    expect(constantTimeSubmissionKeyEqual('same-kex', 'same-key')).toBe(false);
    expect(constantTimeSubmissionKeyEqual('', 'same-key')).toBe(false);
    expect(constantTimeSubmissionKeyEqual('same-key-with-a-suffix', 'same-key')).toBe(false);
  });
});

describe('findFormInPage', () => {
  const props = {
    formId: 'contact',
    submissionKey: 'capability',
    enabled: true,
    databaseId: 'database-1',
    schema: {fields: []},
  };

  it('finds a nested form in the retained editorjs projection', () => {
    const page = pageWith([{type: 'columns', children: [{type: 'column', children: [{type: 'form', props}]}]}]);
    expect(findFormInPage(page, 'contact')).toEqual(props);
  });

  it('does not scan blockdoc in place of the editorjs storage alias', () => {
    const page = pageWith([], {blocks: [{type: 'form', props}]});
    expect(findFormInPage(page, 'contact')).toBeNull();
  });

  it('fails closed on malformed or duplicate matching definitions', () => {
    expect(findFormInPage(pageWith([{type: 'form', props: {...props, submissionKey: ''}}]), 'contact')).toBeNull();
    expect(findFormInPage(pageWith([{type: 'form', props}, {type: 'form', props}]), 'contact')).toBeNull();
  });
});
