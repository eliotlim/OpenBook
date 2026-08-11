/**
 * FORM-7 integration coverage over the real HTTP client/server loop:
 * discovery/schema/submissions reads, recursive key redaction, strict op schemas,
 * and both branches of the per-page write policy for both form mutation tools.
 *
 * Run: pnpm --filter @book.dev/mcp test:forms
 */
import assert from 'node:assert/strict';
import {rmSync} from 'node:fs';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {defaultDatabaseSchema, HttpDataClient, type FormField, type FormSchema, type PageSnapshot} from '@book.dev/sdk';
import {startServer} from '@book.dev/server';

const DATA_DIR = '/tmp/openbook-mcp-forms-test';
const KEY_22 = 'abcdefghijklmnopqrstuv';
const KEY_43 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmno12';
const MARKER = 'sys_form_submission';

let passed = 0;
function check(label: string, condition: boolean): void {
  assert.ok(condition, `FAILED: ${label}`);
  passed += 1;
  console.log(`  ✓ ${label}`);
}

const resultText = (result: {content?: unknown}): string =>
  ((result.content as Array<{type: string; text?: string}> | undefined) ?? [])
    .filter((part) => part.type === 'text')
    .map((part) => part.text ?? '')
    .join('\n');

function resultJson<T>(result: {content?: unknown}): T {
  return JSON.parse(resultText(result)) as T;
}

const initialFields = (): FormField[] => [
  {id: 'name', kind: 'text', label: 'Name', required: true},
  {id: 'email', kind: 'email', label: 'Email', required: false},
];

function formSchema(formId: string, submissionKey: string, databaseId?: string): FormSchema {
  return {
    formId,
    submissionKey,
    enabled: true,
    ...(databaseId ? {databaseId} : {}),
    fields: initialFields(),
    confirmation: {message: 'Received'},
  };
}

function formSnapshot(
  formId: string,
  submissionKey: string,
  databaseId?: string,
  opts: {blockId?: string; nested?: boolean; label?: string} = {},
): PageSnapshot {
  const schema = formSchema(formId, submissionKey, databaseId);
  const form = {
    id: opts.blockId ?? `block-${formId}`,
    type: 'form',
    props: {
      formId,
      submissionKey,
      enabled: true,
      ...(databaseId ? {databaseId} : {}),
      ...(opts.label ? {label: opts.label} : {}),
      schema,
    },
  };
  return {
    editor: 'blocks',
    blockdoc: {blocks: opts.nested ? [{id: 'group', type: 'group', children: [form]}] : [form]},
    editorjs: {blocks: []},
    values: [],
    names: [],
  };
}

function findFormProps(data: PageSnapshot, blockId: string): Record<string, unknown> {
  const roots = (data.blockdoc as {blocks?: Array<Record<string, unknown>>} | undefined)?.blocks ?? [];
  const stack = [...roots];
  while (stack.length > 0) {
    const block = stack.shift()!;
    if (block.id === blockId) return block.props as Record<string, unknown>;
    if (Array.isArray(block.children)) stack.unshift(...block.children as Array<Record<string, unknown>>);
  }
  throw new Error(`missing form block ${blockId}`);
}

async function connect(url: string): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', 'src/bin.ts'],
    env: {...process.env, OPENBOOK_URL: url},
    stderr: 'pipe',
  });
  const client = new Client({name: 'openbook-mcp-forms-test', version: '0.0.0'});
  await client.connect(transport);
  return client;
}

