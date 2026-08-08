import {createHash, generateKeyPairSync, sign as edSign} from 'node:crypto';
import type {BrowserContext, Page} from '@playwright/test';
import {test, expect} from './fixtures';
import {SERVER} from './seed';

/**
 * OB-641 (ST-6) — the client side of the plugin store, end to end against a
 * FAKE openbook-registry/1 served via route interception (no live store):
 * pin a store (fingerprint confirmation), browse, install with the
 * verify-then-consent dialog, upgrade with the enabled state preserved,
 * resolve an unknown third-party block to an install prompt, and honour
 * revocations. The hard security invariant is asserted throughout: NO plugin
 * code executes before the signature-verification outcome is displayed and
 * the user consents.
 */

const STORE_URL = 'https://store.e2e';

// ── Node-side crypto: the same scheme the SDK verifies (PROTOCOL.md §7) ─────

interface SigningKey {
  raw: string; // base64 raw 32-byte public key
  sign: (message: string) => string; // base64 signature over UTF-8 message
}

function genKey(): SigningKey {
  const {publicKey, privateKey} = generateKeyPairSync('ed25519');
  const raw = (publicKey.export({type: 'spki', format: 'der'}) as Buffer).subarray(-32).toString('base64');
  return {raw, sign: (m: string) => edSign(null, Buffer.from(m, 'utf8'), privateKey).toString('base64')};
}

/** Canonical JSON — all keys sorted at every depth (mirrors the SDK). */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

function canonicalDigest(manifest: Record<string, unknown>, files: Record<string, string>): string {
  const parts: Buffer[] = [];
  const push = (s: string): void => {
    const bytes = Buffer.from(s, 'utf8');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(bytes.length);
    parts.push(len, bytes);
  };
  push(canonicalJson(manifest));
  for (const p of Object.keys(files).sort()) {
    push(p);
    push(files[p]);
  }
  return createHash('sha256').update(Buffer.concat(parts)).digest('hex');
}

// ── The fake store ───────────────────────────────────────────────────────────

interface FakeVersion {
  manifest: Record<string, unknown>;
  files: Record<string, string>;
  digest: string;
  signature: {registry: string; publicKey: string; signature: string; algorithm: 'ed25519'};
}

interface FakeStore {
  name: string;
  publisher: SigningKey;
  notary: SigningKey | null;
  versions: Record<string, FakeVersion>;
  latest: string;
  revocations: Array<Record<string, unknown>>;
  maxSeq: number;
}

function buildVersion(publisher: SigningKey, version: string): FakeVersion {
  const manifest = {
    id: 'acme.stars',
    name: 'Stars',
    version,
    description: 'A starry test block from the fake store.',
    icon: '⭐',
    main: 'src/index.ts',
  };
  const files = {
    'src/index.ts': `
      export default function activate(api) {
        (globalThis).__starsActivated = '${version}';
        api.blocks.register({
          type: 'stars',
          render: () => {
            const React = require('react');
            return React.createElement('div', {'data-stars-block': true, contentEditable: false}, 'stars v${version}');
          },
        });
      }
    `,
  };
  const digest = canonicalDigest(manifest, files);
  return {
    manifest,
    files,
    digest,
    signature: {registry: 'E2E Store', publicKey: publisher.raw, signature: publisher.sign(digest), algorithm: 'ed25519'},
  };
}

function makeStore(opts: {withNotary?: boolean} = {}): FakeStore {
  const publisher = genKey();
  return {
    name: 'E2E Store',
    publisher,
    notary: opts.withNotary === false ? null : genKey(),
    versions: {'1.0.0': buildVersion(publisher, '1.0.0'), '1.1.0': buildVersion(publisher, '1.1.0')},
    latest: '1.0.0',
    revocations: [],
    maxSeq: 0,
  };
}

/** A signed (when the store has a notary) revocation entry for the feed. */
function revoke(store: FakeStore, seq: number, version: string | null, reason: string): void {
  const createdAt = new Date().toISOString();
  const entry: Record<string, unknown> = {
    id: `rev-${seq}`,
    seq,
    pluginId: 'acme.stars',
    version,
    reason,
    createdAt,
    signerPublicKey: store.notary?.raw ?? null,
    signature:
      store.notary?.sign(canonicalJson({id: `rev-${seq}`, pluginId: 'acme.stars', reason, revokedAt: createdAt, seq, version})) ?? null,
  };
  store.revocations.push(entry);
  store.maxSeq = Math.max(store.maxSeq, seq);
}

