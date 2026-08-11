import {afterEach, describe, expect, it} from 'vitest';
import {
  readIsland,
  readLibraryIsland,
  type FormSchema,
  type PageSnapshot,
} from '@book.dev/sdk';
import {
  blocksToHtml,
  blocksToMarkdown,
  projectSnapshotForExport,
} from '../../blockeditor/exportBlocks';
import {
  createDoc,
  decodeSnapshot,
  docToJSON,
  encodeSnapshot,
  type BlockDocSnapshot,
  type BlockJSON,
} from '../../blockeditor/model';
import {projectBlockPageSnapshot} from '../../blockeditor/saveProjection';
import {blockTypeLabel} from '../../components/history/VersionDiff';
import {setShareLinkOrigin} from '../../lib/pageActions';
import {buildDocumentModel} from '../documentModel';
import {toHtml, toHtmlSite} from '../toHtml';
import {toMarkdown} from '../toMarkdown';
import {staticizeForms} from '../toPdf';
import type {SiteBundle} from '../exportSite';

const schema: FormSchema = {
  formId: 'form-contact',
  submissionKey: 'Qx7_vN2kL9pR4tY8mC3sJw',
  enabled: true,
  databaseId: 'db-contacts',
  submitLabel: 'Send response',
  fields: [
    {id: 'name', kind: 'text', label: 'Name', placeholder: 'Ada', required: true},
    {id: 'bio', kind: 'longtext', label: 'About you', required: false},
    {
      id: 'team',
      kind: 'select',
      label: 'Team',
      required: false,
      options: [{id: 'eng', label: 'Engineering'}],
    },
    {id: 'updates', kind: 'checkbox', label: 'Product updates', required: false},
  ],
  confirmation: {message: 'Received'},
  maxSubmissions: 500,
  retention: {enabled: true, days: 30, basis: 'created'},
};

const wire = {
  formId: schema.formId,
  submissionKey: schema.submissionKey,
  enabled: schema.enabled,
  databaseId: schema.databaseId,
  schema,
};

const block: BlockJSON = {id: 'form-block', type: 'form', props: wire};
const columnsBlock: BlockJSON = {
  id: 'columns-block',
  type: 'columns',
  children: [
    {id: 'form-column', type: 'column', children: [block]},
    {id: 'empty-column', type: 'column', children: []},
  ],
};
const rawSnapshot = (nested = false): PageSnapshot => projectSnapshotForExport({
  editor: 'blocks',
  blockdoc: encodeSnapshot(createDoc([nested ? columnsBlock : block])),
  editorjs: {blocks: []},
  values: [],
  names: [],
} as PageSnapshot);

function expectSanitizedFormSnapshot(snapshot: PageSnapshot, nested = false): void {
  const projectedRoot = (snapshot.editorjs as {blocks: Array<{data: Record<string, unknown>}>}).blocks[0];
  const projected = nested
    ? ((projectedRoot.data.columns as Array<Array<{data: Record<string, unknown>}>>)[0][0].data)
    : projectedRoot.data;
  const projectedProps = projected.props as Record<string, unknown>;
  const projectedSchema = projected.schema as Record<string, unknown>;
  const projectedPropsSchema = projectedProps.schema as Record<string, unknown>;
  expect(projected.submissionKey).toBeUndefined();
  expect(projectedProps.submissionKey).toBeUndefined();
  expect(projectedSchema.submissionKey).toBeUndefined();
  expect(projectedPropsSchema.submissionKey).toBeUndefined();
  expect(projected.formId).toBe(schema.formId);
  expect(projectedProps.formId).toBe(schema.formId);

  const nativeRoot = docToJSON(decodeSnapshot(snapshot.blockdoc as BlockDocSnapshot))[0];
  const native = (nested ? nativeRoot.children![0].children![0] : nativeRoot).props!;
  expect(native.submissionKey).toBeUndefined();
  expect((native.schema as Record<string, unknown>).submissionKey).toBeUndefined();
  expect(native.formId).toBe(schema.formId);
  expect((native.schema as Record<string, unknown>).formId).toBe(schema.formId);
}

afterEach(() => setShareLinkOrigin(null));