async function main(): Promise<void> {
  rmSync(DATA_DIR, {recursive: true, force: true});
  const server = await startServer({dataDir: DATA_DIR, host: '127.0.0.1', port: 4411});
  const seed = new HttpDataClient(server.url);

  // Suggest-mode host: create the host/database first, then bind a nested form.
  const suggestHost = await seed.savePage({name: 'Contact intake', data: formSnapshot('contact', KEY_22, undefined, {nested: true, label: 'Contact us'})});
  const suggestDb = await seed.createDatabase({pageId: suggestHost.id, name: 'Contacts', schema: defaultDatabaseSchema()});
  await seed.savePage({
    id: suggestHost.id,
    name: suggestHost.name,
    data: formSnapshot('contact', KEY_22, suggestDb.id, {nested: true, label: 'Contact us'}),
  });

  const submissionA = await seed.createRow(suggestDb.id, {
    name: 'Ada',
    properties: {name: 'Ada', [MARKER]: {formId: 'contact', submittedAt: '2026-08-10T10:00:00.000Z'}},
  });
  const submissionB = await seed.createRow(suggestDb.id, {
    name: 'Grace',
    properties: {name: 'Grace', [MARKER]: {formId: 'contact', submittedAt: '2026-08-11T10:00:00.000Z'}},
  });
  await seed.createRow(suggestDb.id, {name: 'Other form', properties: {[MARKER]: {formId: 'other', submittedAt: '2026-08-12T10:00:00.000Z'}}});
  const manualRow = await seed.createRow(suggestDb.id, {name: 'Manual row', properties: {name: 'Manual'}});

  // Direct-mode host deliberately uses the 43-character generation to guard the
  // no-format-validation contract alongside the 22-character form above.
  const directHost = await seed.savePage({name: 'Direct survey', data: formSnapshot('survey', KEY_43, undefined, {blockId: 'survey-block'})});
  const directDb = await seed.createDatabase({pageId: directHost.id, name: 'Survey results', schema: defaultDatabaseSchema()});
  await seed.savePage({id: directHost.id, name: directHost.name, data: formSnapshot('survey', KEY_43, directDb.id, {blockId: 'survey-block'})});
  await seed.setPageAgentEdits(directHost.id, 'direct');

  const crossPageHost = await seed.savePage({
    name: 'Cross-page binding',
    data: formSnapshot('cross-page', KEY_22, suggestDb.id),
  });
  const schemaOnlySnapshot = formSnapshot('schema-only', KEY_22, suggestDb.id);
  delete findFormProps(schemaOnlySnapshot, 'block-schema-only').databaseId;
  const schemaOnlyHost = await seed.savePage({name: 'Schema-only binding', data: schemaOnlySnapshot});

  const mcp = await connect(server.url);

  console.log('\nFORM-7 read tools + capability redaction');
  const listed = await mcp.callTool({name: 'list_forms', arguments: {}});
  const forms = resultJson<Array<{pageId: string; pageTitle: string; formId: string; label?: string; enabled: boolean; databaseId?: string; fieldCount: number}>>(listed);
  const contact = forms.find((form) => form.formId === 'contact');
  check('list_forms recursively finds the nested form', contact?.pageId === suggestHost.id && contact.pageTitle === 'Contact intake');
  check('list_forms returns summary fields and the database binding', contact?.label === 'Contact us' && contact.enabled && contact.databaseId === suggestDb.id && contact.fieldCount === 2);
  check('list_forms never returns either submission key', !resultText(listed).includes(KEY_22) && !resultText(listed).includes(KEY_43) && !resultText(listed).includes('submissionKey'));

  const got = await mcp.callTool({name: 'get_form_schema', arguments: {pageId: suggestHost.id, formId: 'contact'}});
  const gotJson = resultJson<{schema: {fields: FormField[]; enabled: boolean; databaseId?: string}; enabled: boolean; databaseId?: string}>(got);
  check('get_form_schema returns the fields plus enabled/databaseId', gotJson.schema.fields.length === 2 && gotJson.enabled && gotJson.databaseId === suggestDb.id);
  check('get_form_schema recursively redacts the capability', !resultText(got).includes(KEY_22) && !resultText(got).includes('submissionKey'));

  const tree = await mcp.callTool({name: 'inspect_page_structure', arguments: {pageId: suggestHost.id}});
  check('inspect_page_structure still shows the nested form', resultText(tree).includes('form') && resultText(tree).includes('contact'));
  check('inspect_page_structure redacts both key copies', !resultText(tree).includes(KEY_22) && !resultText(tree).includes('submissionKey'));

  console.log('\nFORM-7 list_form_submissions filtering + cursor');
  const firstPage = resultJson<{rows: Array<{id: string; formId: string; submittedAt?: string}>; nextCursor?: string}>(
    await mcp.callTool({name: 'list_form_submissions', arguments: {pageId: suggestHost.id, formId: 'contact', limit: 1}}),
  );
  check('list_form_submissions returns one marked row and a cursor', firstPage.rows.length === 1 && firstPage.rows[0].formId === 'contact' && Boolean(firstPage.rows[0].submittedAt) && Boolean(firstPage.nextCursor));
  const secondPage = resultJson<{rows: Array<{id: string; formId: string}>; nextCursor?: string}>(
    await mcp.callTool({name: 'list_form_submissions', arguments: {pageId: suggestHost.id, formId: 'contact', limit: 1, cursor: firstPage.nextCursor}}),
  );
  const submissionIds = new Set([...firstPage.rows, ...secondPage.rows].map((row) => row.id));
  check('pagination returns exactly the two rows marked for this form', submissionIds.size === 2 && submissionIds.has(submissionA.id) && submissionIds.has(submissionB.id));
  check('the last submissions page omits nextCursor', secondPage.nextCursor === undefined);
  const badCursor = await mcp.callTool({name: 'list_form_submissions', arguments: {pageId: suggestHost.id, formId: 'contact', cursor: manualRow.id}});
  check('a cursor from outside the filtered form is rejected', badCursor.isError === true);
  const crossPage = await mcp.callTool({name: 'list_form_submissions', arguments: {pageId: crossPageHost.id, formId: 'cross-page'}});
  check('a database hosted by another page is rejected', crossPage.isError === true && resultText(crossPage).includes('hosted by that page'));
  const schemaOnly = await mcp.callTool({name: 'list_form_submissions', arguments: {pageId: schemaOnlyHost.id, formId: 'schema-only'}});
  check('a schema-only database binding is not authoritative', schemaOnly.isError === true && resultText(schemaOnly).includes('not bound'));

  console.log('\nFORM-7 strict field-op schemas + suggest mode');
  const badKind = await mcp.callTool({
    name: 'update_form_field',
    arguments: {pageId: suggestHost.id, formId: 'contact', op: {type: 'add', field: {id: 'bad', kind: 'mystery', label: 'Bad', required: false}}},
  });
  check('zod rejects an unknown field kind before the handler', badKind.isError === true);
  const badPatch = await mcp.callTool({
    name: 'update_form_field',
    arguments: {pageId: suggestHost.id, formId: 'contact', op: {type: 'update', fieldId: 'name', patch: {}}},
  });
  check('zod rejects an empty update patch', badPatch.isError === true);
  const badOp = await mcp.callTool({
    name: 'update_form_field',
    arguments: {pageId: suggestHost.id, formId: 'contact', op: {type: 'replace', fieldId: 'name'}},
  });
  check('zod rejects an unknown operation discriminator', badOp.isError === true);
  const unsafeRedirect = await mcp.callTool({
    name: 'set_form_settings',
    arguments: {pageId: suggestHost.id, formId: 'contact', patch: {confirmation: {redirectUrl: 'javascript:alert(1)'}}},
  });
  check('zod rejects a non-http(s) confirmation redirect', unsafeRedirect.isError === true);

  const beforeSuggest = findFormProps((await seed.getPage(suggestHost.id))!.data, 'block-contact');
  const suggestedField = await mcp.callTool({
    name: 'update_form_field',
    arguments: {pageId: suggestHost.id, formId: 'contact', op: {type: 'add', index: 1, field: {id: 'company', kind: 'text', label: 'Company', required: false}}},
  });
  check('update_form_field queues a suggestion on a suggest page', resultText(suggestedField).includes('Suggested for review'));
  const afterSuggest = findFormProps((await seed.getPage(suggestHost.id))!.data, 'block-contact');
  check('suggest-mode update_form_field leaves the block unchanged', JSON.stringify(afterSuggest) === JSON.stringify(beforeSuggest));
  const fieldSuggestion = (await seed.listSuggestions(suggestHost.id)).find((suggestion) =>
    (suggestion.payload as {applyKind?: string}).applyKind === 'set_block_props');
  check('the field suggestion targets the form block through set_block_props', fieldSuggestion?.target.blockId === 'block-contact');
  check('the suggestion preserves the submission capability without exposing it in the tool result',
    JSON.stringify(fieldSuggestion?.payload).includes(KEY_22) && !resultText(suggestedField).includes(KEY_22));

  const suggestedSettings = await mcp.callTool({
    name: 'set_form_settings',
    arguments: {pageId: suggestHost.id, formId: 'contact', patch: {submitLabel: 'Send contact'}},
  });
  check('set_form_settings also queues through the suggest policy', resultText(suggestedSettings).includes('Suggested for review'));
  const unchangedSettings = findFormProps((await seed.getPage(suggestHost.id))!.data, 'block-contact').schema as FormSchema;
  check('suggest-mode set_form_settings leaves settings unchanged', unchangedSettings.submitLabel === undefined);

  console.log('\nFORM-7 direct field operations + settings');
  const add = await mcp.callTool({
    name: 'update_form_field',
    arguments: {pageId: directHost.id, formId: 'survey', op: {type: 'add', index: 1, field: {id: 'score', kind: 'rating', label: 'Score', required: false}}},
  });
  check('add applies directly on a direct page with a 43-character key', resultText(add).includes('applied directly'));
  const update = await mcp.callTool({
    name: 'update_form_field',
    arguments: {pageId: directHost.id, formId: 'survey', op: {type: 'update', fieldId: 'email', patch: {required: true, placeholder: 'you@example.test'}}},
  });
  check('update applies directly', resultText(update).includes('applied directly'));
  const reorder = await mcp.callTool({
    name: 'update_form_field',
    arguments: {pageId: directHost.id, formId: 'survey', op: {type: 'reorder', fieldId: 'email', toIndex: 0}},
  });
  check('reorder applies directly', resultText(reorder).includes('applied directly'));
  const remove = await mcp.callTool({
    name: 'update_form_field',
    arguments: {pageId: directHost.id, formId: 'survey', op: {type: 'remove', fieldId: 'name'}},
  });
  check('remove applies directly', resultText(remove).includes('applied directly'));
  let directProps = findFormProps((await seed.getPage(directHost.id))!.data, 'survey-block');
  let directSchema = directProps.schema as FormSchema;
  check('all direct operations landed in final order with the patch', directSchema.fields.map((field) => field.id).join(',') === 'email,score' && directSchema.fields[0].required && directSchema.fields[0].placeholder === 'you@example.test');
  check('direct field edits preserve both 43-character key copies', directProps.submissionKey === KEY_43 && directSchema.submissionKey === KEY_43);

  const settings = await mcp.callTool({
    name: 'set_form_settings',
    arguments: {pageId: directHost.id, formId: 'survey', patch: {
      enabled: false,
      submitLabel: 'Finish',
      confirmation: {redirectUrl: 'https://example.test/thanks'},
      databaseId: directDb.id,
      maxSubmissions: 0,
    }},
  });
  check('set_form_settings applies directly', resultText(settings).includes('applied directly'));
  directProps = findFormProps((await seed.getPage(directHost.id))!.data, 'survey-block');
  directSchema = directProps.schema as FormSchema;
  check('settings synchronize outer gate props and nested schema', directProps.enabled === false && directProps.databaseId === directDb.id && directSchema.enabled === false && directSchema.databaseId === directDb.id);
  check('settings carry label/confirmation and accept maxSubmissions=0', directSchema.submitLabel === 'Finish' && 'redirectUrl' in directSchema.confirmation && directSchema.maxSubmissions === 0);
  check('set_form_settings cannot rotate or corrupt the key', directProps.submissionKey === KEY_43 && directSchema.submissionKey === KEY_43);

  const clear = await mcp.callTool({
    name: 'set_form_settings',
    arguments: {pageId: directHost.id, formId: 'survey', patch: {submitLabel: null, databaseId: null, maxSubmissions: null}},
  });
  check('nullable settings clear optional values directly', resultText(clear).includes('applied directly'));
  directProps = findFormProps((await seed.getPage(directHost.id))!.data, 'survey-block');
  directSchema = directProps.schema as FormSchema;
  check('cleared settings are removed rather than stored as null', !('databaseId' in directProps) && !('databaseId' in directSchema) && !('submitLabel' in directSchema) && !('maxSubmissions' in directSchema));

  await mcp.close();
  await server.close();
  rmSync(DATA_DIR, {recursive: true, force: true});
  console.log(`\n✅ ALL ${passed} CHECKS PASSED — FORM-7 tools, policy handling, pagination, validation, and key redaction verified.`);
}

main().catch((error: unknown) => {
  console.error('\n❌ MCP forms test failed:', error);
  process.exit(1);
});
