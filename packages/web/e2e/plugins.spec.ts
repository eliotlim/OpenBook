import {test, expect} from './fixtures';
import {SERVER} from './seed';
import {zipSync, strToU8} from 'fflate';

// The extension system, end to end: install a zip of TypeScript source
// through Settings → Extensions, watch its block and command appear, check
// signature provenance badges, disable, and remove.

const MANIFEST = {
  id: 'acme.hello',
  name: 'Hello Test',
  version: '1.0.0',
  description: 'An e2e fixture extension.',
  author: 'Acme',
  icon: '🧪',
  main: 'src/index.ts',
};

const SOURCES: Record<string, string> = {
  'src/index.ts': `
    import {greet} from './greet';
    export default function activate(api) {
      api.blocks.register({
        type: 'hello',
        render: ({block}) => {
          const React = require('react');
          return React.createElement('div', {'data-hello-block': true, contentEditable: false}, greet());
        },
        slash: {label: 'Hello test block', hint: 'From the e2e fixture', keywords: 'hello fixture test', make: () => ({type: 'acme.hello/hello', props: {}})},
      });
      api.commands.register({id: 'wave', title: 'Wave from the fixture', keywords: 'wave hello', run: () => {}});
    }
  `,
  'src/greet.ts': 'export const greet = (): string => \'plugin says hi\';',
};

const zipOf = (withSignature?: object): Buffer => {
  const entries: Record<string, Uint8Array> = {'openbook.json': strToU8(JSON.stringify(MANIFEST))};
  for (const [p, s] of Object.entries(SOURCES)) entries[p] = strToU8(s);
  if (withSignature) entries['signature.json'] = strToU8(JSON.stringify(withSignature));
  return Buffer.from(zipSync(entries));
};

/** Sign the fixture in-test (mirrors the SDK's canonical digest + Ed25519). */
async function signFixture(): Promise<{signature: object; publicKey: string}> {
  const te = new TextEncoder();
  const parts: Uint8Array[] = [];
  const push = (s: string): void => {
    const bytes = te.encode(s);
    const len = new Uint8Array(4);
    new DataView(len.buffer).setUint32(0, bytes.length);
    parts.push(len, bytes);
  };
  push(JSON.stringify(MANIFEST, Object.keys(MANIFEST).sort()));
  for (const p of Object.keys(SOURCES).sort()) {
    push(p);
    push(SOURCES[p]);
  }
  const all = new Uint8Array(parts.reduce((n, x) => n + x.length, 0));
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.length;
  }
  const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', all))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const pair = (await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])) as CryptoKeyPair;
  const publicKey = Buffer.from(await crypto.subtle.exportKey('raw', pair.publicKey)).toString('base64');
  const signature = Buffer.from(await crypto.subtle.sign('Ed25519', pair.privateKey, te.encode(digest))).toString('base64');
  return {signature: {registry: 'E2E Registry', publicKey, signature, algorithm: 'ed25519'}, publicKey};
}

async function openExtensions(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByRole('button', {name: 'Page actions'})).toBeVisible();
  await page.keyboard.press('ControlOrMeta+,');
  await page.getByRole('button', {name: 'Extensions', exact: true}).click();
}