describe('form export arms', () => {
  it('renders frozen controls in the block HTML arm and a plain field list in its Markdown arm', () => {
    const html = blocksToHtml([block], {originPageUrl: 'https://published.example/?page=contact'});
    expect(html).toContain('data-ob-form');
    expect(html).toContain('data-form-id="form-contact"');
    expect(html).toContain('<input type="text" disabled');
    expect(html).toContain('<textarea rows="3" disabled');
    expect(html).toContain('<select disabled');
    expect(html).toContain('<input type="checkbox" disabled');
    expect(html).toContain('<button type="button" disabled>Send response</button>');
    expect(html).toContain('href="https://published.example/?page=contact"');
    expect(blocksToHtml([block], {originPageUrl: 'javascript:alert(1)'})).not.toContain('ob-form-live');

    const markdown = blocksToMarkdown([block]);
    expect(markdown).toContain('**Form**');
    expect(markdown).toContain('- Name (text, required)');
    expect(markdown).toContain('- About you (longtext)');
  });

  it('stores every FORM-1 gate prop losslessly in blockdoc and data.props', async () => {
    const saved = await projectBlockPageSnapshot(createDoc([block]), {editorjs: {blocks: []}, values: [], names: []});
    const native = (saved.blockdoc as BlockDocSnapshot).blocks[0];
    const projected = (saved.editorjs as {blocks: Array<{id: string; type: string; data: Record<string, unknown>}>}).blocks[0];

    expect(native).toEqual({id: 'form-block', type: 'form', props: wire});
    expect(projected).toEqual({id: 'form-block', type: 'form', data: {...wire, props: wire}});
    expect(docToJSON(decodeSnapshot(saved.blockdoc as BlockDocSnapshot))[0]).toEqual(native);
  });

  it('renders the full HTML export frozen with its canonical live-page link', () => {
    setShareLinkOrigin('published.example');
    const snapshot = rawSnapshot();
    expect(JSON.stringify(snapshot).split(schema.submissionKey).length - 1).toBe(6);
    const output = toHtml(snapshot, 'Contact', '', undefined, {id: 'contact'});
    expect(output).not.toContain(schema.submissionKey);
    expect(output).toContain(schema.formId);
    expect(output).toContain('<section class="ob-form" data-ob-form');
    expect(output).toContain('disabled aria-label="Name"');
    expect(output).toContain('href="https://published.example/?page=contact"');
    // Hydration harvests that static URL before replacing the first-paint body.
    expect(output).toContain('formOrigins: formOrigins');
    expectSanitizedFormSnapshot(readIsland<{data: PageSnapshot}>(output)!.data);
    // Export sanitization is artifact-only: the live snapshot still owns all
    // six aliases of its original capability.
    expect(JSON.stringify(snapshot).split(schema.submissionKey).length - 1).toBe(6);
  });

  it('removes every form submission key from forms nested in columns', () => {
    const snapshot = rawSnapshot(true);
    expect(JSON.stringify(snapshot).split(schema.submissionKey).length - 1).toBe(6);

    const output = toHtml(snapshot, 'Contact columns', '', undefined, {id: 'contact-columns'});
    expect(output.split(schema.submissionKey).length - 1).toBe(0);
    expectSanitizedFormSnapshot(readIsland<{data: PageSnapshot}>(output)!.data, true);
  });

  it('normalizes the form into the document Markdown arm', () => {
    const model = buildDocumentModel({title: 'Contact', icon: '', snapshot: rawSnapshot()});
    const form = model.blocks.find((item) => item.type === 'form');
    expect(form?.type).toBe('form');
    expect(form && 'fields' in form ? form.fields.slice(0, 2) : []).toEqual([
      {label: 'Name', kind: 'text', required: true},
      {label: 'About you', kind: 'longtext', required: false},
    ]);
    const output = toMarkdown(model);
    expect(output).not.toContain(schema.submissionKey);
    expect(output).toContain('- Name (text, required)');
  });

  it('uses each page origin in a static site export', () => {
    const projected = projectSnapshotForExport(rawSnapshot());
    const bundle = {
      rootId: 'contact',
      pages: [{
        id: 'contact',
        title: 'Contact',
        icon: '',
        originUrl: 'https://published.example/?page=contact',
        snapshot: projected,
      }],
      space: {
        pages: [{
          id: 'contact',
          name: 'Contact',
          data: rawSnapshot(),
          hostedDatabaseId: null,
          databaseId: null,
          parentId: null,
          properties: {},
          deletedAt: null,
          createdAt: '',
          updatedAt: '',
        }],
        databases: [],
      },
    } as SiteBundle;
    const output = toHtmlSite(bundle);
    expect(output).not.toContain(schema.submissionKey);
    expect(output).toContain(schema.formId);
    expect(output).toContain('data-page="contact"');
    expect(output).toContain('href="https://published.example/?page=contact"');
    const imported = readLibraryIsland(output)!.space.pages[0].data;
    expectSanitizedFormSnapshot(imported);
  });

  it('staticizes PDF forms to field text and removes every submission control', () => {
    const root = document.createElement('main');
    root.innerHTML = blocksToHtml([block], {originPageUrl: 'https://published.example/?page=contact'});
    staticizeForms(root);
    const form = root.querySelector('[data-pdf-form]')!;
    const output = root.outerHTML;
    expect(output).not.toContain(schema.submissionKey);
    expect(output).toContain(schema.formId);
    expect(form.textContent).toContain('Name * (text)');
    expect(form.textContent).toContain('About you (longtext)');
    expect(form.querySelector('input,textarea,select,button,a')).toBeNull();
  });

  it('labels forms humanly in version diffs', () => {
    expect(blockTypeLabel('form')).toBe('Form');
  });
});
