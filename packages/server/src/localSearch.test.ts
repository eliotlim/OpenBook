import {rmSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import type {PageSnapshot} from '@book.dev/sdk';
import {PgliteDb} from './db';
import {PageStore} from './store';
import {LocalDataClient} from './localClient';

// Epic 3 / 3.1 — in-webview lexical content search. The web/desktop-local build
// runs LocalDataClient, whose aiSearch/aiIndex used to be empty stubs — so the
// pure-PGlite transport had no body search. These tests pin the unstubbed
// behaviour: content is findable, results deep-link data is present, the index
// stays fresh across writes, and an empty query is a no-op.

let seq = 0;
const dirs: string[] = [];
const stores: PageStore[] = [];

async function freshClient(): Promise<LocalDataClient> {
  seq += 1;
  const dir = join(tmpdir(), `ob-localsearch-${process.pid}-${seq}`);
  rmSync(dir, {recursive: true, force: true});
  dirs.push(dir);
  const store = new PageStore(await PgliteDb.create(dir));
  await store.migrate();
  stores.push(store);
  return new LocalDataClient(store);
}

afterEach(async () => {
  for (const s of stores.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, {recursive: true, force: true});
});

const snapshot = (text: string): PageSnapshot => ({
  editorjs: {blocks: [{id: 'b1', type: 'paragraph', data: {text}}]},
  values: [],
  names: [],
});

describe('LocalDataClient content search (Epic 3.1)', () => {
  it('finds a page by its body text, not just its title', async () => {
    const client = await freshClient();
    await client.savePage({id: randomUUID(), name: 'Groceries', data: snapshot('buy avocados and sourdough')});
    const target = randomUUID();
    await client.savePage({id: target, name: 'Trip', data: snapshot('the ferry to Penang leaves at noon')});

    const res = await client.aiSearch('penang ferry');
    expect(res.mode).toBe('lexical');
    expect(res.results[0]?.pageId).toBe(target);
    expect(res.results[0]?.snippet.toLowerCase()).toContain('penang');
  });

  it('returns nothing for a blank query without touching the index', async () => {
    const client = await freshClient();
    await client.savePage({id: randomUUID(), name: 'x', data: snapshot('anything')});
    expect(await client.aiSearch('   ')).toEqual({results: [], mode: 'lexical'});
  });

  it('stays fresh: a page written after the first search is findable', async () => {
    const client = await freshClient();
    await client.savePage({id: randomUUID(), name: 'a', data: snapshot('alpha content')});
    expect((await client.aiSearch('beta')).results).toHaveLength(0); // builds the index

    const later = randomUUID();
    await client.savePage({id: later, name: 'b', data: snapshot('beta content')}); // invalidates
    const res = await client.aiSearch('beta');
    expect(res.results.map((r) => r.pageId)).toContain(later);
  });

  it('aiIndex reports the indexed page/chunk counts', async () => {
    const client = await freshClient();
    await client.savePage({id: randomUUID(), name: 'one', data: snapshot('first note body')});
    await client.savePage({id: randomUUID(), name: 'two', data: snapshot('second note body')});
    const stats = await client.aiIndex();
    expect(stats.pages).toBe(2);
    expect(stats.chunks).toBeGreaterThanOrEqual(2);
  });
});
