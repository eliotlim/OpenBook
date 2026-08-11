import {rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {PageStore} from './store';
import {startServer, type RunningServer} from './server';

let server: RunningServer | undefined;
let seq = 0;
const dirs: string[] = [];

const waitFor = async (condition: () => void, timeoutMs = 2_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      condition();
      return;
    } catch (err) {
      if (Date.now() >= deadline) throw err;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
};

const boot = async (catchUpDelayMs: number): Promise<RunningServer> => {
  const dataDir = join(tmpdir(), `ob-backup-boot-${process.pid}-${seq += 1}`);
  dirs.push(dataDir);
  return startServer({
    dataDir,
    host: '127.0.0.1',
    port: 0,
    backupCatchUpDelayMs: catchUpDelayMs,
    trashCleanupIntervalMs: 0,
    maintenanceIntervalMs: 0,
  });
};

afterEach(async () => {
  await server?.close();
  server = undefined;
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, {recursive: true, force: true})));
});

describe('scheduled backup boot ordering (BOOT-1)', () => {
  it('binds and serves before export starts, then catches up after the configured idle delay', async () => {
    const order: string[] = [];
    const materialized = vi.spyOn(PageStore.prototype, 'exportAll');
    const original = PageStore.prototype.exportAllTo;
    const exported = vi.spyOn(PageStore.prototype, 'exportAllTo').mockImplementation(async function (this: PageStore, ...args) {
      order.push('exportAllTo');
      return original.apply(this, args);
    });

    const startedAt = Date.now();
    server = await boot(25);
    order.push('listening');

    expect(materialized).not.toHaveBeenCalled();
    expect(exported).not.toHaveBeenCalled();
    expect(await (await fetch(`${server.url}/health`)).text()).toBe('ok');
    await waitFor(() => expect(exported).toHaveBeenCalled());

    expect(order.indexOf('listening')).toBeLessThan(order.indexOf('exportAllTo'));
    expect(Date.now() - startedAt).toBeLessThan(60_000);
  });

  it('keeps serving when the deferred catch-up export throws', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exported = vi.spyOn(PageStore.prototype, 'exportAllTo').mockRejectedValueOnce(new Error('injected export fault'));

    server = await boot(0);
    expect(await (await fetch(`${server.url}/health`)).text()).toBe('ok');
    await waitFor(() => expect(exported).toHaveBeenCalled());
    await waitFor(() => expect(errorLog).toHaveBeenCalledWith('OpenBook scheduled backup failed:', expect.any(Error)));

    expect(await (await fetch(`${server.url}/health`)).text()).toBe('ok');
  });
});
