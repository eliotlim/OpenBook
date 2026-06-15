import {spawn} from 'node:child_process';
import {rmSync} from 'node:fs';
import {join} from 'node:path';
import {test as base} from '@chromatic-com/playwright';
import type {Locator, Page} from '@playwright/test';

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
 * same port from `TEST_PARALLEL_INDEX` for API seeding.
 */

export const WORKER_BASE_PORT = 4400;

type WorkerFixtures = {
  /** This worker's data-server URL; starting it is the fixture's job. */
  dataServer: string;
};

export const test = base.extend<NonNullable<unknown>, WorkerFixtures>({
  dataServer: [
    // eslint-disable-next-line no-empty-pattern -- Playwright fixtures take a destructured first arg
    async ({}, use, workerInfo) => {
      // workerIndex (not parallelIndex): when a test fails, Playwright replaces
      // the worker process but keeps its parallel slot — a slot-keyed port
      // would race the just-killed server for the bind and strand the
      // replacement worker. workerIndex is never reused.
      const port = WORKER_BASE_PORT + workerInfo.workerIndex;
      const url = `http://127.0.0.1:${port}`;
      const dataDir = `/tmp/openbook-web-e2e-data-w${workerInfo.workerIndex}`;
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
        {cwd: serverPkg, stdio: 'ignore'},
      );

      // Wait for OUR server to come up before any test runs in this worker.
      // If the child dies (e.g. the port is held by a leaked server from an
      // interrupted run), fail loudly — a health check alone would silently
      // adopt the squatter and its stale workspace.
      const deadline = Date.now() + 60_000;
      for (;;) {
        if (child.exitCode !== null) {
          throw new Error(
            `worker ${workerInfo.workerIndex}: data server exited (code ${child.exitCode}) — ` +
              `is :${port} held by a leaked server? (lsof -ti:${port} | xargs kill)`,
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

  // Point every context's app at this worker's server before any page loads.
  context: async ({context, dataServer}, use) => {
    await context.addInitScript((serverUrl: string) => {
      localStorage.setItem('openbook.serverUrl', serverUrl);
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

export {expect, takeSnapshot} from '@chromatic-com/playwright';

/**
 * Drive the custom {@link Select} (the Popover-based dropdown that replaced the
 * native `<select>`): open the trigger, then click the option. `chooseValue`
 * targets by the option's `data-value` (mirrors the old `selectOption(value)`);
 * `chooseLabel` targets by its visible text (mirrors `selectOption({label})`).
 */
export async function chooseValue(page: Page, trigger: Locator | string, value: string): Promise<void> {
  const t = typeof trigger === 'string' ? page.locator(trigger) : trigger;
  await t.click();
  await page.locator(`[role="option"][data-value="${value}"]`).click();
}

export async function chooseLabel(page: Page, trigger: Locator | string, label: string): Promise<void> {
  const t = typeof trigger === 'string' ? page.locator(trigger) : trigger;
  await t.click();
  await page.getByRole('option', {name: label, exact: true}).click();
}
