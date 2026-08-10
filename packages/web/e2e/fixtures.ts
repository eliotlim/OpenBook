import {spawn} from 'node:child_process';
import {rmSync} from 'node:fs';
import {join} from 'node:path';
import {takeSnapshot as chromaticTakeSnapshot, test as chromaticTest} from '@chromatic-com/playwright';
import {expect, request as playwrightRequest, test as playwrightTest} from '@playwright/test';
import type {APIRequestContext, Locator, Page} from '@playwright/test';

/**
 * Decouple Chromatic visual archiving from functional e2e (OB-222).
 *
 * `@chromatic-com/playwright`'s `test` adds an auto fixture
 * (`performChromaticSnapshot`) that, on EVERY test, intercepts the page's
 * network to build a resource archive, snapshots the DOM via the injected
 * `__chromatic_takeSnapshot` browser script, and writes a `chromatic-archives/`
 * bundle to disk. That work — and its dependency on the snapshot infra (the
 * flake we pin a pnpm patch for) — is only wanted for the deliberate `@visual`
 * checkpoints uploaded by the `chromatic` script. Functional runs (`--grep
 * @p1`, per-area, nightly) shouldn't pay for it or be coupled to it.
 *
 * So we gate the base `test`: only the Chromatic/visual job opts in by setting
 * `CHROMATIC_ARCHIVE=1` (see the `chromatic` script). Otherwise we extend the
 * plain Playwright `test`, which has no archiving fixture at all. `@visual`
 * specs still run as ordinary functional tests in the ungated path because
 * {@link takeSnapshot} is a no-op there.
 *
 * A dedicated flag (not bare `CHROMATIC`) avoids any ambiguity with the
 * `chromatic` CLI / Storybook's own `CHROMATIC` convention.
 */
const ARCHIVE_VISUALS = process.env.CHROMATIC_ARCHIVE === '1';

// Cast to the plain Playwright `TestType`: the Chromatic `test` is a strict
// superset (same fixtures plus opt-in ChromaticConfig options, none of which
// any spec uses), so erasing those extra options here is sound and keeps the
// `.extend` below identically typed on both paths.
const base = (ARCHIVE_VISUALS ? chromaticTest : playwrightTest) as typeof playwrightTest;

/**
 * Worker isolation for the e2e suite: every Playwright worker runs its own
 * OpenBook data server (own port, own throwaway PGlite data dir), and every
 * browser context is pointed at it via the `openbook.serverUrl` override the
 * web shell already honours. Workspaces are therefore disjoint across
 * workers, so spec files run in parallel without colliding on the global
 * page-name uniqueness — the cause of the old serial `workers: 1` setup and
 * its polluted-rerun flakes.
 *
 * The worker's server URL must match `SERVER` in seed.ts, which derives the
 * same port from `TEST_WORKER_INDEX` for API seeding.
 */

export const WORKER_BASE_PORT = 4400;

/**
 * Prefix for each worker's throwaway PGlite data dir; the worker index is
 * appended (e.g. `…-w0`). Kept as a single source of truth so the
 * global-teardown reaper (e2e/global-teardown.ts) can find and remove the dirs
 * a crashed worker leaves behind. Deliberately literal `/tmp` (not os.tmpdir,
 * which is `/var/folders/…` on macOS) so the path matches across both files.
 */
export const WORKER_DATA_DIR_PREFIX = '/tmp/openbook-web-e2e-data-w';
const LOCAL_OWNER_SECRET = 'openbook-web-e2e-local-owner';

type WorkerFixtures = {
  /** This worker's data-server URL; starting it is the fixture's job. */
  dataServer: string;
  /** API context authenticated as the machine owner for host-sensitive setup. */
  ownerRequest: APIRequestContext;
};

type TestFixtures = {
  /**
   * Opt a spec into structural per-test workspace isolation (OB-223). Set once
   * per file with `test.use({freshWorkspace: true})`: before EACH test the
   * worker's data server is wiped, so pages and rows can use plain fixed names
   * without colliding with names a sibling test (sharing this worker) left
   * behind. Replaces the old per-spec discipline of `reclaimNames()` +
   * `Date.now()`-suffixed names. Default off, so accumulating specs are
   * unaffected.
   */
  freshWorkspace: boolean;
  /** Auto fixture that performs the reset; never requested directly. */
  _workspaceReset: void;
};

/**
 * Trash every live page on the worker's data server, freeing all
 * workspace-unique names before the test runs. Rows are pages too, so a single
 * whole-space export → delete pass clears row titles as well (mirrors
 * seed.ts#reclaimNames, but for the whole workspace and over plain `fetch` so
 * it needs no APIRequestContext fixture).
 */
