import {spawn, type ChildProcess} from 'node:child_process';
import {rmSync} from 'node:fs';
import {join} from 'node:path';
import type {Browser, BrowserContext, Page} from '@playwright/test';
import type {DatabaseSchema, StoredDatabase} from '@book.dev/sdk';
import {mintIdentityKeypair, signIdentity} from '../../sdk/src/identity';
import {chooseValue, expect, test, WORKER_DATA_DIR_PREFIX} from './fixtures';

const FORM_PUBLISH_BASE_PORT = 4740;
const ISSUER = 'https://account.book.pub';
const FORM_VIEW_ID = 'f5-public-form';
const OTHER_VIEW_ID = 'f5-private-table';
const HOST_TITLE = 'F-5 private host title';
const HOST_CONTENT = 'F-5 private host content';

interface ClaimedInstance {
  url: string;
  ownerHeaders: Record<string, string>;
  anonymousHeaders: Record<string, string>;
  stop: () => void;
}

async function startClaimedInstance(workerIndex: number): Promise<ClaimedInstance> {
  const port = FORM_PUBLISH_BASE_PORT + workerIndex;
  const url = `http://127.0.0.1:${port}`;
  const dataDir = `${WORKER_DATA_DIR_PREFIX}f5-${workerIndex}`;
  rmSync(dataDir, {recursive: true, force: true});
  if (await fetch(`${url}/health`).then((response) => response.ok, () => false)) {
    throw new Error(`something already serves the F-5 e2e port ${port}`);
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
      if (child.exitCode !== null) throw new Error(`F-5 server exited (${child.exitCode})\n${stderrTail}`);
      if (await fetch(`${url}/health`).then((response) => response.ok, () => false)) break;
      if (Date.now() > deadline) throw new Error(`F-5 server on ${port} never became healthy`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    const anonymousHeaders = {'content-type': 'application/json', 'X-OpenBook-Client': '1'};
    const keys = await mintIdentityKeypair('f5-e2e');
    const ownerSubject = `f5-owner-${workerIndex}`;
    const now = Math.floor(Date.now() / 1000);
    const assertion = await signIdentity(
      keys.privateKey,
      {
        iss: ISSUER,
        sub: ownerSubject,
        name: 'F-5 Owner',
        iat: now - 30,
        exp: now + 3600,
        jti: `f5-${Math.random()}`,
      },
      keys.publicJwk.kid,
    );
    const ownerHeaders = {...anonymousHeaders, 'X-OpenBook-Identity': assertion};
    const trust = await fetch(`${url}/api/instance`, {
      method: 'PUT',
      headers: anonymousHeaders,
      body: JSON.stringify({trustedIssuers: [{issuer: ISSUER, jwks: {keys: [keys.publicJwk]}}]}),
    });
    if (!trust.ok) throw new Error(`could not trust F-5 issuer: ${trust.status}`);
    const claim = await fetch(`${url}/api/instance`, {
      method: 'PUT',
      headers: ownerHeaders,
      body: JSON.stringify({ownerSubject: 'server-binds-the-verified-subject'}),
    });
    if (!claim.ok) throw new Error(`could not claim F-5 instance: ${claim.status}`);
    const policy = (await claim.json()) as {ownerSubject?: string; guestAccess?: string; defaultVisibility?: string};
    expect(policy.ownerSubject).toBe(`${ISSUER}#${ownerSubject}`);
    expect(policy.guestAccess).toBe('read');
    expect(policy.defaultVisibility).toBe('members');
    return {url, ownerHeaders, anonymousHeaders, stop};
  } catch (error) {
    stop();
    throw error;
  }
}

async function appContext(
  browser: Browser,
  instance: ClaimedInstance,
  headers: Record<string, string>,
): Promise<BrowserContext> {
  const context = await browser.newContext({extraHTTPHeaders: headers});
  await context.addInitScript((serverUrl: string) => {
    try {
      localStorage.setItem('openbook.serverUrl', serverUrl);
    } catch {
      // Sandboxed child frames do not use the workspace connection.
    }
  }, instance.url);
  return context;
}

async function ownerFetch(instance: ClaimedInstance, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(instance.ownerHeaders);
  new Headers(init.headers).forEach((value, key) => headers.set(key, value));
  const response = await fetch(`${instance.url}${path}`, {...init, headers});
  if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${path} failed: ${response.status} ${await response.text()}`);
  return response;
}

async function ownerJson<T>(instance: ClaimedInstance, path: string, init: RequestInit = {}): Promise<T> {
  return (await ownerFetch(instance, path, init)).json() as Promise<T>;
}

async function patchFormConfig(
  instance: ClaimedInstance,
  databaseId: string,
  patch: {
    acceptingResponses: boolean;
    closedMessage?: string;
    maxResponses?: number;
    confirmation?: {type: 'message'; message: string} | {type: 'redirect'; redirectUrl: string};
  },
): Promise<void> {
  const database = await ownerJson<StoredDatabase>(instance, `/api/databases/${databaseId}`);
  const schema: DatabaseSchema = {
    ...database.schema,
    views: database.schema.views.map((view) => view.id === FORM_VIEW_ID
      ? {...view, formConfig: {...(view.formConfig ?? {}), ...patch}}
      : view),
  };
  await ownerFetch(instance, `/api/databases/${databaseId}`, {
    method: 'PATCH',
    body: JSON.stringify({schema}),
  });
}

async function publishByApi(instance: ClaimedInstance, databaseId: string): Promise<string> {
  const result = await ownerJson<{url: string}>(
    instance,
    `/api/databases/${databaseId}/views/${FORM_VIEW_ID}/capability`,
    {method: 'POST'},
  );
  return new URL(result.url, 'http://localhost:3000').toString();
}

async function fillRequiredEmail(page: Page, value: string): Promise<void> {
  await page.getByRole('textbox', {name: 'Contact email'}).fill(value);
  await page.getByRole('button', {name: 'Send response'}).click();
}

test.describe.configure({mode: 'serial'});

test(
  'F-5 publishes an unpublished form, isolates anonymous fill, submits, revokes, closes, and exhausts',
  {tag: ['@database', '@manager-verified']},
  async ({browser}, workerInfo) => {
    test.setTimeout(180_000);
    const instance = await startClaimedInstance(workerInfo.workerIndex);
    let ownerContext: BrowserContext | null = null;
    let anonymousContext: BrowserContext | null = null;
    try {
      const host = await ownerJson<{id: string}>(instance, '/api/pages', {
        method: 'POST',
        body: JSON.stringify({
          name: HOST_TITLE,
          data: {
            editorjs: {blocks: [{type: 'paragraph', data: {text: HOST_CONTENT}}]},
            values: [],
            names: [],
          },
        }),
      });
      await ownerFetch(instance, `/api/pages/${host.id}/visibility`, {
        method: 'PUT',
        body: JSON.stringify({visibility: 'members', listed: false}),
      });
      const database = await ownerJson<StoredDatabase>(instance, '/api/databases', {
        method: 'POST',
        body: JSON.stringify({
          pageId: host.id,
          name: 'F-5 private responses',
          schema: {
            properties: [
              {id: 'email', name: 'Contact email', type: 'email'},
              {id: 'plan', name: 'Plan', type: 'select', options: [{id: 'free', label: 'Free', color: 'blue'}]},
              {id: 'topics', name: 'Topics', type: 'multi_select', options: [{id: 'forms', label: 'Forms', color: 'blue'}]},
              {id: 'stage', name: 'Stage', type: 'status', options: [{id: 'new', label: 'New', color: 'gray'}]},
              {id: 'consent', name: 'Consent', type: 'checkbox'},
            ],
            views: [
              {
                id: FORM_VIEW_ID,
                name: 'Public intake',
                type: 'form',
                filters: [],
                sorts: [],
                visiblePropertyIds: ['email', 'plan', 'topics', 'stage', 'consent'],
                formFields: {email: {required: true}, plan: {}, topics: {}, stage: {}, consent: {}},
                formConfig: {
                  title: 'Apply here',
                  description: 'Public descriptor copy',
                  submitLabel: 'Send response',
                  confirmation: {type: 'message', message: 'Application received.'},
                  acceptingResponses: true,
                },
              },
              {id: OTHER_VIEW_ID, name: 'Private table view', type: 'table', filters: [], sorts: []},
            ],
          } satisfies DatabaseSchema,
        }),
      });

      ownerContext = await appContext(browser, instance, instance.ownerHeaders);
      const ownerPage = await ownerContext.newPage();
      await ownerPage.goto(`/?page=${host.id}&view=${FORM_VIEW_ID}`);
      await expect(ownerPage.locator('[data-database-form-builder]')).toBeVisible();
      await ownerPage.getByRole('button', {name: 'Publish form'}).click();
      const review = ownerPage.locator('[data-database-form-publish-review]');
      await expect(review).toBeVisible();
      for (const [id, label] of [['email', 'Contact email'], ['plan', 'Plan'], ['topics', 'Topics'], ['stage', 'Stage'], ['consent', 'Consent']]) {
        await expect(review.locator(`[data-publish-review-field="${id}"]`)).toContainText(label);
      }
      await expect(review.getByText('Public choice')).toHaveCount(4);
      const publishConfirm = review.getByRole('button', {name: 'Publish form'});
      await expect(publishConfirm).toBeDisabled();
      await review.getByRole('checkbox', {name: /Responses will be untitled/}).check();
      await publishConfirm.click();
      const fillLink = ownerPage.locator('[data-database-form-fill-url] a').first();
      await expect(fillLink).toBeVisible();
      const fillUrl = await fillLink.getAttribute('href');
      if (!fillUrl) throw new Error('publish did not return a public fill URL');
      expect(new URL(fillUrl).hash).toMatch(/^#capability=[A-Za-z0-9_-]{43}$/);

      anonymousContext = await appContext(browser, instance, instance.anonymousHeaders);
      const visitor = await anonymousContext.newPage();
      await visitor.goto(fillUrl);
      await expect(visitor.locator('[data-public-database-form-surface]')).toBeVisible();
      await expect(visitor.locator('[data-public-form]')).toBeVisible();
      await expect(visitor.getByRole('heading', {name: 'Apply here'})).toBeVisible();
      await expect(visitor.getByText(HOST_TITLE)).toHaveCount(0);
      await expect(visitor.getByText(HOST_CONTENT)).toHaveCount(0);
      await expect(visitor.getByText('Private table view')).toHaveCount(0);
      await expect(visitor.locator('nav')).toHaveCount(0);
      await expect(visitor.getByPlaceholder(/Search pages/)).toHaveCount(0);
      await expect(visitor.getByRole('button', {name: 'Add view'})).toHaveCount(0);

      await visitor.getByRole('textbox', {name: 'Contact email'}).fill('reader@example.com');
      await visitor.getByRole('combobox', {name: 'Plan'}).selectOption('free');
      await visitor.getByRole('combobox', {name: 'Stage'}).selectOption('new');
      await visitor.getByRole('checkbox', {name: 'Consent'}).check();
      await visitor.getByRole('button', {name: 'Send response'}).click();
      await expect(visitor.locator('[data-public-form-confirmation]')).toContainText('Application received.');

      const rows = await ownerJson<Array<{name: string; properties: Record<string, unknown>}>>(
        instance,
        `/api/databases/${database.id}/rows`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        name: '',
        properties: {email: 'reader@example.com', plan: 'free', stage: 'new', consent: true},
      });
      expect(rows[0].properties.sys_form_submission).toEqual({
        submittedViaViewId: FORM_VIEW_ID,
        submittedAt: expect.any(String),
      });

      const anonymousApi = anonymousContext.request;
      const pages = await anonymousApi.get(`${instance.url}/api/pages`);
      expect(pages.status()).toBe(200);
      expect(((await pages.json()) as Array<{id: string}>).map((page) => page.id)).not.toContain(host.id);
      expect((await anonymousApi.get(`${instance.url}/api/pages/${host.id}`)).status()).toBeGreaterThanOrEqual(400);
      expect((await anonymousApi.get(`${instance.url}/api/databases/${database.id}`)).status()).toBeGreaterThanOrEqual(400);
      expect((await anonymousApi.get(`${instance.url}/api/databases/${database.id}/rows`)).status()).toBeGreaterThanOrEqual(400);
      expect((await anonymousApi.post(`${instance.url}/api/ai/search`, {data: {query: HOST_TITLE}})).status()).toBeGreaterThanOrEqual(400);

      await ownerPage.getByRole('button', {name: 'Revoke'}).click();
      const revokeDialog = ownerPage.locator('[data-database-form-revoke-confirm]');
      await expect(revokeDialog).toContainText('Every distributed copy');
      await revokeDialog.getByRole('button', {name: 'Revoke public form'}).click();
      await expect(ownerPage.getByText('Not published')).toBeVisible();
      await visitor.goto(fillUrl);
      await expect(visitor.locator('[data-public-form-not-found]')).toContainText('Form not found');

      await patchFormConfig(instance, database.id, {
        acceptingResponses: true,
        confirmation: {type: 'redirect', redirectUrl: 'https://example.com/thanks'},
      });
      const redirectUrl = await publishByApi(instance, database.id);
      await visitor.goto(redirectUrl);
      await fillRequiredEmail(visitor, 'redirect@example.com');
      const continueLink = visitor.getByRole('link', {name: 'Continue'});
      await expect(continueLink).toHaveAttribute('href', 'https://example.com/thanks');
      expect(new URL(visitor.url()).hash).toMatch(/^#capability=/);

      await patchFormConfig(instance, database.id, {
        acceptingResponses: false,
        closedMessage: 'Responses reopen Monday.',
      });
      const closedUrl = await publishByApi(instance, database.id);
      await visitor.goto(closedUrl);
      await expect(visitor.locator('[data-public-form-closed]')).toContainText('Responses reopen Monday.');

      await patchFormConfig(instance, database.id, {acceptingResponses: true, maxResponses: 2});
      const exhaustedUrl = await publishByApi(instance, database.id);
      await visitor.goto(exhaustedUrl);
      await fillRequiredEmail(visitor, 'second@example.com');
      await expect(visitor.locator('[data-public-form-exhausted]')).toContainText(
        'This form has received the maximum number of responses.',
      );
    } finally {
      await anonymousContext?.close();
      await ownerContext?.close();
      instance.stop();
    }
  },
);

test(
  'F-6 hardens the full two-form lifecycle through live schema changes, duplication, deletion, and revocation',
  {tag: ['@database', '@manager-verified']},
  async ({browser}, workerInfo) => {
    test.setTimeout(240_000);
    const instance = await startClaimedInstance(workerInfo.workerIndex);
    let ownerContext: BrowserContext | null = null;
    let anonymousContext: BrowserContext | null = null;
    try {
      ownerContext = await appContext(browser, instance, instance.ownerHeaders);
      const ownerPage = await ownerContext.newPage();
      await ownerPage.goto('/');
      await expect(ownerPage.locator('[data-home-screen]')).toBeVisible();
      await ownerPage.keyboard.press('ControlOrMeta+k');
      await ownerPage.getByPlaceholder(/Search pages or run a command/).fill('New database');
      await ownerPage.keyboard.press('Enter');
      await expect(ownerPage.getByRole('button', {name: 'Add column'})).toBeVisible();

      const hostPageId = new URL(ownerPage.url()).searchParams.get('page');
      if (!hostPageId) throw new Error('new database did not navigate to its host page');
      const database = await ownerJson<StoredDatabase>(instance, `/api/pages/${hostPageId}/database`);
      const notes = database.schema.properties.find((property) => property.name === 'Notes');
      if (!notes) throw new Error('new database did not contain its Notes column');

      // Create two independent form views in the owner UI. Only the first is
      // published; merely creating the second must not mint publication state.
      await ownerPage.getByRole('button', {name: 'Add view'}).click();
      await ownerPage.getByRole('menuitem', {name: 'Form'}).click();
      await expect(ownerPage.locator('[data-database-form-builder]')).toBeVisible();
      const originalViewId = new URL(ownerPage.url()).searchParams.get('view');
      if (!originalViewId) throw new Error('first form did not become addressable');

      await ownerPage.getByRole('button', {name: 'Add view'}).click();
      await ownerPage.getByRole('menuitem', {name: 'Form'}).click();
      await expect(ownerPage.getByRole('button', {name: 'Form 2', exact: true})).toBeVisible();
      const secondViewId = new URL(ownerPage.url()).searchParams.get('view');
      expect(secondViewId).not.toBe(originalViewId);
      await ownerPage.getByRole('button', {name: 'Form', exact: true}).click();

      await ownerPage.getByRole('button', {name: 'Publish form'}).click();
      const originalReview = ownerPage.locator('[data-database-form-publish-review]');
      await expect(originalReview).toBeVisible();
      await originalReview.getByRole('button', {name: 'Publish form'}).click();
      const originalLink = ownerPage.locator('[data-database-form-fill-url] a').first();
      await expect(originalLink).toBeVisible();
      const originalUrl = await originalLink.getAttribute('href');
      if (!originalUrl) throw new Error('original form publish did not return a URL');

      anonymousContext = await appContext(browser, instance, instance.anonymousHeaders);
      const visitor = await anonymousContext.newPage();
      await visitor.goto(originalUrl);
      await expect(visitor.locator('[data-public-form]')).toBeVisible();
      await visitor.getByRole('textbox', {name: 'Notes'}).fill('archived first response');
      await visitor.getByRole('button', {name: 'Submit', exact: true}).click();
      await expect(visitor.locator('[data-public-form-confirmation]')).toBeVisible();

      // Keep the public page's text control stale while the owner retypes the
      // live column to select. Submitting its old string must be rejected by the
      // current server schema, not coerced through the rendered snapshot.
      await ownerPage.getByRole('button', {name: 'Table', exact: true}).click();
      await ownerPage.getByRole('table').getByText('Notes', {exact: true}).click({button: 'right'});
      await ownerPage.getByRole('menuitem', {name: 'Edit property…'}).click();
      const propertyEditor = ownerPage.getByLabel('Property name').locator('..');
      await chooseValue(ownerPage, propertyEditor.getByRole('combobox'), 'select');
      await ownerPage.keyboard.press('Escape');

      await visitor.getByRole('button', {name: 'Submit another response'}).click();
      await visitor.getByRole('textbox', {name: 'Notes'}).fill('stale after retype');
      await visitor.getByRole('button', {name: 'Submit', exact: true}).click();
      await expect(visitor.getByText('Choose an available option.')).toBeVisible();
      expect(await ownerJson<Array<unknown>>(instance, `/api/databases/${database.id}/rows`)).toHaveLength(1);

      // Delete through the shared table-header UI. The field is scrubbed from
      // both forms, the affected builder gets its one-time notice, and the
      // already accepted row retains its now-orphaned value as archive data.
      await ownerPage.getByRole('table').getByText('Notes', {exact: true}).click({button: 'right'});
      await ownerPage.getByRole('menuitem', {name: 'Delete property'}).click();
      await expect(ownerPage.getByRole('table').getByText('Notes', {exact: true})).toHaveCount(0);
      await ownerPage.getByRole('button', {name: 'Form', exact: true}).click();
      await expect(ownerPage.locator('[data-database-form-field-removed-notice]')).toContainText('Notes');
      await expect(ownerPage.locator(`[data-form-field-id="${notes.id}"]`)).toHaveCount(0);

      const afterDelete = await ownerJson<StoredDatabase>(instance, `/api/databases/${database.id}`);
      expect(afterDelete.schema.properties.some((property) => property.id === notes.id)).toBe(false);
      const archivedRows = await ownerJson<Array<{properties: Record<string, unknown>}>>(
        instance,
        `/api/databases/${database.id}/rows`,
      );
      expect(archivedRows[0].properties[notes.id]).toBe('archived first response');

      // Duplicate through the view-tab UI. The original URL remains live; the
      // copy is unpublished until its own explicit publish, then receives a
      // distinct capability.
      await ownerPage.getByRole('button', {name: 'Form', exact: true}).click({button: 'right'});
      await ownerPage.getByRole('menuitem', {name: 'Duplicate view'}).click();
      await expect(ownerPage.getByRole('button', {name: 'Form copy', exact: true})).toBeVisible();
      const duplicateViewId = new URL(ownerPage.url()).searchParams.get('view');
      expect(duplicateViewId).not.toBe(originalViewId);
      await expect(ownerPage.getByText('Not published', {exact: true})).toBeVisible();

      await visitor.goto(originalUrl);
      await expect(visitor.locator('[data-public-form]')).toBeVisible();
      await ownerPage.getByRole('button', {name: 'Publish form'}).click();
      const duplicateReview = ownerPage.locator('[data-database-form-publish-review]');
      await duplicateReview.getByRole('button', {name: 'Publish form'}).click();
      const duplicateLink = ownerPage.locator('[data-database-form-fill-url] a').first();
      await expect(duplicateLink).toBeVisible();
      const duplicateUrl = await duplicateLink.getAttribute('href');
      if (!duplicateUrl) throw new Error('duplicate form publish did not return a URL');
      expect(new URL(duplicateUrl).hash).not.toBe(new URL(originalUrl).hash);

      // Deleting the published duplicate through its tab revokes that view's
      // capability atomically. Explicitly revoking the untouched original then
      // closes its still-independent link as the final lifecycle step.
      await ownerPage.getByRole('button', {name: 'Form copy', exact: true}).click({button: 'right'});
      await ownerPage.getByRole('menuitem', {name: 'Delete view'}).click();
      await visitor.goto(duplicateUrl);
      await expect(visitor.locator('[data-public-form-not-found]')).toBeVisible();

      await ownerPage.getByRole('button', {name: 'Form', exact: true}).click();
      await expect(ownerPage.getByRole('button', {name: 'Revoke'})).toBeVisible();
      await ownerPage.getByRole('button', {name: 'Revoke'}).click();
      await expect(ownerPage.getByText('Not published', {exact: true})).toBeVisible();
      await visitor.goto(originalUrl);
      await expect(visitor.locator('[data-public-form-not-found]')).toBeVisible();
    } finally {
      await anonymousContext?.close();
      await ownerContext?.close();
      instance.stop();
    }
  },
);
