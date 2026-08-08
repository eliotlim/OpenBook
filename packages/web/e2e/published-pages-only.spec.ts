import {spawn, type ChildProcess} from 'node:child_process';
import {rmSync} from 'node:fs';
import {join} from 'node:path';
import type {BrowserContext, Page} from '@playwright/test';
// Imported from SOURCE, not the `@book.dev/sdk` package entry: the sdk publishes
// an `import`-only export map, and Playwright transpiles specs to CJS, so the
// bare specifier resolves to "No exports main defined". This module is
// Web-Crypto-only with one relative import, so pulling it in directly is cheap.
import {mintIdentityKeypair, signIdentity} from '../../sdk/src/identity';
import {test, expect, chooseValue, WORKER_DATA_DIR_PREFIX} from './fixtures';

/**
 * "Published pages only" — the fourth Default-access state (PUB-1).
 *
 * Per-page publishing has always worked at the API/authorize level, but the
 * settings control could not NAME the config pair it runs in:
 * `(defaultVisibility:'members', guestAccess:'read')` — exactly what
 * `claimOwnership` bootstraps a freshly-claimed instance to. Detection keyed on
 * `guestAccess` alone, so that pair rendered as the false "Anyone can view".
 *
 * This spec pins the whole loop against a REAL claimed server: the claimed state
 * displays honestly, one published page is reachable anonymously while its
 * sibling is not, and a round-trip through Private and back leaves the per-page
 * publish intact.
 *
 * ## Why this file spawns its OWN data server
 *
 * Claiming is PERMANENT (there is no un-claim; `repairOwnership` needs the
 * loopback owner hatch, which e2e leaves inert). The per-worker `dataServer`
 * fixture is reused by every later spec file in that worker, and every one of
 * them assumes the fresh, UNCLAIMED default (`guestAccess:'write'`, where the
 * anonymous browser is a manager). Claiming that server would turn guests
 * read-only and 403/404 the rest of the worker's run. So we run a dedicated,
 * throwaway instance on its own port and point both browser contexts at it.
 *
 * The data dir keeps the suite's `openbook-web-e2e-data-w` marker so
 * `global-teardown.ts` reaps it (and the process, via `pgrep -f MARKER`) if this
 * file dies before its own cleanup runs.
 */

/** Clear of the worker fixtures' 4400-4464 range, still marker-reaped. */
const CLAIMED_BASE_PORT = 4520;
const ISS = 'https://account.book.pub';
const PUBLISHED = 'PUB1 Published Page';
const UNPUBLISHED = 'PUB1 Private Sibling';
const EMPTY = {editorjs: {blocks: []}, values: [], names: []};

/** A live, CLAIMED instance plus the owner's verified identity assertion. */
interface ClaimedInstance {
  url: string;
  /** Owner headers: the verified `jws` the claim bound `ownerSubject` to. */
  owner: Record<string, string>;
  /** Anonymous headers — no identity, so the guest gate is what decides. */
  anon: Record<string, string>;
  stop: () => void;
}

/**
 * Spawn a data server and claim it, mirroring what the desktop app's forwarding
 * flow does over HTTP (and what `packages/server/src/ownerClaim.test.ts` pins
 * in-process): trust a locally-minted issuer, then `PUT /api/instance` with a
 * verified assertion. The route binds the VERIFIED subject and ignores the body,
 * and the claim atomically applies the §2.6 bootstrap — `defaultVisibility:
 * 'members'` + `guestAccess 'write'→'read'`, i.e. the `published` state.
 */