test('install an unsigned zip: block, command, badge, disable, remove', async ({page, request}) => {
  await openExtensions(page);
  await expect(page.getByText('No extensions installed')).toBeVisible();

  await page.locator('[data-extension-file]').setInputFiles({name: 'hello.zip', mimeType: 'application/zip', buffer: zipOf()});
  const card = page.locator('[data-extension="acme.hello"]');
  await expect(card).toBeVisible();
  await expect(card.locator('[data-extension-unverified]')).toBeVisible();
  await expect(card).toHaveAttribute('data-extension-state', 'active');
  await page.keyboard.press('Escape');

  // The plugin's command joined the palette…
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByPlaceholder(/Search pages or run a command/).fill('Wave from the fixture');
  await expect(page.getByRole('option', {name: /Wave from the fixture/})).toBeVisible();
  await page.keyboard.press('Escape');

  // …and its block renders on a page via the slash menu.
  const res = await request.post(`${SERVER}/api/pages`, {
    data: {name: `Plugin host ${Date.now()}`, data: {editor: 'blocks', blockdoc: {blocks: [{id: 'p1', type: 'paragraph', text: [{t: ''}]}]}, editorjs: {blocks: []}, values: [], names: []}},
  });
  const {id} = (await res.json()) as {id: string};
  await page.goto(`/?page=${id}`);
  await page.locator('.obe-text').first().click();
  await page.keyboard.type('/hello test');
  await page.locator('.obe-slash-item', {has: page.locator('.obe-slash-label', {hasText: 'Hello test block'})}).first().click();
  await expect(page.locator('[data-hello-block]')).toHaveText('plugin says hi');
  // The whole multi-word "/hello test" query was cleaned up on pick.
  await expect(page.locator('.obe-text', {hasText: 'test'})).toHaveCount(0);

  // Disable → contributions vanish (the block renders as unsupported).
  await openExtensions(page);
  await page.getByLabel('Enable Hello Test').click();
  await expect(page.locator('[data-extension="acme.hello"]')).toHaveAttribute('data-extension-state', 'disabled');
  await page.keyboard.press('Escape');
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByPlaceholder(/Search pages or run a command/).fill('Wave from the fixture');
  await expect(page.getByRole('option', {name: /Wave from the fixture/})).toHaveCount(0);
  await page.keyboard.press('Escape');

  // Remove → the card is gone.
  await openExtensions(page);
  await page.getByLabel('Remove Hello Test').click();
  await expect(page.locator('[data-extension="acme.hello"]')).toHaveCount(0);
  await expect(page.getByText('No extensions installed')).toBeVisible();
});

test('a signed zip from a trusted registry shows Verified; tampering or distrust loses it', async ({page}) => {
  const {signature, publicKey} = await signFixture();

  await openExtensions(page);

  // The first-party key is pinned: shown as built-in, not removable.
  const builtIn = page.locator('[data-registry="OpenBook Registry"]');
  await expect(builtIn).toBeVisible();
  await expect(builtIn.getByLabel(/Remove registry/)).toHaveCount(0);

  // A garbage key is rejected before it ever lands in the trust list.
  await page.locator('[data-registry-name]').fill('E2E Registry');
  await page.locator('[data-registry-key]').fill('not a key');
  await page.locator('[data-registry-add]').click();
  await expect(page.locator('[data-registry-key-error]')).toBeVisible();

  // Trust the e2e registry through the UI (the third-party flow).
  await page.locator('[data-registry-key]').fill(publicKey);
  await expect(page.locator('[data-registry-key-error]')).toHaveCount(0);
  await page.locator('[data-registry-add]').click();
  await expect(page.locator('[data-registry="E2E Registry"]')).toBeVisible();

  await page.locator('[data-extension-file]').setInputFiles({name: 'signed.zip', mimeType: 'application/zip', buffer: zipOf(signature)});
  const card = page.locator('[data-extension="acme.hello"]');
  await expect(card.locator('[data-extension-verified]')).toBeVisible();

  // Re-install with modified content but the OLD signature → Unverified.
  const tampered = {...SOURCES, 'src/greet.ts': 'export const greet = (): string => \'evil\';'};
  const entries: Record<string, Uint8Array> = {'openbook.json': strToU8(JSON.stringify(MANIFEST)), 'signature.json': strToU8(JSON.stringify(signature))};
  for (const [p, s] of Object.entries(tampered)) entries[p] = strToU8(s);
  await page.locator('[data-extension-file]').setInputFiles({name: 'tampered.zip', mimeType: 'application/zip', buffer: Buffer.from(zipSync(entries))});
  await expect(card.locator('[data-extension-unverified]')).toBeVisible();

  // Restore the genuine package, then withdraw trust → Verified demotes.
  await page.locator('[data-extension-file]').setInputFiles({name: 'signed.zip', mimeType: 'application/zip', buffer: zipOf(signature)});
  await expect(card.locator('[data-extension-verified]')).toBeVisible();
  await page.getByLabel('Remove registry E2E Registry').click();
  await expect(page.locator('[data-registry="E2E Registry"]')).toHaveCount(0);
  await expect(card.locator('[data-extension-unverified]')).toBeVisible();

  await page.getByLabel('Remove Hello Test').click();
  await expect(card).toHaveCount(0);
});
