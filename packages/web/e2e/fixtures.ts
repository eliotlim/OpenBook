import {spawn} from 'node:child_process';
import {rmSync} from 'node:fs';
import {join} from 'node:path';
import {test as base} from '@chromatic-com/playwright';

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

      const serverPkg = join(__dirname, '..', '..', 'server');
      const child = spawn(
        join(serverPkg, 'node_modules', '.bin', 'tsx'),
        ['src/bin.ts', '--data-dir', dataDir, '--port', String(port)],
        {cwd: serverPkg, stdio: 'ignore'},
      );

      // Wait for the server to come up before any test runs in this worker.
      const deadline = Date.now() + 60_000;
      for (;;) {
        try {
          const res = await fetch(`${url}/health`);
          if (res.ok) break;
        } catch {
          // not up yet
        }
        if (Date.now() > deadline) {
          child.kill('SIGKILL');
          throw new Error(`worker ${workerInfo.parallelIndex}: data server on :${port} never became healthy`);
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
});

export {expect, takeSnapshot} from '@chromatic-com/playwright';
