/**
 * Ledger auto-export (LGR-7 insurance).
 *
 * Pins:
 *  - a ledger mutation arms the debounce; further mutations RE-arm it (fake
 *    timers — injected, never real); firing writes the canonical CSV to the
 *    configured path, byte-identical to the on-demand export;
 *  - atomic write: an injected rename failure leaves NO partial file at the
 *    target (and no stray .tmp), and routes the error to onError;
 *  - unset path (the default) ⇒ every trigger is a silent no-op: nothing is
 *    written, nothing throws;
 *  - `ledgerAutoExportPath` is owner-only on a claimed instance: a non-owner
 *    verified identity gets 403, the owner 200 (and a bad value 400).
 */

import {existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {
  mintIdentityKeypair,
  signIdentity,
  type IdentityClaims,
  type IdentityKeypair,
} from '@book.dev/sdk';
import {PgliteDb} from './db';
import {PageStore} from './store';
import {PageHub} from './hub';
import {createApp} from './app';
import {IdentityService} from './instanceConfig';
import {IDENTITY_HEADER} from './principal';
import {fenceExportPath, LedgerAutoExporter} from './ledgerAutoExport';
import type {UnrefTimer} from './parentDeath';

/** Deterministic manual timers — the injectable-timer pattern (parentDeath). */
class FakeTimers {
  pending: (() => void) | null = null;
  setCalls = 0;
  clearCalls = 0;
  lastDelay = -1;
  readonly set = (cb: () => void, ms: number): UnrefTimer => {
    this.setCalls += 1;
    this.lastDelay = ms;
    this.pending = cb;
    return {unref: () => {}};
  };
  readonly clear = (): void => {
    this.clearCalls += 1;
    this.pending = null;
  };
  fire(): void {
    const cb = this.pending;
    this.pending = null;
    cb?.();
  }
}

let store: PageStore;
let dir: string;
let cashId: string;
let incomeId: string;

beforeEach(async () => {
  dir = join(tmpdir(), `ob-lgr7-auto-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, {recursive: true});
  store = new PageStore(await PgliteDb.create('memory://'));
  await store.migrate();
  await store.ledger.ensureSetup();
  cashId = (await store.ledger.createAccount({name: 'Assets:Cash', type: 'asset'})).id;
  incomeId = (await store.ledger.createAccount({name: 'Revenue', type: 'revenue'})).id;
});

afterEach(async () => {
  await store.close();
  rmSync(dir, {recursive: true, force: true});
});

const postOne = async (): Promise<void> => {
  const draft = await store.ledger.createDraft({
    date: '2026-08-01',
    description: 'Sale',
    postings: [
      {accountId: cashId, amountMinor: 100},
      {accountId: incomeId, amountMinor: -100},
    ],
  });
  await store.ledger.post(draft.id);
};

describe('LGR-7 — ledger auto-export', () => {
  it('debounces mutations, then atomically writes the canonical CSV to the configured path', async () => {
    const target = join(dir, 'ledger.csv');
    await store.updateInstanceConfig({ledgerAutoExportPath: target});
    const timers = new FakeTimers();
    const exporter = new LedgerAutoExporter(store, {
      allowRoots: [dir],
      setTimeoutImpl: timers.set,
      clearTimeoutImpl: timers.clear,
    });
    exporter.start();

    await postOne(); // createDraft + post = two mutations → armed, then re-armed
    expect(timers.setCalls).toBe(2);
    expect(timers.clearCalls).toBe(1); // the second mutation cancelled the first timer
    expect(existsSync(target)).toBe(false); // nothing until the quiet window elapses

    timers.fire();
    expect(await exporter.flush()).toBe(target);
    const written = readFileSync(target);
    const canonical = Buffer.from(await store.ledger.exportPostingsCsv(), 'utf8');
    expect(written.equals(canonical)).toBe(true);
    // The temp file is renamed away, never left behind (unpredictable name).
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    // 0600 — the book is financial data, never world-readable.
    expect(statSync(target).mode & 0o777).toBe(0o600);
    exporter.stop();
  });

  it('REFUSES a target outside the allowed roots — traversal, absolute escape, relative', async () => {
    const timers = new FakeTimers();
    const errors: unknown[] = [];
    const outside = join(dir, 'outside');
    mkdirSync(outside, {recursive: true});
    const root = join(dir, 'allowed');
    mkdirSync(root, {recursive: true});
    // The lookalike dir must EXIST, so the refusal is the prefix check itself
    // rather than the missing-parent refusal.
    mkdirSync(`${root}-evil`, {recursive: true});

    for (const bad of [
      '/etc/passwd',
      join(root, '..', 'outside', 'stolen.csv'), // traversal back out
      `${root}-evil/ledger.csv`, // root-prefix lookalike, not a child
      'relative/ledger.csv', // not absolute
    ]) {
      await store.updateInstanceConfig({ledgerAutoExportPath: bad});
      const exporter = new LedgerAutoExporter(store, {
        allowRoots: [root],
        setTimeoutImpl: timers.set,
        clearTimeoutImpl: timers.clear,
        onError: (err) => errors.push(err),
      });
      expect(await exporter.runExport()).toBeNull();
    }
    expect(errors).toHaveLength(4);
    // Refused VISIBLY (never a silent no-op), and nothing was written anywhere.
    expect(errors.every((e) => /outside the allowed export roots|must be an absolute path/.test(String(e)))).toBe(true);
    expect(existsSync(join(outside, 'stolen.csv'))).toBe(false);
    expect(readdirSync(root)).toEqual([]);
  });

  it('REFUSES an intermediate DIRECTORY symlink that escapes the root (lexical fence bypass)', async () => {
    // A purely lexical prefix check passes `<root>/sub/victim.csv` while the
    // bytes land on `/outside/victim.csv`, and the writer's O_NOFOLLOW only
    // guards the FINAL component — so it cannot catch this. Both sides must be
    // resolved through realpath.
    const root = join(dir, 'allowed');
    const outside = join(dir, 'outside');
    mkdirSync(root, {recursive: true});
    mkdirSync(outside, {recursive: true});
    symlinkSync(outside, join(root, 'sub')); // <root>/sub -> <dir>/outside

    const errors: unknown[] = [];
    await store.updateInstanceConfig({ledgerAutoExportPath: join(root, 'sub', 'victim.csv')});
    const exporter = new LedgerAutoExporter(store, {allowRoots: [root], onError: (err) => errors.push(err)});
    expect(await exporter.runExport()).toBeNull();
    expect(String(errors[0])).toContain('outside the allowed export roots');
    // Nothing landed on the far side of the link, by either name.
    expect(readdirSync(outside)).toEqual([]);

    // A parent that does not exist at all is likewise a refusal (fail closed) —
    // the parent must exist for the write to succeed anyway.
    await store.updateInstanceConfig({ledgerAutoExportPath: join(root, 'no', 'such', 'dir', 'l.csv')});
    expect(await exporter.runExport()).toBeNull();
    expect(String(errors[1])).toContain('no resolvable parent directory');
  });

  it('a SYMLINKED root and its realpath both resolve to the same fence (no asymmetry)', async () => {
    // `/link -> /real`: before realpath'ing both sides, `/link/a.csv` was
    // allowed while `/real/a.csv` — the very same file — was refused.
    const real = join(dir, 'real');
    const link = join(dir, 'link');
    mkdirSync(real, {recursive: true});
    symlinkSync(real, link);

    for (const [root, target] of [
      [link, join(link, 'a.csv')],
      [link, join(real, 'a.csv')],
      [real, join(link, 'a.csv')],
    ]) {
      await store.updateInstanceConfig({ledgerAutoExportPath: target});
      const exporter = new LedgerAutoExporter(store, {allowRoots: [root]});
      expect(await exporter.runExport()).toBe(target);
      rmSync(target, {force: true});
    }
  });

  it('a root of "/" OPENS the fence instead of disabling the export', () => {
    // `abs.startsWith(base + sep)` with `base === '/'` is `startsWith('//')`,
    // which no normal absolute path satisfies — so `--ledger-export-root /`
    // used to refuse EVERY path (fail-closed, but the opposite of what the
    // operator asked for, and visible only as a per-attempt console.error).
    expect(fenceExportPath('/etc/passwd', ['/'])).toBe('/etc/passwd');
  });

  it('fails closed when no roots are configured at all', async () => {
    const errors: unknown[] = [];
    await store.updateInstanceConfig({ledgerAutoExportPath: join(dir, 'ledger.csv')});
    const exporter = new LedgerAutoExporter(store, {allowRoots: [], onError: (err) => errors.push(err)});
    expect(await exporter.runExport()).toBeNull();
    expect(String(errors[0])).toContain('none configured');
  });

  it('a pre-planted symlink at the temp path cannot hijack the write', async () => {
    // The classic co-tenant attack against a PREDICTABLE `<target>.tmp`: plant a
    // symlink there and the write follows it, then rename moves the link into
    // place. The temp name is randomized AND opened O_EXCL|O_NOFOLLOW, so even
    // when we plant the old predictable name the victim file is untouched.
    const target = join(dir, 'ledger.csv');
    const victim = join(dir, 'victim.txt');
    writeFileSync(victim, 'original contents');
    symlinkSync(victim, `${target}.tmp`);
    await store.updateInstanceConfig({ledgerAutoExportPath: target});

    const exporter = new LedgerAutoExporter(store, {allowRoots: [dir]});
    expect(await exporter.runExport()).toBe(target);
    expect(readFileSync(victim, 'utf8')).toBe('original contents'); // never written through
    expect(readFileSync(target, 'utf8')).toContain('entry_no,transaction_id');
  });

  it('injected rename failure leaves NO partial target file and reports via onError', async () => {
    const target = join(dir, 'ledger.csv');
    await store.updateInstanceConfig({ledgerAutoExportPath: target});
    const errors: unknown[] = [];
    const exporter = new LedgerAutoExporter(store, {
      allowRoots: [dir],
      writer: {
        writeTemp: async (tmp, data) => {
          writeFileSync(tmp, data);
        },
        commit: async () => {
          throw new Error('disk detached mid-rename');
        },
      },
      onError: (err) => errors.push(err),
    });
    expect(await exporter.runExport()).toBeNull();
    expect(existsSync(target)).toBe(false); // never a partial/truncated target
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]); // temp cleaned up
    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toContain('disk detached');
  });

  it('injected WRITE failure leaves nothing behind and reports via onError', async () => {
    const target = join(dir, 'ledger.csv');
    await store.updateInstanceConfig({ledgerAutoExportPath: target});
    const errors: unknown[] = [];
    const exporter = new LedgerAutoExporter(store, {
      allowRoots: [dir],
      writer: {
        writeTemp: async (tmp, data) => {
          writeFileSync(tmp, data.slice(0, 10)); // a partial write, then…
          throw new Error('ENOSPC: no space left on device');
        },
        commit: async () => {
          throw new Error('commit must never run after a failed write');
        },
      },
      onError: (err) => errors.push(err),
    });
    expect(await exporter.runExport()).toBeNull();
    expect(existsSync(target)).toBe(false);
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]); // partial temp removed
    expect(String(errors[0])).toContain('ENOSPC');
  });

  it('overlapping runs are CHAINED — never two bodies in flight at once', async () => {
    const target = join(dir, 'ledger.csv');
    await store.updateInstanceConfig({ledgerAutoExportPath: target});
    const timers = new FakeTimers();
    let active = 0;
    let maxActive = 0;
    const gates: Array<() => void> = [];
    const exporter = new LedgerAutoExporter(store, {
      allowRoots: [dir],
      setTimeoutImpl: timers.set,
      clearTimeoutImpl: timers.clear,
      writer: {
        writeTemp: async (tmp, data) => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise<void>((release) => gates.push(release));
          writeFileSync(tmp, data);
          active -= 1;
        },
        commit: async (tmp, dest) => {
          renameSync(tmp, dest);
        },
      },
    });
    exporter.start();

    await postOne();
    timers.fire(); // run 1 starts and blocks on its gate
    await postOne();
    timers.fire(); // run 2 must WAIT for run 1, not interleave
    await new Promise((r) => setTimeout(r, 10));
    expect(maxActive).toBe(1);
    while (gates.length > 0) {
      gates.shift()?.();
      await new Promise((r) => setTimeout(r, 5));
    }
    await exporter.flush();
    expect(maxActive).toBe(1); // strictly serialized start to finish
    expect(existsSync(target)).toBe(true);
    exporter.stop();
  });

  it('a mutation arriving DURING a run is QUEUED, not dropped — and the successor reads fresh data', async () => {
    // The chain is collapsed to depth 1, but the slot must be released when the
    // successor STARTS, not when it finishes. Releasing on completion is DROP
    // semantics: this second mutation would find the flag still set, return
    // early, and never export — so once writes stopped, the final state would
    // never reach the file. That is the insurance failure, not a saved fsync.
    const target = join(dir, 'ledger.csv');
    await store.updateInstanceConfig({ledgerAutoExportPath: target});
    const timers = new FakeTimers();
    const seen: string[] = []; // the CSV each run actually built
    const gates: Array<() => void> = [];
    const waitFor = async (cond: () => boolean, what: string): Promise<void> => {
      for (let i = 0; i < 200; i += 1) {
        if (cond()) return;
        await new Promise((r) => setTimeout(r, 5));
      }
      throw new Error(`timed out waiting for ${what}`);
    };
    const exporter = new LedgerAutoExporter(store, {
      allowRoots: [dir],
      setTimeoutImpl: timers.set,
      clearTimeoutImpl: timers.clear,
      writer: {
        writeTemp: async (tmp, data) => {
          seen.push(data);
          await new Promise<void>((release) => gates.push(release));
          writeFileSync(tmp, data);
        },
        commit: async (tmp, dest) => {
          renameSync(tmp, dest);
        },
      },
    });
    exporter.start();

    await postOne(); // entry 1
    timers.fire(); // run 1 starts and blocks inside the writer
    await waitFor(() => gates.length === 1, 'run 1 to reach the writer');
    expect(seen).toHaveLength(1);

    // A mutation lands while run 1 is STILL in flight.
    await postOne(); // entry 2
    timers.fire(); // must chain a successor behind run 1, never drop it
    await new Promise((r) => setTimeout(r, 10));
    expect(seen).toHaveLength(1); // correctly still waiting — never interleaved

    gates.shift()?.(); // release run 1
    await waitFor(() => gates.length === 1, 'the QUEUED run 2 to execute');
    expect(seen).toHaveLength(2); // the second mutation was NOT dropped
    gates.shift()?.();
    expect(await exporter.flush()).toBe(target);

    // Run 2 read the ledger FRESH once run 1 settled: 2 postings then 4.
    const dataRows = (csv: string): number => csv.trim().split('\n').length - 1;
    expect(dataRows(seen[0])).toBe(2);
    expect(dataRows(seen[1])).toBe(4);
    expect(readFileSync(target, 'utf8')).toBe(seen[1]); // the newer state won
    exporter.stop();
  });

  it('a continuously-written book still exports: the debounce has a max-wait ceiling', async () => {
    const target = join(dir, 'ledger.csv');
    await store.updateInstanceConfig({ledgerAutoExportPath: target});
    const timers = new FakeTimers();
    let clock = 1_000_000;
    const exporter = new LedgerAutoExporter(store, {
      allowRoots: [dir],
      debounceMs: 2_000,
      maxWaitMs: 5_000,
      now: () => clock,
      setTimeoutImpl: timers.set,
      clearTimeoutImpl: timers.clear,
    });
    exporter.start();

    // A write every 1s forever: each re-arms the debounce, so without a ceiling
    // the export would NEVER run — the insurance failure.
    await postOne(); // t=0 → first pending
    expect(timers.lastDelay).toBe(2_000);
    for (const elapsed of [1_000, 2_000, 3_000, 4_000]) {
      clock = 1_000_000 + elapsed;
      await postOne();
      // The scheduled delay is clamped to what remains of the 5s ceiling.
      expect(timers.lastDelay).toBe(Math.min(2_000, 5_000 - elapsed));
    }
    clock = 1_000_000 + 5_000;
    await postOne();
    expect(timers.lastDelay).toBe(0); // ceiling reached — fire on the next tick
    timers.fire();
    expect(await exporter.flush()).toBe(target);
    expect(existsSync(target)).toBe(true);
    exporter.stop();
  });

  it('unset path (default) ⇒ silent no-op: no writes, no errors', async () => {
    const errors: unknown[] = [];
    const timers = new FakeTimers();
    const writes: string[] = [];
    const exporter = new LedgerAutoExporter(store, {
      allowRoots: [dir],
      setTimeoutImpl: timers.set,
      clearTimeoutImpl: timers.clear,
      writer: {
        writeTemp: async (tmp) => {
          writes.push(tmp);
        },
        commit: async () => {},
      },
      onError: (err) => errors.push(err),
    });
    exporter.start();
    await postOne();
    timers.fire();
    expect(await exporter.flush()).toBeNull();
    expect(writes).toEqual([]);
    expect(errors).toEqual([]);
    exporter.stop();
  });

  it('stop() cancels a pending debounce and detaches from mutations', async () => {
    await store.updateInstanceConfig({ledgerAutoExportPath: join(dir, 'ledger.csv')});
    const timers = new FakeTimers();
    const exporter = new LedgerAutoExporter(store, {setTimeoutImpl: timers.set, clearTimeoutImpl: timers.clear});
    exporter.start();
    await postOne();
    expect(timers.pending).not.toBeNull();
    exporter.stop();
    expect(timers.pending).toBeNull(); // pending debounce cancelled
    const armed = timers.setCalls;
    await postOne();
    expect(timers.setCalls).toBe(armed); // detached — no re-arm after stop
  });

  it('an UNCLAIMED instance refuses the path from anyone — no owner, no setter', async () => {
    // The S1 hole: the general policy gate only engages once `ownerSubject` is
    // set, so on an unclaimed instance (the documented headless --access-token
    // LAN posture) an ANONYMOUS caller could point the export at any file.
    const app = createApp(store, undefined, new PageHub(), {identity: new IdentityService(store)});
    const victim = join(dir, 'victim.txt');
    writeFileSync(victim, 'original contents');
    expect((await store.getInstanceConfig()).ownerSubject).toBeUndefined(); // unclaimed

    const res = await app.request('/api/instance', {
      method: 'PUT',
      headers: {'Content-Type': 'application/json', 'X-OpenBook-Client': '1'},
      body: JSON.stringify({ledgerAutoExportPath: victim}),
    });
    expect(res.status).toBe(403);
    expect((await store.getInstanceConfig()).ledgerAutoExportPath).toBeUndefined();

    // …and it cannot ride in on the one-time ownership CLAIM either.
    const kp = await mintIdentityKeypair('k-unclaimed');
    await store.updateInstanceConfig({trustedIssuers: [{issuer: 'https://account.book.pub', jwks: {keys: [kp.publicJwk]}}]});
    const jws = await signIdentity(
      kp.privateKey,
      {
        iss: 'https://account.book.pub',
        sub: 'claimer',
        name: 'claimer',
        iat: Math.floor(Date.now() / 1000) - 30,
        exp: Math.floor(Date.now() / 1000) + 3600,
        jti: 'jti-claimer',
      },
      kp.publicJwk.kid,
    );
    const claim = await app.request('/api/instance', {
      method: 'PUT',
      headers: {'Content-Type': 'application/json', 'X-OpenBook-Client': '1', [IDENTITY_HEADER]: jws},
      body: JSON.stringify({ownerSubject: 'https://account.book.pub#claimer', ledgerAutoExportPath: victim}),
    });
    expect(claim.status).toBe(403);
    expect((await store.getInstanceConfig()).ledgerAutoExportPath).toBeUndefined();
    expect(readFileSync(victim, 'utf8')).toBe('original contents');
  });

  it('ledgerAutoExportPath is owner-only once claimed (403 non-owner, 200 owner, 400 bad value)', async () => {
    const ISS = 'https://account.book.pub';
    const kp: IdentityKeypair = await mintIdentityKeypair('k1');
    await store.updateInstanceConfig({trustedIssuers: [{issuer: ISS, jwks: {keys: [kp.publicJwk]}}]});
    await store.claimOwnership(`${ISS}#owner`);
    const app = createApp(store, undefined, new PageHub(), {identity: new IdentityService(store)});

    const idFor = (sub: string, over: Partial<IdentityClaims> = {}): Promise<string> =>
      signIdentity(
        kp.privateKey,
        {
          iss: ISS,
          sub,
          name: sub,
          iat: Math.floor(Date.now() / 1000) - 30,
          exp: Math.floor(Date.now() / 1000) + 3600,
          jti: `jti-${sub}`,
          ...over,
        },
        kp.publicJwk.kid,
      );
    const put = async (jws: string | null, body: unknown): Promise<Response> =>
      app.request('/api/instance', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'X-OpenBook-Client': '1',
          ...(jws ? {[IDENTITY_HEADER]: jws} : {}),
        },
        body: JSON.stringify(body),
      });

    const target = join(dir, 'ledger.csv');
    // A verified NON-owner may not point the server's export path anywhere.
    expect((await put(await idFor('mallory'), {ledgerAutoExportPath: target})).status).toBe(403);
    // An anonymous guest may not either.
    expect((await put(null, {ledgerAutoExportPath: target})).status).toBe(403);
    // A malformed value is rejected before any merge (owner sends it).
    expect((await put(await idFor('owner'), {ledgerAutoExportPath: 42})).status).toBe(400);
    expect((await put(await idFor('owner'), {ledgerAutoExportPath: '  '})).status).toBe(400);
    // The owner sets it; it persists; null clears it (off).
    const ok = await put(await idFor('owner'), {ledgerAutoExportPath: target});
    expect(ok.status).toBe(200);
    expect((await store.getInstanceConfig()).ledgerAutoExportPath).toBe(target);
    expect((await put(await idFor('owner'), {ledgerAutoExportPath: null})).status).toBe(200);
    expect((await store.getInstanceConfig()).ledgerAutoExportPath).toBeNull();

    // S4 — the change is VISIBLE three ways: the edit log, the ledger's own
    // append-only audit, and `GET /api/instance` for whoever may see it.
    // (the edit log is written fire-and-forget, so give it a tick to land)
    await new Promise((r) => setTimeout(r, 50));
    const policyEdits = (await store.listEdits(undefined, 50)).filter((e) => e.kind === 'instance.policy');
    expect(policyEdits.some((e) => e.summary.includes('ledgerAutoExportPath=set'))).toBe(true);
    expect(policyEdits.some((e) => e.summary.includes('ledgerAutoExportPath=cleared'))).toBe(true);

    const audit = await store.ledger.listAudit({limit: 50});
    const pathEvents = audit.filter((e) => e.action === 'ledger.autoExportPath');
    expect(pathEvents).toHaveLength(2); // set, then cleared
    expect(pathEvents[0].payload.path).toBeNull(); // newest first: the clear
    expect(pathEvents[1].payload.path).toBe(target);
    expect(pathEvents[1].actorSubject).toBe(`${ISS}#owner`);
    // The verifier still reports a clean book with these policy events present.
    expect((await store.verifyLedger()).findings).toEqual([]);

    await put(await idFor('owner'), {ledgerAutoExportPath: target});
    const info = await (
      await app.request('/api/instance', {headers: {'X-OpenBook-Client': '1', [IDENTITY_HEADER]: await idFor('owner')}})
    ).json();
    expect(info.ledgerAutoExportPath).toBe(target);
    // …but a claimed instance never shows it to an anonymous caller.
    const anon = await (await app.request('/api/instance', {headers: {'X-OpenBook-Client': '1'}})).json();
    expect(anon.ledgerAutoExportPath).toBeNull();
  });
});
