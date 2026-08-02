/**
 * `openbook-server --verify-ledger` CLI behaviour (LGR-7 Q4).
 *
 * Pins the two failure modes that made the flag unsafe to run twice:
 *  - it must RELEASE the PGlite dir lock (a `process.exit()` inside the `try`
 *    skipped the `finally`, stranding `.openbook-pglite.lock` — and `dirLock`
 *    refuses a cross-host takeover, so one verify run on a synced folder could
 *    permanently block another machine);
 *  - a data dir with no `PG_VERSION` must be REFUSED, not silently created and
 *    then reported "no ledger — trivially clean" (a typo'd `--data-dir` would
 *    otherwise return a reassuring exit 0).
 *
 * Driven as a child process because the flag's contract IS the exit code.
 */

import {execFile} from 'node:child_process';
import {existsSync, mkdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {afterEach, describe, expect, it} from 'vitest';
import {PgliteDb} from './db';
import {PageStore} from './store';

const run = promisify(execFile);
const BIN = fileURLToPath(new URL('./bin.ts', import.meta.url));
const TSX = fileURLToPath(new URL('../node_modules/.bin/tsx', import.meta.url));

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, {recursive: true, force: true});
  dirs = [];
});

const scratch = (label: string): string => {
  const dir = join(tmpdir(), `ob-lgr7-cli-${label}-${process.pid}-${Date.now()}`);
  dirs.push(dir);
  return dir;
};

/** Run the CLI; resolve with its exit code + stdout (never throws on non-zero). */
async function verifyLedgerCli(dataDir: string, extraArgs: string[] = []): Promise<{code: number; stdout: string; stderr: string}> {
  try {
    const {stdout, stderr} = await run(TSX, [BIN, '--data-dir', dataDir, '--verify-ledger', ...extraArgs], {timeout: 120_000});
    return {code: 0, stdout, stderr};
  } catch (err) {
    const e = err as {code?: number; stdout?: string; stderr?: string};
    return {code: e.code ?? -1, stdout: e.stdout ?? '', stderr: e.stderr ?? ''};
  }
}

describe('LGR-7 — --verify-ledger CLI', () => {
  it('verifies a real book, exits 0 CLEAN, and RELEASES the PGlite dir lock', async () => {
    const dir = scratch('clean');
    const store = new PageStore(await PgliteDb.create(dir));
    await store.migrate();
    await store.ledger.ensureSetup();
    const cash = await store.ledger.createAccount({name: 'Assets:Cash', type: 'asset'});
    const rev = await store.ledger.createAccount({name: 'Revenue', type: 'revenue'});
    const draft = await store.ledger.createDraft({
      date: '2026-08-01',
      description: 'CLI book',
      postings: [
        {accountId: cash.id, amountMinor: 500},
        {accountId: rev.id, amountMinor: -500},
      ],
    });
    await store.ledger.post(draft.id);
    await store.close();

    const first = await verifyLedgerCli(dir);
    expect(first.code).toBe(0);
    expect(JSON.parse(first.stdout)).toMatchObject({initialized: true, findings: []});
    // The lock must be gone — otherwise the NEXT run (or another machine on a
    // synced folder) is blocked forever.
    expect(existsSync(join(dir, '.openbook-pglite.lock'))).toBe(false);

    // Proof it is really re-runnable, which is what the leak broke.
    const second = await verifyLedgerCli(dir);
    expect(second.code).toBe(0);
  }, 180_000);

  it('refuses a directory that is not an OpenBook data dir (never a false "clean")', async () => {
    const dir = scratch('typo');
    mkdirSync(dir, {recursive: true});
    const {code, stderr} = await verifyLedgerCli(join(dir, 'oops-typo'));
    expect(code).toBe(2); // not 0 — a typo must never read as a clean book
    expect(stderr).toContain('not an OpenBook data directory');
    expect(existsSync(join(dir, 'oops-typo', 'PG_VERSION'))).toBe(false); // created nothing
  }, 120_000);

  it('advisory-only exits 0 (printed, not failed); --fail-on-advisory exits 1; tamper exits 1 (LGR-14 Q3)', async () => {
    // The book every backup-verification script will eventually hold: healthy,
    // with `evidenceRequired` enabled over bare history — the state the
    // current-policy advisory reports BY DESIGN. Exit 1 here would turn the
    // insurance pipeline permanently red the day the toggle flips, and a
    // permanently red alarm is an ignored one; the JSON still carries the
    // finding for anyone who reads the report.
    const dir = scratch('advisory');
    const store = new PageStore(await PgliteDb.create(dir));
    await store.migrate();
    await store.ledger.ensureSetup();
    const cash = await store.ledger.createAccount({name: 'Assets:Cash', type: 'asset'});
    const rev = await store.ledger.createAccount({name: 'Revenue', type: 'revenue'});
    const draft = await store.ledger.createDraft({
      date: '2026-08-01',
      description: 'Bare history',
      postings: [
        {accountId: cash.id, amountMinor: 500},
        {accountId: rev.id, amountMinor: -500},
      ],
    });
    const posted = await store.ledger.post(draft.id);
    await store.ledger.updateAccount(cash.id, {evidenceRequired: true});
    await store.close();

    const advisoryOnly = await verifyLedgerCli(dir);
    expect(advisoryOnly.code).toBe(0);
    const report = JSON.parse(advisoryOnly.stdout) as {findings: Array<{code: string}>};
    expect(report.findings.map((f) => f.code)).toEqual(['evidence-required-missing']); // printed, not swallowed
    expect(advisoryOnly.stderr).toContain('policy advisory finding(s), no tamper findings');

    // Strict callers can opt back into the old behaviour.
    const strict = await verifyLedgerCli(dir, ['--fail-on-advisory']);
    expect(strict.code).toBe(1);
    expect(strict.stderr).toContain('--fail-on-advisory');

    // A TAMPER finding on the same book still fails the run — the advisory
    // band must never soften the tamper band. Doctor the posted description
    // out-of-band (the classic posted-hash-mismatch corruption).
    const db2 = await PgliteDb.create(dir);
    const rows = await db2.query<{properties: Record<string, unknown> | string}>('SELECT properties FROM pages WHERE id = $1', [posted.id]);
    const props = typeof rows[0].properties === 'string' ? JSON.parse(rows[0].properties) as Record<string, unknown> : rows[0].properties;
    props.lp_description = 'doctored';
    await db2.query('UPDATE pages SET properties = $2::jsonb WHERE id = $1', [posted.id, JSON.stringify(props)]);
    await db2.close();

    const tampered = await verifyLedgerCli(dir);
    expect(tampered.code).toBe(1);
    expect(tampered.stderr).toMatch(/tamper finding/);
  }, 240_000);
});