async function startClaimedInstance(workerIndex: number): Promise<ClaimedInstance> {
  const port = CLAIMED_BASE_PORT + workerIndex;
  const url = `http://127.0.0.1:${port}`;
  const dataDir = `${WORKER_DATA_DIR_PREFIX}pub1-${workerIndex}`;
  rmSync(dataDir, {recursive: true, force: true});

  // A leaked server here would pass the health check and serve a stale (already
  // claimed, differently keyed) workspace — fail loudly instead of adopting it.
  const squatter = await fetch(`${url}/health`).then((r) => r.ok, () => false);
  if (squatter) throw new Error(`something already serves :${port} — kill it (lsof -ti:${port} | xargs kill)`);

  // Spawn node directly (tsx via --import): the .bin/tsx wrapper would re-spawn
  // node as its child, and SIGKILL on the wrapper would orphan the real server.
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
      if (child.exitCode !== null) {
        throw new Error(`claimed data server exited (code ${child.exitCode})\n${stderrTail.trim()}`);
      }
      try {
        if ((await fetch(`${url}/health`)).ok) break;
      } catch {
        // not up yet
      }
      if (Date.now() > deadline) throw new Error(`claimed data server on :${port} never became healthy`);
      await new Promise((r) => setTimeout(r, 250));
    }

    const anon = {'content-type': 'application/json', 'X-OpenBook-Client': '1'};
    const kp = await mintIdentityKeypair('pub1-e2e');
    const now = Math.floor(Date.now() / 1000);
    const jws = await signIdentity(
      kp.privateKey,
      {iss: ISS, sub: `pub1-owner-${workerIndex}`, name: 'PUB1 Owner', iat: now - 30, exp: now + 3600, jti: `pub1-${Math.random()}`},
      kp.publicJwk.kid,
    );
    const owner = {...anon, 'X-OpenBook-Identity': jws};

    // Trust the minted issuer. Allowed unauthenticated while UNCLAIMED (the
    // owner gate engages only once `ownerSubject` is set); the inline `jwks`
    // keeps verification fully offline — no network fetch of a real JWKS.
    const trusted = await fetch(`${url}/api/instance`, {
      method: 'PUT',
      headers: anon,
      body: JSON.stringify({trustedIssuers: [{issuer: ISS, jwks: {keys: [kp.publicJwk]}}]}),
    });
    if (!trusted.ok) throw new Error(`could not trust the e2e issuer: ${trusted.status}`);

    // Claim. `ownerSubject` in the body is deliberately a decoy — the route binds
    // the verified `iss#sub`, so this also pins that it ignores caller-supplied
    // subjects.
    const claim = await fetch(`${url}/api/instance`, {
      method: 'PUT',
      headers: owner,
      body: JSON.stringify({ownerSubject: 'not-the-subject-that-gets-bound'}),
    });
    if (!claim.ok) throw new Error(`claim failed: ${claim.status}`);
    const config = (await claim.json()) as {ownerSubject?: string; guestAccess?: string; defaultVisibility?: string};
    expect(config.ownerSubject).toBe(`${ISS}#pub1-owner-${workerIndex}`);
    // The bootstrap that makes `published` the state a claimed library STARTS in.
    expect(config.guestAccess).toBe('read');
    expect(config.defaultVisibility).toBe('members');

    return {url, owner, anon, stop};
  } catch (e) {
    stop();
    throw e;
  }
}

/** A browser context wired to `instance`, optionally carrying owner identity. */
async function contextFor(
  browser: import('@playwright/test').Browser,
  instance: ClaimedInstance,
  as: 'owner' | 'anon',
): Promise<BrowserContext> {
  // The fixtures' `context` override points the app at the WORKER server, and it
  // does not apply to contexts we create — so wire the override ourselves.
  const context = await browser.newContext({
    extraHTTPHeaders: as === 'owner' ? instance.owner : instance.anon,
  });
  await context.addInitScript((serverUrl: string) => {
    try {
      localStorage.setItem('openbook.serverUrl', serverUrl);
    } catch {
      /* sandboxed frame — no storage, nothing to configure */
    }
  }, instance.url);
  return context;
}

/** Open Settings → Sharing & publishing and return the Default-access picker. */
async function openDefaultAccess(page: Page) {
  await page.getByRole('button', {name: 'Settings'}).first().click();
  await page.getByRole('button', {name: 'Sharing & publishing'}).click();
  await expect(page.getByRole('heading', {name: 'Guests & access'})).toBeVisible();
  const picker = page.getByRole('combobox', {name: 'Default access'});
  await expect(picker).toBeVisible();
  return picker;
}

/** Read the instance policy as the owner. */
async function policy(instance: ClaimedInstance): Promise<{guestAccess: string; defaultVisibility?: string | null}> {
  const res = await fetch(`${instance.url}/api/instance`, {headers: instance.owner});
  return (await res.json()) as {guestAccess: string; defaultVisibility?: string | null};
}

test.describe.configure({mode: 'serial'});