/** Intercept the fake registry origin for a whole browser context. */
async function mountStore(context: BrowserContext, store: FakeStore): Promise<void> {
  const CORS = {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, HEAD, OPTIONS',
    'access-control-allow-headers': 'Content-Type, If-None-Match',
    'access-control-expose-headers': 'ETag, Content-Length, X-Canonical-Digest',
  };
  const json = (body: unknown, status = 200, extra: Record<string, string> = {}) => ({
    status,
    headers: {...CORS, 'content-type': 'application/json; charset=utf-8', ...extra},
    body: JSON.stringify(body),
  });

  await context.route(`${STORE_URL}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() === 'OPTIONS') return route.fulfill({status: 204, headers: CORS});
    const path = url.pathname;

    if (path === '/api/v1/registry') {
      return route.fulfill(
        json({
          protocol: 'openbook-registry/1',
          name: store.name,
          baseUrl: STORE_URL,
          apiVersion: 1,
          algorithms: ['ed25519'],
          notaryPublicKey: store.notary?.raw ?? null,
          registryPublicKey: null,
          fingerprints: {notary: null, registry: null},
          endpoints: {
            index: '/api/v1/index',
            plugin: '/api/v1/plugins/{id}',
            download: '/api/v1/plugins/{id}/versions/{version}/download',
            revocations: '/api/v1/revocations',
          },
        }),
      );
    }

    if (path === '/api/v1/index') {
      const latest = store.versions[store.latest];
      const q = (url.searchParams.get('q') ?? '').toLowerCase();
      const matches = !q || 'acme.stars'.includes(q) || 'stars'.includes(q);
      return route.fulfill(
        json({
          plugins: matches
            ? [
              {
                id: 'acme.stars',
                name: 'Stars',
                description: latest.manifest.description,
                icon: '⭐',
                category: null,
                publisher: 'Acme Corp',
                pinnedKey: store.publisher.raw,
                latestVersion: store.latest,
                digest: latest.digest,
                artifactSha256: 'unused',
              },
            ]
            : [],
          limit: 50,
          nextCursor: null,
          hasMore: false,
        }),
      );
    }

    const dl = /^\/api\/v1\/plugins\/([^/]+)\/versions\/([^/]+)\/download$/.exec(path);
    if (dl) {
      const version = decodeURIComponent(dl[2]);
      const v = store.versions[version];
      if (decodeURIComponent(dl[1]) !== 'acme.stars' || !v) return route.fulfill(json({error: 'not_found', message: 'unknown'}, 404));
      if (store.revocations.some((r) => r.pluginId === 'acme.stars' && (r.version === null || r.version === version))) {
        return route.fulfill(json({error: 'revoked', message: 'revoked'}, 410));
      }
      const doc: Record<string, unknown> = {manifest: v.manifest, files: v.files, signature: v.signature};
      if (store.notary) {
        doc.notarization = {
          registry: store.name,
          publicKey: store.notary.raw,
          signature: store.notary.sign(v.digest),
          algorithm: 'ed25519',
          timestamp: new Date().toISOString(),
        };
      }
      const body = Buffer.from(JSON.stringify(doc), 'utf8');
      return route.fulfill({
        status: 200,
        headers: {
          ...CORS,
          'content-type': 'application/json; charset=utf-8',
          etag: `"${createHash('sha256').update(body).digest('hex')}"`,
          'x-canonical-digest': v.digest,
        },
        body,
      });
    }

    if (path === '/api/v1/revocations') {
      const since = Number(url.searchParams.get('since') ?? '0');
      return route.fulfill(json({policy: 'e2e', maxSeq: store.maxSeq, revocations: store.revocations.filter((r) => (r.seq as number) > since)}));
    }

    return route.fulfill(json({error: 'not_found', message: path}, 404));
  });
}

// ── UI helpers ───────────────────────────────────────────────────────────────

async function openExtensions(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByRole('button', {name: 'Page actions'})).toBeVisible();
  await page.keyboard.press('ControlOrMeta+,');
  await page.getByRole('button', {name: 'Extensions', exact: true}).click();
  await expect(page.locator('[data-extension-file]')).toBeAttached();
}

async function pinStore(page: Page): Promise<void> {
  await page.locator('[data-store-url]').fill(STORE_URL);
  await page.locator('[data-store-connect]').click();
  // §6.2: the fingerprints are displayed for out-of-band confirmation…
  await expect(page.locator('[data-store-pin-prompt]')).toBeVisible();
  await expect(page.locator('[data-store-pin-prompt]')).toContainText('E2E Store');
  // …and only the explicit confirmation pins the store.
  await page.locator('[data-store-pin]').click();
  await expect(page.locator(`[data-store="${STORE_URL}"]`)).toBeVisible();
}

const starsActivated = (page: Page): Promise<unknown> => page.evaluate(() => (globalThis as Record<string, unknown>).__starsActivated);

/**
 * Server-side reset: spec files share a worker's data server, so a previous
 * test's installed copy (or upgraded version) must not leak into this one —
 * a leftover 1.1.0 would flip Install buttons to "Installed" and turn a
 * fresh 1.0.0 install into a rejected downgrade.
 */
async function removeStars(request: import('@playwright/test').APIRequestContext): Promise<void> {
  await request.delete(`${SERVER}/api/plugins/acme.stars`).catch(() => undefined);
}

async function makeStarsPage(request: import('@playwright/test').APIRequestContext, name: string): Promise<string> {
  const res = await request.post(`${SERVER}/api/pages`, {
    data: {
      name,
      data: {
        editor: 'blocks',
        blockdoc: {blocks: [{id: 'p1', type: 'paragraph', text: [{t: 'above'}]}, {id: 's1', type: 'acme.stars/stars', props: {}}]},
        editorjs: {blocks: []},
        values: [],
        names: [],
      },
    },
  });
  const {id} = (await res.json()) as {id: string};
  return id;
}

// ── Tests ────────────────────────────────────────────────────────────────────

test('pin a store, install with verify-then-consent, then upgrade without force-enabling', {tag: ['@plugins']}, async ({page, context, request}) => {
  const store = makeStore();
  await mountStore(context, store);
  await removeStars(request);

  await openExtensions(page);
  await pinStore(page);

  // The catalogue browses on pin; the fake's plugin shows publisher + version.
  const row = page.locator('[data-store-result="acme.stars"]');
  await expect(row).toBeVisible();
  await expect(row).toContainText('by Acme Corp');
  await expect(row).toContainText('v1.0.0');

  // Install → the dialog runs download + offline verification and DISPLAYS
  // the outcome (notarised by this store) before anything can run.
  await row.locator('[data-store-install]').click();
  const dialog = page.locator('[data-store-confirm]');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('[data-store-badge-signed]')).toBeVisible();
  await expect(dialog.locator('[data-store-badge-notarised]')).toBeVisible();
  // Outcome displayed, consent NOT yet given: no plugin code has executed.
  expect(await starsActivated(page)).toBeUndefined();

  await dialog.locator('[data-store-confirm-install]').click();
  const card = page.locator('[data-extension="acme.stars"]');
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute('data-extension-state', 'active');
  await expect(card).toContainText('v1.0.0');

  // The plugin's block renders on a page.
  const pageId = await makeStarsPage(request, `Stars host ${Date.now()}`);
  await page.goto(`/?page=${pageId}`);
  await expect(page.locator('[data-stars-block]')).toHaveText('stars v1.0.0');

  // The user disables it; then the store ships 1.1.0.
  await openExtensions(page);
  await page.getByLabel('Enable Stars').click();
  await expect(card).toHaveAttribute('data-extension-state', 'disabled');
  store.latest = '1.1.0';

  // Re-open so the catalogue re-browses: the installed card gains an
  // update-available chip (semver compare) and the store row an Update button.
  await page.keyboard.press('Escape');
  await openExtensions(page);
  await expect(page.locator('[data-extension-update="1.1.0"]')).toBeVisible();
  await page.locator('[data-store-update]').click();
  await expect(dialog.locator('[data-store-badge-notarised]')).toBeVisible();
  await dialog.locator('[data-store-confirm-install]').click();

  // Version bumps; the user's disabled choice is PRESERVED, not force-enabled.
  await expect(card).toContainText('v1.1.0');
  await expect(card).toHaveAttribute('data-extension-state', 'disabled');
  expect(await starsActivated(page)).toBeUndefined(); // still disabled → still never ran
});

test('an unknown third-party block resolves to an install prompt with publisher + trust', {tag: ['@plugins']}, async ({page, context, request}) => {
  const store = makeStore();
  await mountStore(context, store);
  await removeStars(request);
  const pageId = await makeStarsPage(request, `Stars missing ${Date.now()}`);

  // WITHOUT a pinned store: a graceful dead-end, not a broken editor.
  await page.goto(`/?page=${pageId}`);
  const missing = page.locator('.obe-missing-plugin');
  await expect(missing).toBeVisible();
  await expect(missing).toContainText('Plugin not available');

  // Pin the store, then revisit: the block resolves against it.
  await openExtensions(page);
  await pinStore(page);
  await page.keyboard.press('Escape');
  await page.goto(`/?page=${pageId}`);
  await expect(missing).toContainText('by Acme Corp');
  await expect(missing).toContainText('via E2E Store');

  // Step 1: verify. The outcome is displayed; nothing has installed or run.
  await missing.locator('[data-missing-plugin-verify]').click();
  await expect(missing.locator('[data-trust-notarised]')).toBeVisible();
  expect(await starsActivated(page)).toBeUndefined();
  await expect(page.locator('[data-stars-block]')).toHaveCount(0);

  // Step 2: consent. Only now does the plugin install and its block render.
  await missing.locator('[data-missing-plugin-install]').click();
  await expect(page.locator('[data-stars-block]')).toHaveText('stars v1.0.0');
  expect(await starsActivated(page)).toBe('1.0.0');
});

test('an unreviewed store install warns and waits for consent; a revoked version never installs', {tag: ['@plugins']}, async ({page, context, request}) => {
  const store = makeStore({withNotary: false}); // no notary → nothing is notarised
  await mountStore(context, store);
  await removeStars(request);

  await openExtensions(page);
  await pinStore(page);
  const row = page.locator('[data-store-result="acme.stars"]');
  await row.locator('[data-store-install]').click();

  // The verification outcome says: publisher signature verifies, but the
  // store has NOT reviewed this content — the explicit-consent path.
  const dialog = page.locator('[data-store-confirm]');
  await expect(dialog.locator('[data-store-badge-unreviewed]')).toBeVisible();
  await expect(dialog.locator('[data-store-unreviewed-warning]')).toBeVisible();

  // Declining consent installs nothing and runs nothing.
  await dialog.getByRole('button', {name: 'Cancel'}).click();
  await expect(page.locator('[data-extension="acme.stars"]')).toHaveCount(0);
  expect(await starsActivated(page)).toBeUndefined();

  // Consenting installs it.
  await row.locator('[data-store-install]').click();
  await dialog.locator('[data-store-confirm-install]').click();
  await expect(page.locator('[data-extension="acme.stars"]')).toHaveAttribute('data-extension-state', 'active');

  // Now the store revokes every version (unsigned entries are honoured on a
  // registry with no notary key — §6.6). Remove, then try to reinstall: the
  // verify step refuses; the consent button never becomes actionable.
  revoke(store, 1, null, 'compromised build');
  await page.getByLabel('Remove Stars').click();
  await expect(page.locator('[data-extension="acme.stars"]')).toHaveCount(0);

  await row.locator('[data-store-install]').click();
  await expect(dialog.locator('[data-store-confirm-error]')).toContainText(/revoked/i);
  await expect(dialog.locator('[data-store-confirm-install]')).toBeDisabled();
  await dialog.getByRole('button', {name: 'Cancel'}).click();
  await expect(page.locator('[data-extension="acme.stars"]')).toHaveCount(0);
});
