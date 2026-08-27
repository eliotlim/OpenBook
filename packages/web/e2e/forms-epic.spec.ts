import {Buffer} from 'node:buffer';
import {spawn, type ChildProcess} from 'node:child_process';
import {rmSync} from 'node:fs';
import {join} from 'node:path';
import type {Browser, BrowserContext, Page} from '@playwright/test';
import type {FormSchema, StoredDatabase, StoredPage, StoredSuggestion} from '@book.dev/sdk';
import {mintIdentityKeypair, signIdentity} from '../../sdk/src/identity';
import {expect, test, WORKER_DATA_DIR_PREFIX} from './fixtures';

/**
 * FORM-8 closes the forms epic through its real boundaries: owner UI authoring,
 * a claimed server, anonymous live-page uploads/submission, durable database and
 * asset reads, and the remote MCP suggestion policy. A dedicated server keeps
 * the irreversible instance claim isolated from every shared-worker spec.
 */
const FORM_EPIC_BASE_PORT = 4680;
const ISSUER = 'https://account.book.pub';

interface ClaimedInstance {
  url: string;
  ownerHeaders: Record<string, string>;
  stop: () => void;
}

interface RawBlock {
  id?: unknown;
  type?: unknown;
  props?: unknown;
  children?: unknown;
}

interface StoredForm {
  blockId: string;
  schema: FormSchema;
  submissionKey: string;
  databaseId: string;
}