test.describe('PUB-1: published-pages-only default access', () => {
  let instance: ClaimedInstance;
  let publishedId: string;
  let unpublishedId: string;

  // eslint-disable-next-line no-empty-pattern -- Playwright hooks take a destructured first arg
  test.beforeAll(async ({}, workerInfo) => {
    test.setTimeout(120_000);
    instance = await startClaimedInstance(workerInfo.workerIndex);

    const mk = async (name: string): Promise<string> => {
      const res = await fetch(`${instance.url}/api/pages`, {
        method: 'POST',
        headers: instance.owner,
        body: JSON.stringify({name, data: EMPTY}),
      });
      if (!res.ok) throw new Error(`could not seed "${name}": ${res.status}`);
      return ((await res.json()) as {id: string}).id;
    };
    publishedId = await mk(PUBLISHED);
    unpublishedId = await mk(UNPUBLISHED);
  });

  test.afterAll(() => instance?.stop());

  test(
    'a claimed library shows "Published pages only", serves exactly the published page to visitors, and survives a Private round-trip',
    {tag: ['@sharing']},
    async ({browser}) => {
      const ownerContext = await contextFor(browser, instance, 'owner');
      const ownerPage = await ownerContext.newPage();
      await ownerPage.goto('/');

      // ── 1. The claimed instance renders its TRUE state ──────────────────────
      // Before PUB-1 this same `(members, read)` config displayed "Anyone can
      // view" — a claim that was simply false.
      const picker = await openDefaultAccess(ownerPage);
      await expect(picker).toHaveAttribute('data-value', 'published');
      await expect(picker).toHaveText(/Published pages only/);
      await expect(
        ownerPage.getByText(/Only pages you explicitly publish are visible to visitors/),
      ).toBeVisible();

      // ── 2. Publish exactly ONE page ─────────────────────────────────────────
      const published = await fetch(`${instance.url}/api/pages/${publishedId}/visibility`, {
        method: 'PUT',
        headers: instance.owner,
        body: JSON.stringify({visibility: 'public'}),
      });
      expect(published.ok).toBe(true);

      // ── 3. A visitor sees THAT page and nothing else ─────────────────────────
      const anonContext = await contextFor(browser, instance, 'anon');
      const anonPage = await anonContext.newPage();
      await anonPage.goto(`/?page=${publishedId}`);

      // Content: the published page actually opens for a signed-out visitor.
      await expect(anonPage.locator('.ob-page-title')).toHaveText(PUBLISHED);
      // Sidebar: the published page is listed, the sibling is not. The list is
      // server-filtered (`listPagesFor` → `filterReadablePages`), so absence here
      // is default-deny, not a UI omission.
      await expect(anonPage.getByRole('treeitem', {name: PUBLISHED}).first()).toBeVisible();
      await expect(anonPage.getByRole('treeitem', {name: UNPUBLISHED})).toHaveCount(0);

      // The unpublished sibling 404s at the API — the authoritative check. (The
      // UI can't show a 404: NavigationProvider resolves `?page=` and silently
      // falls back to a readable page when the id isn't, so the absence above and
      // this status together are the honest assertion.)
      const anonGet = (id: string) => anonContext.request.get(`${instance.url}/api/pages/${id}`);
      expect((await anonGet(publishedId)).status()).toBe(200);
      expect((await anonGet(unpublishedId)).status()).toBe(404);

      // And the whole list a visitor can see is exactly the one published page.
      const anonList = await (await anonContext.request.get(`${instance.url}/api/pages`)).json();
      expect((anonList as {name: string}[]).map((p) => p.name)).toEqual([PUBLISHED]);

      // ── 4. Switch to Private — the guest gate is a hard floor ────────────────
      await chooseValue(ownerPage, picker, 'private');
      await expect(picker).toHaveAttribute('data-value', 'private');
      await expect.poll(async () => (await policy(instance)).guestAccess).toBe('off');
      // Even the PUBLISHED page stops serving signed-out visitors: `guestAccess:
      // 'off'` denies before per-page visibility is ever consulted.
      expect((await anonGet(publishedId)).status()).toBe(401);

      // ── 5. …and back. The per-page publish is still intact ───────────────────
      await chooseValue(ownerPage, picker, 'published');
      await expect(picker).toHaveAttribute('data-value', 'published');
      await expect.poll(async () => (await policy(instance)).guestAccess).toBe('read');
      // The round-trip must not have widened the default to `public` — that is the
      // silent whole-library exposure the old three-state control could cause.
      expect((await policy(instance)).defaultVisibility).toBe('members');

      // The page's own `public` visibility survived both instance-policy writes.
      const visibility = await (
        await fetch(`${instance.url}/api/pages/${publishedId}/visibility`, {headers: instance.owner})
      ).json();
      expect(visibility).toEqual({visibility: 'public'});
      expect((await anonGet(publishedId)).status()).toBe(200);
      expect((await anonGet(unpublishedId)).status()).toBe(404);

      // Same story in the visitor's browser after a reload: one page, the right one.
      await anonPage.reload();
      await expect(anonPage.getByRole('treeitem', {name: PUBLISHED}).first()).toBeVisible();
      await expect(anonPage.getByRole('treeitem', {name: UNPUBLISHED})).toHaveCount(0);

      await anonContext.close();
      await ownerContext.close();
    },
  );
});
