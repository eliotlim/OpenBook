import {spawn, type ChildProcess} from 'node:child_process';
import {rmSync} from 'node:fs';
import {join} from 'node:path';
import type {BrowserContext} from '@playwright/test';
import {mintIdentityKeypair, signIdentity} from '../../sdk/src/identity';
import {expect, test, WORKER_DATA_DIR_PREFIX} from './fixtures';

/** Dedicated claimed/published server: claiming a shared worker server would permanently make later specs read-only. */
const FORM_BASE_PORT = 4620;
const ISSUER = 'https://account.book.pub';

interface PublishedInstance {
  url: string;
  ownerHeaders: Record<string, string>;
  stop: () => void;
}

async function startPublishedInstance(workerIndex: number): Promise<PublishedInstance> {
  const port = FORM_BASE_PORT + workerIndex;
  const url = `http://127.0.0.1:${port}`;
  const dataDir = `${WORKER_DATA_DIR_PREFIX}form5-${workerIndex}`;
  rmSync(dataDir, {recursive: true, force: true});
  if (await fetch(`${url}/health`).then((response) => response.ok, () => false)) {
    throw new Error(`something already serves the FORM-5 e2e port ${port}`);
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
      if (child.exitCode !== null) throw new Error(`FORM-5 server exited (${child.exitCode})\n${stderrTail}`);
      if (await fetch(`${url}/health`).then((response) => response.ok, () => false)) break;
      if (Date.now() > deadline) throw new Error(`FORM-5 server on ${port} never became healthy`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    const anonymousHeaders = {'content-type': 'application/json', 'X-OpenBook-Client': '1'};
    const keys = await mintIdentityKeypair('form5-e2e');
    const now = Math.floor(Date.now() / 1000);
    const assertion = await signIdentity(
      keys.privateKey,
      {
        iss: ISSUER,
        sub: `form5-owner-${workerIndex}`,
        name: 'FORM-5 Owner',
        iat: now - 30,
        exp: now + 3600,
        jti: `form5-${Math.random()}`,
      },
      keys.publicJwk.kid,
    );
    const ownerHeaders = {...anonymousHeaders, 'X-OpenBook-Identity': assertion};

    const trust = await fetch(`${url}/api/instance`, {
      method: 'PUT',
      headers: anonymousHeaders,
      body: JSON.stringify({trustedIssuers: [{issuer: ISSUER, jwks: {keys: [keys.publicJwk]}}]}),
    });
    if (!trust.ok) throw new Error(`could not trust FORM-5 issuer: ${trust.status}`);
    const claim = await fetch(`${url}/api/instance`, {
      method: 'PUT',
      headers: ownerHeaders,
      body: JSON.stringify({ownerSubject: 'server-binds-the-verified-subject'}),
    });
    if (!claim.ok) throw new Error(`could not claim FORM-5 instance: ${claim.status}`);
    const policy = (await claim.json()) as {guestAccess?: string; defaultVisibility?: string};
    expect(policy.guestAccess).toBe('read');
    expect(policy.defaultVisibility).toBe('members');
    return {url, ownerHeaders, stop};
  } catch (error) {
    stop();
    throw error;
  }
}

async function anonymousContext(
  browser: import('@playwright/test').Browser,
  instance: PublishedInstance,
): Promise<BrowserContext> {
  const context = await browser.newContext({extraHTTPHeaders: {'X-OpenBook-Client': '1'}});
  await context.addInitScript((serverUrl: string) => {
    try {
      localStorage.setItem('openbook.serverUrl', serverUrl);
    } catch {
      // Sandboxed frames do not need the data-client override.
    }
  }, instance.url);
  return context;
}

function formProps(
  formId: string,
  submissionKey: string,
  databaseId: string,
  honeypot: boolean,
): Record<string, unknown> {
  const fields = [
    {id: 'name', kind: 'text', label: 'Name', required: true, columnId: 'p_name'},
    {id: 'email', kind: 'email', label: 'Email', required: true, columnId: 'p_email'},
    ...(honeypot ? [{id: 'website', kind: 'text', label: 'Website', required: false, honeypot: true}] : []),
  ];
  const schema = {
    formId,
    submissionKey,
    enabled: true,
    databaseId,
    fields,
    confirmation: {message: honeypot ? 'Bot-shaped success' : 'Thanks, Ada!'},
    maxSubmissions: 100,
  };
  return {formId, submissionKey, enabled: true, databaseId, schema};
}

async function seedPublishedFormPage(instance: PublishedInstance): Promise<{pageId: string; databaseId: string}> {
  const request = async (path: string, init: RequestInit): Promise<Response> => {
    const response = await fetch(`${instance.url}${path}`, {...init, headers: {...instance.ownerHeaders, ...init.headers}});
    if (!response.ok) throw new Error(`${init.method} ${path} failed: ${response.status} ${await response.text()}`);
    return response;
  };
  const empty = {editorjs: {blocks: []}, values: [], names: []};
  const page = await request('/api/pages', {
    method: 'POST',
    body: JSON.stringify({name: 'Published contact forms', data: empty}),
  });
  const pageId = ((await page.json()) as {id: string}).id;
  const database = await request('/api/databases', {
    method: 'POST',
    body: JSON.stringify({
      pageId,
      name: 'Form responses',
      schema: {
        properties: [
          {id: 'p_name', name: 'Name', type: 'text'},
          {id: 'p_email', name: 'Email', type: 'email'},
        ],
        views: [],
      },
    }),
  });
  const databaseId = ((await database.json()) as {id: string}).id;
  const human = formProps('human-contact', 'abcdefghijklmnopqrstuv', databaseId, false);
  const trap = formProps('bot-contact', 'A'.repeat(43), databaseId, true);
  const blocks = [
    {id: 'human-form', type: 'form', props: human},
    {id: 'bot-form', type: 'form', props: trap},
  ];
  await request(`/api/pages/${pageId}`, {
    method: 'PUT',
    body: JSON.stringify({
      name: 'Published contact forms',
      data: {editor: 'blocks', blockdoc: {v: 1, update: '', blocks}, editorjs: {blocks: []}, values: [], names: []},
    }),
  });
  await request(`/api/pages/${pageId}/visibility`, {
    method: 'PUT',
    body: JSON.stringify({visibility: 'public'}),
  });
  return {pageId, databaseId};
}

test.describe.configure({mode: 'serial'});

test('anonymous published forms validate, submit idempotently, and silently trap bots', {tag: ['@forms', '@p1']}, async ({browser}, workerInfo) => {
  test.setTimeout(120_000);
  const instance = await startPublishedInstance(workerInfo.workerIndex);
  try {
    const {pageId, databaseId} = await seedPublishedFormPage(instance);
    const context = await anonymousContext(browser, instance);
    const page = await context.newPage();
    await page.goto(`/?page=${pageId}`);
    await expect(page.locator('.obe-root')).toHaveClass(/obe-readonly/);

    const human = page.locator('[data-block-row="human-form"]');
    await expect(human.locator('[data-form-mode="live"]')).toBeVisible();
    await human.getByLabel('Name').fill('Ada Lovelace');
    await human.getByLabel('Email').fill('invalid');
    await human.getByRole('button', {name: 'Submit'}).click();
    await expect(human.getByText('Enter a valid email address.')).toBeVisible();

    await human.getByLabel('Email').fill('ada@example.com');
    await human.getByRole('button', {name: 'Submit'}).dblclick();
    await expect(human.locator('[data-form-state="success"]')).toHaveText('Thanks, Ada!');

    const rows = async (): Promise<Array<{properties: Record<string, unknown>}>> => {
      const response = await fetch(`${instance.url}/api/databases/${databaseId}/rows`, {headers: instance.ownerHeaders});
      if (!response.ok) throw new Error(`could not read submitted rows: ${response.status}`);
      return response.json() as Promise<Array<{properties: Record<string, unknown>}>>;
    };
    await expect.poll(async () => (await rows()).length).toBe(1);
    expect((await rows())[0].properties).toMatchObject({p_name: 'Ada Lovelace', p_email: 'ada@example.com'});

    const trap = page.locator('[data-block-row="bot-form"]');
    await trap.locator('.obe-sr-only input').evaluate((input) => {
      const element = input as HTMLInputElement;
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      set?.call(element, 'https://spam.example');
      element.dispatchEvent(new Event('input', {bubbles: true}));
    });
    await trap.getByRole('button', {name: 'Submit'}).click();
    await expect(trap.locator('[data-form-state="success"]')).toHaveText('Bot-shaped success');
    await expect.poll(async () => (await rows()).length).toBe(1);
    await context.close();
  } finally {
    instance.stop();
  }
});