async function startClaimedInstance(workerIndex: number): Promise<ClaimedInstance> {
  const port = FORM_EPIC_BASE_PORT + workerIndex;
  const url = `http://127.0.0.1:${port}`;
  const dataDir = `${WORKER_DATA_DIR_PREFIX}form8-${workerIndex}`;
  rmSync(dataDir, {recursive: true, force: true});
  if (await fetch(`${url}/health`).then((response) => response.ok, () => false)) {
    throw new Error(`something already serves the FORM-8 e2e port ${port}`);
  }

  let child: ChildProcess | null = spawn(
    process.execPath,
    ['--import', 'tsx', 'src/bin.ts', '--data-dir', dataDir, '--port', String(port)],
    {cwd: join(__dirname, '..', '..', 'server'), stdio: ['ignore', 'ignore', 'pipe']},
  );
  let stderrTail = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString('utf8')).slice(-4000);
  });
  const stop = (): void => {
    child?.kill('SIGKILL');
    child = null;
    rmSync(dataDir, {recursive: true, force: true});
  };

  try {
    const deadline = Date.now() + 60_000;
    for (;;) {
      if (child.exitCode !== null) throw new Error(`FORM-8 server exited (${child.exitCode})\n${stderrTail}`);
      if (await fetch(`${url}/health`).then((response) => response.ok, () => false)) break;
      if (Date.now() > deadline) throw new Error(`FORM-8 server on ${port} never became healthy`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    const anonymousHeaders = {'content-type': 'application/json', 'X-OpenBook-Client': '1'};
    const keys = await mintIdentityKeypair('form8-e2e');
    const ownerSubject = `form8-owner-${workerIndex}`;
    const now = Math.floor(Date.now() / 1000);
    const assertion = await signIdentity(
      keys.privateKey,
      {
        iss: ISSUER,
        sub: ownerSubject,
        name: 'FORM-8 Owner',
        iat: now - 30,
        exp: now + 3600,
        jti: `form8-${Math.random()}`,
      },
      keys.publicJwk.kid,
    );
    const ownerHeaders = {...anonymousHeaders, 'X-OpenBook-Identity': assertion};

    const trust = await fetch(`${url}/api/instance`, {
      method: 'PUT',
      headers: anonymousHeaders,
      body: JSON.stringify({trustedIssuers: [{issuer: ISSUER, jwks: {keys: [keys.publicJwk]}}]}),
    });
    if (!trust.ok) throw new Error(`could not trust FORM-8 issuer: ${trust.status}`);
    const claim = await fetch(`${url}/api/instance`, {
      method: 'PUT',
      headers: ownerHeaders,
      body: JSON.stringify({ownerSubject: 'server-binds-the-verified-subject'}),
    });
    if (!claim.ok) throw new Error(`could not claim FORM-8 instance: ${claim.status}`);
    const policy = (await claim.json()) as {
      ownerSubject?: string;
      guestAccess?: string;
      defaultVisibility?: string;
    };
    expect(policy.ownerSubject).toBe(`${ISSUER}#${ownerSubject}`);
    expect(policy.guestAccess).toBe('read');
    expect(policy.defaultVisibility).toBe('members');
    return {url, ownerHeaders, stop};
  } catch (error) {
    stop();
    throw error;
  }
}

async function appContext(
  browser: Browser,
  instance: ClaimedInstance,
  owner: boolean,
): Promise<BrowserContext> {
  const extraHTTPHeaders: Record<string, string> = {'X-OpenBook-Client': '1'};
  if (owner) extraHTTPHeaders['X-OpenBook-Identity'] = instance.ownerHeaders['X-OpenBook-Identity'];
  const context = await browser.newContext({extraHTTPHeaders});
  await context.addInitScript((serverUrl: string) => {
    try {
      localStorage.setItem('openbook.serverUrl', serverUrl);
    } catch {
      // A sandboxed child frame does not need the data-client override.
    }
  }, instance.url);
  return context;
}

async function ownerFetch(
  instance: ClaimedInstance,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(instance.ownerHeaders);
  new Headers(init.headers).forEach((value, key) => headers.set(key, value));
  const response = await fetch(`${instance.url}${path}`, {...init, headers});
  if (!response.ok) {
    throw new Error(`${init.method ?? 'GET'} ${path} failed: ${response.status} ${await response.text()}`);
  }
  return response;
}

async function ownerJson<T>(
  instance: ClaimedInstance,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  return (await ownerFetch(instance, path, init)).json() as Promise<T>;
}

function findRawForm(blocks: RawBlock[]): RawBlock | null {
  for (const block of blocks) {
    if (block.type === 'form') return block;
    if (Array.isArray(block.children)) {
      const nested = findRawForm(block.children as RawBlock[]);
      if (nested) return nested;
    }
  }
  return null;
}

function readStoredForm(page: StoredPage): StoredForm {
  const blocks = (page.data.blockdoc as {blocks?: RawBlock[]} | undefined)?.blocks ?? [];
  const block = findRawForm(blocks);
  if (!block || typeof block.id !== 'string' || typeof block.props !== 'object' || block.props === null) {
    throw new Error('the authored form block has not reached the server yet');
  }
  const props = block.props as Record<string, unknown>;
  const schema = props.schema as FormSchema | undefined;
  if (
    !schema
    || typeof props.submissionKey !== 'string'
    || typeof props.databaseId !== 'string'
    || !Array.isArray(schema.fields)
  ) {
    throw new Error('the authored form is not fully bound yet');
  }
  return {
    blockId: block.id,
    schema,
    submissionKey: props.submissionKey,
    databaseId: props.databaseId,
  };
}

async function storedForm(instance: ClaimedInstance, pageId: string): Promise<StoredForm> {
  return readStoredForm(await ownerJson<StoredPage>(instance, `/api/pages/${pageId}`));
}

async function insertForm(page: Page): Promise<void> {
  const text = page.locator('.obe-text').first();
  await expect(text).toBeVisible();
  await text.evaluate((element) => {
    const editable = element as HTMLElement;
    editable.focus();
    const selection = getSelection();
    const range = document.createRange();
    range.selectNodeContents(editable);
    range.collapse(false);
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
  await page.keyboard.press('Enter');
  await page.keyboard.type('/form');
  const item = page.locator('.obe-slash-item', {
    has: page.locator('.obe-slash-label', {hasText: /^Form$/}),
  });
  await expect(item).toBeVisible();
  await item.click();
  await expect(page.locator('[data-form-builder]')).toBeVisible();
}

async function buildAndBindForm(page: Page): Promise<void> {
  // Exercise the palette's real HTML5 drag path for both fields.
  await page.getByRole('button', {name: 'Add Short text'}).dragTo(page.locator('.obe-form-empty'));
  const textRow = page.locator('[data-form-field-kind="text"]');
  await expect(textRow).toBeVisible();
  const box = await textRow.boundingBox();
  if (!box) throw new Error('the text field row has no drag target');
  await page.getByRole('button', {name: 'Add Files'}).dragTo(textRow, {
    targetPosition: {x: box.width / 2, y: box.height - 2},
  });
  await expect(page.locator('[data-form-field-row]')).toHaveCount(2);

  await page.locator('.obe-kit-form').hover();
  await page.getByRole('button', {name: 'Block settings'}).click();
  await page.getByRole('button', {name: 'Create a new database'}).click();
  await expect(page.getByText('Form responses · 0 rows')).toBeVisible({timeout: 15_000});
  await page.keyboard.press('Escape');

  await textRow.getByRole('button', {name: 'Settings for Short text'}).click();
  let settings = page.locator('[data-form-field-settings]');
  await settings.getByLabel('Label for Short text', {exact: true}).fill('Name');
  await settings.getByLabel('Required').check();
  await settings.getByRole('combobox', {name: 'Database column'}).click();
  await page.getByRole('option', {name: 'Auto-create a compatible column'}).click();
  await expect(settings.getByText(/Will create “Name”/)).toBeVisible();
  await page.keyboard.press('Escape');

  const filesRow = page.locator('[data-form-field-kind="files"]');
  await filesRow.getByRole('button', {name: 'Settings for Files'}).click();
  settings = page.locator('[data-form-field-settings]');
  await settings.getByLabel('Label for Files', {exact: true}).fill('Attachment');
  await settings.getByLabel('Required').check();
  await settings.getByRole('combobox', {name: 'Database column'}).click();
  await page.getByRole('option', {name: 'Auto-create a compatible column'}).click();
  await expect(settings.getByText(/Will create “Attachment”/)).toBeVisible();
  await page.keyboard.press('Escape');

  await page.getByRole('button', {name: 'Save database changes'}).click();
  await expect(page.getByText('Database columns saved.')).toBeVisible();
}

async function publishWithShareDialog(page: Page, instance: ClaimedInstance, pageId: string): Promise<void> {
  await page.getByRole('button', {name: 'Share', exact: true}).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Share this page')).toBeVisible();
  await expect(dialog.getByText('This page accepts public submissions')).toBeVisible();

  await page.locator('#share-scope').click();
  await page.locator('[role="option"][data-value="public"]').click({force: true});
  await expect
    .poll(async () => (await ownerJson<{visibility: string}>(instance, `/api/pages/${pageId}/visibility`)).visibility)
    .toBe('public');
  const formRow = dialog.locator('[data-form-public-submissions]');
  await expect(formRow.getByText('Ready')).toBeVisible();
  await formRow.getByRole('button', {name: 'More info'}).hover();
  await expect(page.getByRole('tooltip')).toContainText('Signed-out visitors who can open this public page can submit.');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
}

let rpcId = 0;
async function mcpToolText(
  instance: ClaimedInstance,
  pat: string,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const response = await fetch(`${instance.url}/api/mcp`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${pat}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: ++rpcId,
      method: 'tools/call',
      params: {name, arguments: args},
    }),
  });
  if (!response.ok) throw new Error(`MCP ${name} failed: ${response.status} ${await response.text()}`);
  const json = (await response.json()) as {
    result?: {content?: Array<{type: string; text?: string}>};
    error?: {message?: string};
  };
  if (json.error) throw new Error(`MCP ${name} error: ${json.error.message ?? 'unknown error'}`);
  return (json.result?.content ?? [])
    .filter((part) => part.type === 'text')
    .map((part) => part.text ?? '')
    .join('\n');
}