async function resetWorkspace(serverUrl: string): Promise<void> {
  const res = await fetch(`${serverUrl}/api/export`);
  if (!res.ok) return; // a brand-new worker server is already empty
  const bundle = (await res.json()) as {pages?: {id: string}[]};
  await Promise.all(
    (bundle.pages ?? []).map((p) =>
      fetch(`${serverUrl}/api/pages/${p.id}`, {method: 'DELETE', headers: {'X-OpenBook-Client': '1'}}).catch(() => undefined),
    ),
  );
}

/**
 * Guarantee the workspace has at least one page. A truly empty workspace lands
 * on Home (the first-run guided start) instead of a document, but the legacy
 * (non-`freshWorkspace`) specs were written against the old behaviour — boot,
 * land on a page, see "Page actions" — so this restores that invariant for
 * them: on an empty worker server (fresh CI boot, or right after a
 * `freshWorkspace` file wiped it), seed one untitled page before the test.
 */
async function ensureAnyPage(serverUrl: string): Promise<void> {
  const res = await fetch(`${serverUrl}/api/pages`).catch(() => null);
  if (!res || !res.ok) return;
  const pages = (await res.json()) as unknown[];
  if (pages.length > 0) return;
  await fetch(`${serverUrl}/api/pages`, {
    method: 'POST',
    headers: {'content-type': 'application/json', 'X-OpenBook-Client': '1'},
    body: JSON.stringify({name: null, data: {editorjs: {blocks: []}, values: [], names: []}}),
  }).catch(() => undefined);
}

export const test = base.extend<TestFixtures, WorkerFixtures>({
  freshWorkspace: [false, {option: true}],

  // Auto: when the spec opted in, start every test from an empty workspace;
  // otherwise make sure at least one page exists (see {@link ensureAnyPage}).
  // Runs before the test body (and its first navigation), so the app loads the
  // prepared workspace.
  _workspaceReset: [
    async ({freshWorkspace, dataServer}, use) => {
      if (freshWorkspace) await resetWorkspace(dataServer);
      else await ensureAnyPage(dataServer);
      await use();
    },
    {auto: true},
  ],

  dataServer: [
    // eslint-disable-next-line no-empty-pattern -- Playwright fixtures take a destructured first arg
    async ({}, use, workerInfo) => {
      // workerIndex (not parallelIndex): when a test fails, Playwright replaces
      // the worker process but keeps its parallel slot — a slot-keyed port
      // would race the just-killed server for the bind and strand the
      // replacement worker. workerIndex is never reused.
      const port = WORKER_BASE_PORT + workerInfo.workerIndex;
      const url = `http://127.0.0.1:${port}`;
      const dataDir = `${WORKER_DATA_DIR_PREFIX}${workerInfo.workerIndex}`;
      rmSync(dataDir, {recursive: true, force: true});

      // Nothing may be listening here already: a leaked server from an
      // interrupted run would pass the health check below and get silently
      // adopted, serving a stale workspace.
      const squatter = await fetch(`${url}/health`).then((r) => r.ok, () => false);
      if (squatter) {
        throw new Error(
          `worker ${workerInfo.workerIndex}: something already serves :${port} — ` +
            'kill leaked servers first: for p in $(seq 4400 4460); do lsof -ti:$p; done | xargs kill',
        );
      }

      // Spawn node directly (tsx via --import). The .bin/tsx wrapper would
      // re-spawn node as ITS child — SIGKILL on the wrapper then orphans the
      // actual server, which is exactly how servers leaked between runs.
      const serverPkg = join(__dirname, '..', '..', 'server');
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', 'src/bin.ts', '--data-dir', dataDir, '--port', String(port)],
        {
          cwd: serverPkg,
          env: {...process.env, OPENBOOK_LOCAL_OWNER_SECRET: LOCAL_OWNER_SECRET},
          stdio: ['ignore', 'ignore', 'pipe'],
        },
      );

      // Capture the child's stderr into a small bounded tail so a boot/import
      // failure (e.g. a missing @book.dev/* dist) is visible in the "data
      // server exited" error below, instead of misleadingly blaming a leaked
      // port. Cap the retained text so a chatty child can't grow it unbounded.
      let stderrTail = '';
      const STDERR_TAIL_MAX = 4000;
      child.stderr?.on('data', (chunk: Buffer) => {
        stderrTail = (stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL_MAX);
      });

      // Wait for OUR server to come up before any test runs in this worker.
      // If the child dies (e.g. the port is held by a leaked server from an
      // interrupted run), fail loudly — a health check alone would silently
      // adopt the squatter and its stale workspace.
      const deadline = Date.now() + 60_000;
      for (;;) {
        if (child.exitCode !== null) {
          const tail = stderrTail.trim();
          throw new Error(
            `worker ${workerInfo.workerIndex}: data server exited (code ${child.exitCode}) — ` +
              `is :${port} held by a leaked server? (lsof -ti:${port} | xargs kill)` +
              (tail ? `\n--- data server stderr (last ${STDERR_TAIL_MAX} chars) ---\n${tail}` : ''),
          );
        }
        try {
          const res = await fetch(`${url}/health`);
          if (res.ok) break;
        } catch {
          // not up yet
        }
        if (Date.now() > deadline) {
          child.kill('SIGKILL');
          throw new Error(`worker ${workerInfo.workerIndex}: data server on :${port} never became healthy`);
        }
        await new Promise((r) => setTimeout(r, 250));
      }

      await use(url);

      child.kill('SIGKILL');
      rmSync(dataDir, {recursive: true, force: true});
    },
    {scope: 'worker', auto: true, timeout: 120_000},
  ],

  // Host-sensitive setup must not run as the unclaimed guest used by ordinary
  // content assertions. This context presents the same per-run local-owner
  // credential as the desktop host's IPC bridge; it is never added to `request`
  // or browser traffic implicitly.
  ownerRequest: [
    async ({dataServer}, use) => {
      const owner = await playwrightRequest.newContext({
        baseURL: dataServer,
        extraHTTPHeaders: {
          'X-OpenBook-Client': '1',
          'X-OpenBook-Local': LOCAL_OWNER_SECRET,
        },
      });
      await use(owner);
      await owner.dispose();
    },
    {scope: 'worker'},
  ],

  // Point every context's app at this worker's server before any page loads.
  context: async ({context, dataServer}, use) => {
    await context.addInitScript((serverUrl: string) => {
      // Init scripts run in EVERY frame, including sandboxed srcdoc iframes
      // (htmlArtifact blocks / SandboxedHtml), where touching localStorage
      // throws a SecurityError under the opaque origin. Swallow it — those
      // frames aren't the app and never read the override.
      try {
        localStorage.setItem('openbook.serverUrl', serverUrl);
      } catch {
        /* sandboxed frame — no storage, nothing to configure */
      }
    }, dataServer);
    await use(context);
  },

  // Uncaught page errors crash React to a blank screen and the test then
  // times out on some unrelated locator — attach them so the report shows
  // the actual crash instead of a mute timeout.
  page: async ({page}, use, testInfo) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.stack ?? err.message));
    await use(page);
    if (errors.length > 0) {
      await testInfo.attach('pageerrors', {body: errors.join('\n\n---\n\n'), contentType: 'text/plain'});
    }
  },
});

