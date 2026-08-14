import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {emptyPageSnapshot} from '@book.dev/sdk';
import {PgliteDb} from './db';
import {PageStore} from './store';

let store: PageStore;

beforeEach(async () => {
  store = new PageStore(await PgliteDb.create('memory://'));
  await store.migrate();
});

afterEach(async () => {
  await store.close();
});

async function createTestRow(properties: Record<string, unknown>) {
  const host = await store.upsertPage({name: 'Merge asymmetry', data: emptyPageSnapshot()});
  const database = await store.createDatabase({pageId: host.id, name: 'Merge asymmetry'});
  const row = await store.createRow(database.id, {properties});
  return {database, row};
}

describe('updateRow property patches (CWD-3)', () => {
  it('preserves keys from sequential partial writes to different properties', async () => {
    const {database, row} = await createTestRow({seed: true});

    await store.updateRow(database.id, row.id, {properties: {left: 'L'}});
    const updated = await store.updateRow(database.id, row.id, {properties: {right: 'R'}});

    expect(updated?.properties).toEqual({seed: true, left: 'L', right: 'R'});
  });

  it('deletes a property whose patch value is null', async () => {
    const {database, row} = await createTestRow({keep: 'yes', remove: 'me'});

    const updated = await store.updateRow(database.id, row.id, {properties: {remove: null}});

    expect(updated?.properties).toEqual({keep: 'yes'});
    expect(updated?.properties).not.toHaveProperty('remove');
  });

  it('applies stale property bags per key instead of replacing the stored blob', async () => {
    const {database, row} = await createTestRow({seed: true});
    const stale = {...row.properties};

    await store.updateRow(database.id, row.id, {properties: {...stale, left: true}});
    const updated = await store.updateRow(database.id, row.id, {properties: {...stale, right: true}});

    expect(updated?.properties).toEqual({seed: true, left: true, right: true});
  });
});

describe('updateInstanceConfig merge transaction (CWD-3)', () => {
  it('keeps concurrent PGlite patches together by enclosing the merge in one transaction', async () => {
    await Promise.all([
      store.updateInstanceConfig({guestAccess: 'off'}),
      store.updateInstanceConfig({agentEdits: 'direct'}),
    ]);

    expect(await store.getInstanceConfig()).toMatchObject({
      guestAccess: 'off',
      agentEdits: 'direct',
    });
  });
});