test.describe.configure({mode: 'serial'});

test('claimed owner builds and publishes a file form; anonymous submit and MCP suggestion round-trip', {tag: ['@forms', '@p1']}, async ({browser}, workerInfo) => {
  test.setTimeout(180_000);
  const instance = await startClaimedInstance(workerInfo.workerIndex);
  let ownerContext: BrowserContext | null = null;
  let anonymousContext: BrowserContext | null = null;
  try {
    const pageResponse = await ownerJson<{id: string}>(instance, '/api/pages', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Forms epic intake',
        data: {
          editor: 'blocks',
          blockdoc: {blocks: [{id: 'intro', type: 'paragraph', text: [{t: 'Response intake'}]}]},
          editorjs: {blocks: []},
          values: [],
          names: [],
        },
      }),
    });
    const pageId = pageResponse.id;

    ownerContext = await appContext(browser, instance, true);
    const ownerPage = await ownerContext.newPage();
    await ownerPage.goto(`/?page=${pageId}`);
    await expect(ownerPage.locator('.obe-root')).toBeVisible();
    await insertForm(ownerPage);
    await buildAndBindForm(ownerPage);

    await expect.poll(async () => {
      try {
        const form = await storedForm(instance, pageId);
        return form.schema.fields.length === 2
          && form.schema.fields.every((field) => typeof field.columnId === 'string');
      } catch {
        return false;
      }
    }, {timeout: 15_000}).toBe(true);
    const form = await storedForm(instance, pageId);
    expect(form.submissionKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(form.schema.enabled).toBe(true);
    expect(form.schema.databaseId).toBe(form.databaseId);
    expect(form.schema.fields.map((field) => [field.kind, field.label])).toEqual([
      ['text', 'Name'],
      ['files', 'Attachment'],
    ]);
    const database = await ownerJson<StoredDatabase>(instance, `/api/databases/${form.databaseId}`);
    expect(database.pageId).toBe(pageId);

    await publishWithShareDialog(ownerPage, instance, pageId);

    anonymousContext = await appContext(browser, instance, false);
    const filler = await anonymousContext.newPage();
    await filler.goto(`/?page=${pageId}`);
    await expect(filler.locator('.obe-root')).toHaveClass(/obe-readonly/);
    const liveForm = filler.locator(`[data-block-row="${form.blockId}"]`);
    await expect(liveForm.locator('[data-form-mode="live"]')).toBeVisible();
    await liveForm.getByLabel('Name').fill('Ada Lovelace');
    const fileBytes = Buffer.from('FORM-8 anonymous upload\n', 'utf8');
    await liveForm.getByLabel('Attachment').setInputFiles({
      name: 'form8-proof.txt',
      mimeType: 'text/plain',
      buffer: fileBytes,
    });
    await expect(liveForm.getByText('Selected files are ready.')).toBeVisible();
    await liveForm.getByRole('button', {name: 'Submit'}).click();
    await expect(liveForm.locator('[data-form-state="success"]')).toContainText('Thanks');

    const rows = async (): Promise<Array<{properties: Record<string, unknown>}>> =>
      ownerJson(instance, `/api/databases/${form.databaseId}/rows`);
    await expect.poll(async () => (await rows()).length).toBe(1);
    const row = (await rows())[0];
    const nameField = form.schema.fields.find((field) => field.kind === 'text')!;
    const fileField = form.schema.fields.find((field) => field.kind === 'files')!;
    expect(row.properties[nameField.columnId!]).toBe('Ada Lovelace');
    const assetRefs = row.properties[fileField.columnId!] as unknown[];
    expect(assetRefs).toHaveLength(1);
    expect(assetRefs[0]).toEqual(expect.stringMatching(/^\/api\/assets\/[0-9a-f]{64}\?filename=/));

    const asset = await fetch(`${instance.url}${assetRefs[0] as string}`, {
      headers: {'X-OpenBook-Client': '1'},
    });
    expect(asset.status).toBe(200);
    expect(asset.headers.get('content-disposition')).toBe('attachment');
    expect(Buffer.from(await asset.arrayBuffer())).toEqual(fileBytes);

    await ownerJson(instance, `/api/pages/${pageId}/agent-edits`, {
      method: 'PUT',
      body: JSON.stringify({agentEdits: 'suggest'}),
    });
    await ownerJson(instance, '/api/agent-tokens', {
      method: 'PUT',
      body: JSON.stringify({enabled: true}),
    });
    const minted = await ownerJson<{token: string}>(instance, '/api/agent-tokens', {
      method: 'POST',
      body: JSON.stringify({name: 'FORM-8 e2e', scope: 'write'}),
    });

    const listedText = await mcpToolText(instance, minted.token, 'list_forms', {});
    const listed = JSON.parse(listedText) as Array<{pageId: string; formId: string; fieldCount: number}>;
    expect(listed).toContainEqual(expect.objectContaining({pageId, formId: form.schema.formId, fieldCount: 2}));
    expect(listedText).not.toContain(form.submissionKey);
    expect(listedText).not.toContain('submissionKey');

    const schemaText = await mcpToolText(instance, minted.token, 'get_form_schema', {
      pageId,
      formId: form.schema.formId,
    });
    const schemaRead = JSON.parse(schemaText) as {schema: {fields: Array<{id: string; label: string}>}};
    expect(schemaRead.schema.fields.map((field) => field.label)).toEqual(['Name', 'Attachment']);
    expect(schemaText).not.toContain(form.submissionKey);
    expect(schemaText).not.toContain('submissionKey');

    const updateText = await mcpToolText(instance, minted.token, 'update_form_field', {
      pageId,
      formId: form.schema.formId,
      op: {type: 'update', fieldId: nameField.id, patch: {label: 'Applicant name'}},
    });
    expect(updateText).toContain('Suggested for review');
    expect(updateText).not.toContain(form.submissionKey);

    const suggestions = await ownerJson<StoredSuggestion[]>(
      instance,
      `/api/pages/${pageId}/suggestions?status=open`,
    );
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({
      authorName: 'MCP client',
      status: 'open',
      target: {blockId: form.blockId},
      payload: {applyKind: 'set_block_props', blockId: form.blockId},
    });
    const proposed = (suggestions[0].payload.props as {schema: FormSchema}).schema;
    expect(proposed.fields.find((field) => field.id === nameField.id)?.label).toBe('Applicant name');
    expect((await storedForm(instance, pageId)).schema.fields.find((field) => field.id === nameField.id)?.label).toBe('Name');
  } finally {
    await anonymousContext?.close();
    await ownerContext?.close();
    instance.stop();
  }
});