export {expect};

/**
 * On the Chromatic/visual job this is the real archiving snapshot; on every
 * functional run it's a no-op, so `@visual` specs can call it freely and still
 * execute as plain functional tests without producing (or depending on) any
 * Chromatic archive. Signature matches the real `takeSnapshot` overloads.
 */
export const takeSnapshot: typeof chromaticTakeSnapshot = ARCHIVE_VISUALS
  ? chromaticTakeSnapshot
  : async () => {};

/**
 * Drive the custom {@link Select} (the Popover-based dropdown that replaced the
 * native `<select>`): open the trigger, then click the option. `chooseValue`
 * targets by the option's `data-value` (mirrors the old `selectOption(value)`);
 * `chooseLabel` targets by its visible text (mirrors `selectOption({label})`).
 *
 * The option is force-clicked once visible: the popover plays an entrance
 * animation, so under parallel-run load Playwright's stability gate can loop on
 * "element is not stable" / "detached" until the test times out. The animation
 * never changes WHICH button sits under the pointer, so skipping the gate is
 * safe — and it makes every Select-driven spec far less flaky.
 */
async function pickOption(page: Page, option: Locator): Promise<void> {
  await option.first().waitFor({state: 'visible'});
  await option.first().click({force: true});
  // Wait for the popover listbox to tear down before returning. The Select
  // opens side=bottom, directly over whatever sits below the trigger (e.g. the
  // "Security updates only" toggle in the Updates settings), so a caller that
  // clicks that control next can otherwise land on the still-mounted listbox
  // and loop until timeout. The Select closes without an exit animation, so in
  // the normal case this resolves immediately.
  await expect(page.locator('[role="option"]')).toHaveCount(0);
}

export async function chooseValue(page: Page, trigger: Locator | string, value: string): Promise<void> {
  const t = typeof trigger === 'string' ? page.locator(trigger) : trigger;
  await t.click();
  await pickOption(page, page.locator(`[role="option"][data-value="${value}"]`));
}

export async function chooseLabel(page: Page, trigger: Locator | string, label: string): Promise<void> {
  const t = typeof trigger === 'string' ? page.locator(trigger) : trigger;
  await t.click();
  await pickOption(page, page.getByRole('option', {name: label, exact: true}));
}
