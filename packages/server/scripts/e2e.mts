/**
 * End-to-end integration test for the OpenBook server + SDK.
 *
 * Exercises the real client (`@open-book/sdk` `HttpDataClient`) against a live
 * server, covering both database backends and durability:
 *
 *   1. Embedded mode   — server opens embedded PGlite under a data dir.
 *   2. Persistence     — data survives a full server stop + restart.
 *   3. Headless mode   — server connects to Postgres over the wire (provided
 *                        here by pglite-socket so no external server is needed).
 *
 * Run: pnpm --filter @open-book/server test:e2e
 */
import assert from 'node:assert/strict';
import {rmSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {PGLiteSocketServer} from '@electric-sql/pglite-socket';
import {
  API,
  applyView,
  defaultDatabaseSchema,
  HttpDataClient,
  OWNER_PROPERTY_ID,
  TITLE_PROPERTY_ID,
  VERIFICATION_PROPERTY_ID,
  type PageSnapshot,
} from '@open-book/sdk';
import {startServer} from '../src/server';

const ROOT = '/tmp/openbook-e2e';
const EMBEDDED_DIR = `${ROOT}/embedded`;

let passed = 0;
function check(label: string, cond: boolean): void {
  assert.ok(cond, `FAILED: ${label}`);
  passed += 1;
  console.log(`  ✓ ${label}`);
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const sampleSnapshot = (n: number): PageSnapshot => ({
  editorjs: {blocks: [{type: 'paragraph', data: {text: `hello ${n}`}}]},
  values: [['c1', n]],
  names: [['x', 'c1']],
});

/** A snapshot whose document links to `targetId` via an inline mention anchor. */
const mentionSnapshot = (targetId: string): PageSnapshot => ({
  editorjs: {
    blocks: [{type: 'paragraph', data: {text: `see <a class="ob-mention" data-page-id="${targetId}">📄 page</a>`}}],
  },
  values: [],
  names: [],
});

async function exerciseCrud(client: HttpDataClient, mode: string): Promise<void> {
  console.log(`\n[${mode}] CRUD via HttpDataClient`);

  const created = await client.savePage({name: `page-${mode}`, data: sampleSnapshot(42)});
  check('create returns a uuid', /^[0-9a-f-]{36}$/.test(created.id));
  check('create round-trips name', created.name === `page-${mode}`);
  check('create round-trips values', JSON.stringify(created.data.values) === JSON.stringify([['c1', 42]]));
  check('create round-trips names', JSON.stringify(created.data.names) === JSON.stringify([['x', 'c1']]));
  check('create sets timestamps', Boolean(created.createdAt) && Boolean(created.updatedAt));

  const fetched = await client.getPage(created.id);
  check('get returns the page', fetched !== null && fetched.id === created.id);
  check('get round-trips data', JSON.stringify(fetched?.data) === JSON.stringify(created.data));

  const missing = await client.getPage('00000000-0000-0000-0000-000000000000');
  check('get of unknown id -> null', missing === null);

  const list = await client.listPages();
  check('list includes the page', list.some((p) => p.id === created.id));
  check('list items carry no data payload', !('data' in (list.find((p) => p.id === created.id) ?? {})));

  const updated = await client.savePage({id: created.id, name: created.name, data: sampleSnapshot(99)});
  check('update keeps id', updated.id === created.id);
  check('update replaces values', JSON.stringify(updated.data.values) === JSON.stringify([['c1', 99]]));
  check('update bumps updatedAt', updated.updatedAt >= created.updatedAt);

  await assert.rejects(
    () => client.savePage({name: `page-${mode}`, data: sampleSnapshot(1)}),
    /already exists/,
    'duplicate name should be rejected',
  );
  check('duplicate name rejected (409)', true);

  const renamed = await client.renamePage(created.id, `renamed-${mode}`);
  check('rename changes the name', renamed.name === `renamed-${mode}`);
  check('rename preserves data', JSON.stringify(renamed.data.values) === JSON.stringify([['c1', 99]]));

  check('delete returns true', (await client.deletePage(created.id)) === true);
  check('get after delete -> null', (await client.getPage(created.id)) === null);
  check('second delete returns false', (await client.deletePage(created.id)) === false);
}

// A row snapshot whose reactive store exports a named `total` cell — exercises
// the `expr`/exports projection that powers reactive database columns.
const rowSnapshot = (total: number): PageSnapshot => ({
  editorjs: {blocks: [{type: 'paragraph', data: {text: `row total ${total}`}}]},
  values: [['cell-total', total]],
  names: [['total', 'cell-total']],
});

async function exerciseNesting(client: HttpDataClient, mode: string): Promise<void> {
  console.log(`\n[${mode}] Nested pages via HttpDataClient`);

  const parent = await client.savePage({name: `parent-${mode}`, data: sampleSnapshot(1)});
  const child = await client.savePage({name: `child-${mode}`, data: sampleSnapshot(2), parentId: parent.id});
  const grandchild = await client.savePage({name: `gc-${mode}`, data: sampleSnapshot(3), parentId: child.id});
  check('child records its parent', child.parentId === parent.id);
  check('grandchild records its parent', grandchild.parentId === child.id);
  check('top-level page has no parent', parent.parentId === null);

  const list = await client.listPages();
  check('nested pages appear in the list with parentId', list.find((p) => p.id === child.id)?.parentId === parent.id);

  // A content save (no parentId) must not detach the page from its parent.
  const resaved = await client.savePage({id: child.id, name: child.name, data: sampleSnapshot(99)});
  check('content save preserves the parent', resaved.parentId === parent.id);

  // Deleting the parent moves the whole subtree to the trash together.
  check('delete parent (soft)', (await client.deletePage(parent.id)) === true);
  check('child hidden with the parent', (await client.getPage(child.id)) === null);
  check('grandchild hidden with the parent', (await client.getPage(grandchild.id)) === null);
  const trash = await client.listTrash();
  check('parent is a trash root', trash.some((p) => p.id === parent.id));
  check('nested child is not a separate trash root', !trash.some((p) => p.id === child.id));

  // Restoring the parent brings the whole subtree back together.
  check('restore parent', (await client.restorePage(parent.id))?.id === parent.id);
  check('child restored with the parent', (await client.getPage(child.id)) !== null);
  check('grandchild restored with the parent', (await client.getPage(grandchild.id)) !== null);
  check('parent left the trash', !(await client.listTrash()).some((p) => p.id === parent.id));
}

async function exerciseOrdering(client: HttpDataClient, mode: string): Promise<void> {
  console.log(`\n[${mode}] Page ordering & movePage`);

  const parent = await client.savePage({name: `order-parent-${mode}`, data: sampleSnapshot(0)});
  const x = await client.savePage({name: `order-x-${mode}`, data: sampleSnapshot(1), parentId: parent.id});
  const y = await client.savePage({name: `order-y-${mode}`, data: sampleSnapshot(2), parentId: parent.id});
  const z = await client.savePage({name: `order-z-${mode}`, data: sampleSnapshot(3), parentId: parent.id});

  // The page list is position-ordered, so a parent's children come back in
  // their manual order.
  const childrenOf = async (pid: string): Promise<string[]> =>
    (await client.listPages()).filter((p) => p.parentId === pid).map((p) => p.id);

  check('new children list in creation order (appended)', JSON.stringify(await childrenOf(parent.id)) === JSON.stringify([x.id, y.id, z.id]));

  // Reorder: move z to the front of its siblings.
  const moved = await client.movePage(z.id, {parentId: parent.id, orderedIds: [z.id, x.id, y.id]});
  check('movePage returns the moved page', moved.id === z.id);
  check('movePage reorders siblings', JSON.stringify(await childrenOf(parent.id)) === JSON.stringify([z.id, x.id, y.id]));

  // Re-nest: move x under its sibling z (changes parentId).
  await client.movePage(x.id, {parentId: z.id, orderedIds: [x.id]});
  check('movePage re-parents the page', (await client.getPage(x.id))?.parentId === z.id);
  check('the re-nested page leaves its old group', JSON.stringify(await childrenOf(parent.id)) === JSON.stringify([z.id, y.id]));
  check('the re-nested page joins its new parent', JSON.stringify(await childrenOf(z.id)) === JSON.stringify([x.id]));

  // Cycle guard: nesting z under x (now z's descendant) must be rejected.
  await assert.rejects(
    () => client.movePage(z.id, {parentId: x.id, orderedIds: [z.id]}),
    /409|cycle/i,
    'a cyclic move should be rejected',
  );
  check('movePage rejects a cycle (409)', true);

  // Clean up so these don't pollute later listings.
  await client.deletePage(parent.id);
}

async function exerciseBackup(client: HttpDataClient, mode: string): Promise<void> {
  console.log(`\n[${mode}] Whole-space backup: export / import`);

  const parent = await client.savePage({name: `bk-parent-${mode}`, data: sampleSnapshot(1)});
  const child = await client.savePage({name: `bk-child-${mode}`, data: sampleSnapshot(2), parentId: parent.id});

  const bundle = await client.exportSpace();
  check('export includes live pages with data', bundle.pages.some((p) => p.id === parent.id && p.data.values.length > 0));
  check('export includes nested pages', bundle.pages.some((p) => p.id === child.id && p.parentId === parent.id));

  // Copy-import the parent + child: new ids, names suffixed on clash, nesting kept.
  const subtree = bundle.pages.filter((p) => p.id === parent.id || p.id === child.id);
  const copied = await client.importSpace({pages: subtree, databases: [], mode: 'copy'});
  check('copy import creates new pages', copied.created === 2 && copied.overwritten === 0);
  check('copy import suffixes clashing names', copied.renamed === 2);

  const afterCopy = await client.exportSpace();
  const importedParent = afterCopy.pages.find((p) => p.name === `bk-parent-${mode} (imported)`);
  const importedChild = afterCopy.pages.find((p) => p.name === `bk-child-${mode} (imported)`);
  check('copy import: parent copied under a fresh id', !!importedParent && importedParent.id !== parent.id);
  check('copy import: nesting preserved', !!importedChild && importedChild.parentId === importedParent?.id);

  // Overwrite-import the original parent (same id) with a new name → replace in place.
  const overwritten = await client.importSpace({
    pages: [{...parent, name: `bk-parent-${mode}-edited`}],
    databases: [],
    mode: 'overwrite',
  });
  check('overwrite replaces by id (no new page)', overwritten.overwritten === 1 && overwritten.created === 0);
  check('overwrite applies the new content', (await client.getPage(parent.id))?.name === `bk-parent-${mode}-edited`);
}

async function exerciseTrash(client: HttpDataClient, mode: string): Promise<void> {
  console.log(`\n[${mode}] Trash: restore, purge, empty`);

  // A standalone page round-trips through the trash and back.
  const page = await client.savePage({name: `trash-${mode}`, data: sampleSnapshot(1)});
  check('soft delete returns true', (await client.deletePage(page.id)) === true);
  check('soft-deleted page is hidden', (await client.getPage(page.id)) === null);
  check('soft-deleted page is in the trash', (await client.listTrash()).some((p) => p.id === page.id));
  check('a trashed name is freed for reuse', (await client.savePage({name: `trash-${mode}`, data: sampleSnapshot(2)})).id !== page.id);
  const restored = await client.restorePage(page.id);
  check('restore brings the page back', restored?.id === page.id);
  check('restore renames around a name collision', restored?.name === `trash-${mode} (restored)`);
  check('restored page is visible again', (await client.getPage(page.id)) !== null);

  // Purge a single page for good.
  await client.deletePage(page.id);
  check('purge a single trashed page', (await client.purgePage(page.id)) === true);
  check('purging a missing page returns false', (await client.purgePage(page.id)) === false);
  check('a purged page cannot be restored', (await client.restorePage(page.id)) === null);

  // A database row deleted on its own lands in the trash and restores back in.
  const host = await client.savePage({name: `trash-db-${mode}`, data: sampleSnapshot(0)});
  const db = await client.createDatabase({pageId: host.id, name: null, schema: defaultDatabaseSchema()});
  const row = await client.createRow(db.id, {name: 'Doomed', data: rowSnapshot(5)});
  check('delete a row (soft)', (await client.deletePage(row.id)) === true);
  check('row leaves the database view', !(await client.listRows(db.id)).some((r) => r.id === row.id));
  check('row appears in the trash', (await client.listTrash()).some((t) => t.id === row.id));
  check('restore the row', (await client.restorePage(row.id))?.id === row.id);
  check('row returns to the database view', (await client.listRows(db.id)).some((r) => r.id === row.id));

  // Empty the trash wholesale.
  await client.deletePage(host.id);
  check('emptyTrash purges remaining trash', (await client.emptyTrash()) >= 1);
  check('trash is empty afterwards', (await client.listTrash()).length === 0);
}

async function exerciseDatabase(client: HttpDataClient, mode: string): Promise<void> {
  console.log(`\n[${mode}] Database via HttpDataClient`);

  // Host page (a regular page that will point at a database).
  const host = await client.savePage({name: `db-host-${mode}`, data: sampleSnapshot(0)});
  const schema = defaultDatabaseSchema();
  const db = await client.createDatabase({pageId: host.id, name: `Tasks ${mode}`, schema});
  check('create database returns id', /^[0-9a-f-]{36}$/.test(db.id));
  check('database is linked to its host page', db.pageId === host.id);
  check('database round-trips schema', db.schema.properties.length === schema.properties.length);

  const hostAfter = await client.getPage(host.id);
  check('host page reports hostedDatabaseId', hostAfter?.hostedDatabaseId === db.id);
  check('host page keeps its own content', JSON.stringify(hostAfter?.data.values) === JSON.stringify([['c1', 0]]));

  const viaPage = await client.getPageDatabase(host.id);
  check('database is reachable via its host page', viaPage?.id === db.id);

  const list = await client.listPages();
  check('host page appears in the page list', list.some((p) => p.id === host.id && p.hostedDatabaseId === db.id));

  // Rows are pages tagged with the database id, hidden from the page list.
  const notesProp = schema.properties.find((p) => p.type === 'text')!;
  const r1 = await client.createRow(db.id, {
    name: 'Alpha',
    properties: {[notesProp.id]: 'first note'},
    data: rowSnapshot(10),
  });
  const r2 = await client.createRow(db.id, {name: 'Bravo', data: rowSnapshot(30)});
  check('row create returns a page id', /^[0-9a-f-]{36}$/.test(r1.id));
  check('row carries its database membership', r1.databaseId === db.id);

  const afterRows = await client.listPages();
  check('rows are excluded from the page list', !afterRows.some((p) => p.id === r1.id || p.id === r2.id));

  const rows = await client.listRows(db.id);
  check('listRows returns both rows', rows.length === 2);
  const alpha = rows.find((r) => r.name === 'Alpha');
  check('row round-trips manual property', alpha?.properties[notesProp.id] === 'first note');
  check('row projects exported cell value', alpha?.exports.total === 10);

  // Manual row ordering: rows list in creation order; reorderRows rewrites it;
  // a fresh row appends at the bottom (never reshuffles on edit).
  check('rows list in creation order', rows[0].id === r1.id && rows[1].id === r2.id);
  await client.reorderRows(db.id, [r2.id, r1.id]);
  const reordered = await client.listRows(db.id);
  check('reorderRows sets the manual order', reordered[0].id === r2.id && reordered[1].id === r1.id);
  const r3 = await client.createRow(db.id, {name: 'Charlie'});
  const withThird = await client.listRows(db.id);
  check('new row appends at the bottom', withThird[withThird.length - 1].id === r3.id);
  await client.deletePage(r3.id);
  await client.purgePage(r3.id); // remove fully so later row/trash counts are unaffected
  await client.reorderRows(db.id, [r1.id, r2.id]); // restore creation order

  // Sub-items: a row nested under another carries its parentId in listRows.
  const sub = await client.createRow(db.id, {name: 'Alpha sub', parentId: r1.id});
  const withSub = await client.listRows(db.id);
  check('sub-item carries its parentId', withSub.find((r) => r.id === sub.id)?.parentId === r1.id);
  check('top-level rows have a null parentId', withSub.find((r) => r.id === r1.id)?.parentId === null);
  await client.deletePage(sub.id);
  await client.purgePage(sub.id); // keep later row/trash counts unaffected

  // Editing a row's content (a page write) updates its projected exports.
  await client.savePage({id: r1.id, name: 'Alpha', data: rowSnapshot(99)});
  const rowsAfterEdit = await client.listRows(db.id);
  check('exports refresh after a content save', rowsAfterEdit.find((r) => r.id === r1.id)?.exports.total === 99);

  // updateRow changes title + manual properties without touching content.
  const renamed = await client.updateRow(db.id, r1.id, {name: 'Alpha Prime', properties: {[notesProp.id]: 'edited'}});
  check('updateRow changes the title', renamed.name === 'Alpha Prime');
  check('updateRow changes a property', renamed.properties[notesProp.id] === 'edited');
  check('updateRow leaves exports intact', renamed.exports.total === 99);

  // Pure view evaluation: filter + sort run identically here and in the UI.
  const sorted = applyView(rowsAfterEdit, {
    id: 'v', name: 'v', type: 'table', filters: [], sorts: [{propertyId: TITLE_PROPERTY_ID, direction: 'asc'}],
  }, schema.properties);
  check('applyView sorts by title ascending', sorted[0].name === 'Alpha Prime' || sorted[0].name === 'Alpha');

  // Deleting the host page moves it to the trash; the database + rows survive
  // until it's purged, so restoring the host brings the whole view back.
  check('delete host page (soft)', (await client.deletePage(host.id)) === true);
  check('host page hidden after delete', (await client.getPage(host.id)) === null);
  check('database survives a soft delete', (await client.getDatabase(db.id)) !== null);
  check('host page restores', (await client.restorePage(host.id))?.id === host.id);
  check('rows survive the round-trip', (await client.listRows(db.id)).length === 2);

  // Purge for good: now the FK cascade removes the database and its row pages.
  await client.deletePage(host.id);
  check('purge host page', (await client.purgePage(host.id)) === true);
  check('database removed by cascade after purge', (await client.getDatabase(db.id)) === null);
  check('row page removed by cascade after purge', (await client.getPage(r1.id)) === null);
}

// API responses must never be cached: the desktop WKWebView shell otherwise
// serves stale GETs (e.g. an empty trash) from its URL cache. Regression guard
// for the `Cache-Control: no-store` middleware.
async function exercisePageProperties(client: HttpDataClient, mode: string): Promise<void> {
  console.log(`\n[${mode}] Page properties: owner, verification, backlinks`);

  const target = await client.savePage({name: `prop-target-${mode}`, data: sampleSnapshot(1)});
  const linker = await client.savePage({name: `prop-linker-${mode}`, data: mentionSnapshot(target.id)});

  // ── Backlinks (computed from the link graph) ──
  const back = await client.listBacklinks(target.id);
  check('backlinks include the linking page', back.some((p) => p.id === linker.id));
  check('backlinks exclude the target itself', !back.some((p) => p.id === target.id));
  check('a never-linked page has no backlinks', (await client.listBacklinks(linker.id)).length === 0);

  // ── Owner + verification (shallow-merged into properties) ──
  const withOwner = await client.setPageProperties(target.id, {[OWNER_PROPERTY_ID]: 'Ada'});
  check('owner persists', withOwner.properties[OWNER_PROPERTY_ID] === 'Ada');

  const withVerify = await client.setPageProperties(target.id, {
    [VERIFICATION_PROPERTY_ID]: {verified: true, by: 'Ada', at: '2026-01-01T00:00:00.000Z'},
  });
  check(
    'verification persists',
    (withVerify.properties[VERIFICATION_PROPERTY_ID] as {verified: boolean}).verified === true,
  );
  check('a second property merges (owner preserved)', withVerify.properties[OWNER_PROPERTY_ID] === 'Ada');

  // A routine content save must not clobber the stored properties.
  const resaved = await client.savePage({id: target.id, name: target.name, data: sampleSnapshot(2)});
  check('a content save preserves properties', resaved.properties[OWNER_PROPERTY_ID] === 'Ada');

  // A relation (an id stored in a page's properties) also counts as a backlink,
  // so links set as database columns are bidirectional with the panel.
  const relator = await client.savePage({name: `prop-relator-${mode}`, data: sampleSnapshot(3)});
  await client.setPageProperties(relator.id, {rel_demo: [target.id]});
  const withRelation = await client.listBacklinks(target.id);
  check('a relation property counts as a backlink', withRelation.some((p) => p.id === relator.id));
  check('the mention link is still a backlink too', withRelation.some((p) => p.id === linker.id));
  await client.deletePage(relator.id);

  // Trashing the linker removes the backlink.
  await client.deletePage(linker.id);
  check('backlink clears when the linker is trashed', (await client.listBacklinks(target.id)).length === 0);

  // Clean up the target so it doesn't collide with later runs.
  await client.deletePage(target.id);
}

async function exerciseCacheHeaders(baseUrl: string, mode: string): Promise<void> {
  console.log(`\n[${mode}] API responses are non-cacheable`);
  for (const path of [API.pages, API.trash]) {
    const res = await fetch(`${baseUrl}${path}`);
    check(`${path} sends Cache-Control: no-store`, res.headers.get('cache-control') === 'no-store');
    await res.text(); // drain the body
  }
}

async function main(): Promise<void> {
  rmSync(ROOT, {recursive: true, force: true});

  // ---- 1. Embedded mode (PGlite) ----
  console.log('\n=== 1. EMBEDDED MODE (embedded PGlite) ===');
  let server = await startServer({dataDir: EMBEDDED_DIR, host: '127.0.0.1', port: 4401});
  console.log(`  server up at ${server.url}`);
  const embeddedClient = new HttpDataClient(server.url);

  const health = await fetch(`${server.url}/health`).then((r) => r.text());
  check('health endpoint returns ok', health === 'ok');

  await exerciseCacheHeaders(server.url, 'embedded');
  await exerciseCrud(embeddedClient, 'embedded');
  await exercisePageProperties(embeddedClient, 'embedded');
  await exerciseDatabase(embeddedClient, 'embedded');
  await exerciseNesting(embeddedClient, 'embedded');
  await exerciseOrdering(embeddedClient, 'embedded');
  await exerciseBackup(embeddedClient, 'embedded');
  await exerciseTrash(embeddedClient, 'embedded');

  // ---- 2. Persistence across restart ----
  console.log('\n=== 2. PERSISTENCE ACROSS RESTART ===');
  const durable = await embeddedClient.savePage({name: 'durable', data: sampleSnapshot(7)});
  check('seeded a page before restart', durable.id.length === 36);
  // Seed a manually-reordered subtree to confirm ordering is durable.
  const orderParent = await embeddedClient.savePage({name: 'order-durable', data: sampleSnapshot(0)});
  const oc1 = await embeddedClient.savePage({name: 'order-durable-1', data: sampleSnapshot(1), parentId: orderParent.id});
  const oc2 = await embeddedClient.savePage({name: 'order-durable-2', data: sampleSnapshot(2), parentId: orderParent.id});
  await embeddedClient.movePage(oc2.id, {parentId: orderParent.id, orderedIds: [oc2.id, oc1.id]});
  await server.close();
  console.log('  server stopped');

  server = await startServer({dataDir: EMBEDDED_DIR, host: '127.0.0.1', port: 4401});
  console.log(`  server restarted at ${server.url}`);
  const restartedClient = new HttpDataClient(server.url);
  const survivor = await restartedClient.getPage(durable.id);
  check('page survived restart', survivor !== null && survivor.id === durable.id);
  check('data survived restart', JSON.stringify(survivor?.data.values) === JSON.stringify([['c1', 7]]));
  const survivingOrder = (await restartedClient.listPages())
    .filter((p) => p.parentId === orderParent.id)
    .map((p) => p.id);
  check('manual order survived restart', JSON.stringify(survivingOrder) === JSON.stringify([oc2.id, oc1.id]));
  await server.close();

  // ---- 3. Headless mode (Postgres over the wire via pglite-socket) ----
  console.log('\n=== 3. HEADLESS MODE (Postgres wire protocol) ===');
  const pglite = await PGlite.create();
  const socket = new PGLiteSocketServer({db: pglite, host: '127.0.0.1', port: 5599});
  await socket.start();
  console.log('  postgres-compatible socket up at 127.0.0.1:5599');
  const headless = await startServer({
    databaseUrl: 'postgres://postgres@127.0.0.1:5599/postgres',
    host: '127.0.0.1',
    port: 4402,
    poolMax: 1,
  });
  console.log(`  headless server up at ${headless.url}`);
  await exerciseCrud(new HttpDataClient(headless.url), 'headless');
  await exercisePageProperties(new HttpDataClient(headless.url), 'headless');
  await exerciseDatabase(new HttpDataClient(headless.url), 'headless');
  await exerciseNesting(new HttpDataClient(headless.url), 'headless');
  await exerciseOrdering(new HttpDataClient(headless.url), 'headless');
  await exerciseTrash(new HttpDataClient(headless.url), 'headless');
  await headless.close();
  await socket.stop();
  await pglite.close();

  // ---- 4. Trash cleanup job (retention purge) ----
  console.log('\n=== 4. TRASH CLEANUP JOB ===');
  const janitor = await startServer({
    dataDir: `${ROOT}/janitor`,
    host: '127.0.0.1',
    port: 4403,
    trashRetentionMs: 0, // purge as soon as a sweep runs
    trashCleanupIntervalMs: 300, // sweep on a short interval for the test
  });
  const jclient = new HttpDataClient(janitor.url);
  const doomed = await jclient.savePage({name: 'doomed', data: sampleSnapshot(1)});
  check('janitor: page created', (await jclient.getPage(doomed.id)) !== null);
  check('janitor: soft delete', (await jclient.deletePage(doomed.id)) === true);
  let swept = false;
  for (let i = 0; i < 40; i += 1) {
    await delay(100);
    if ((await jclient.listTrash()).length === 0) {
      swept = true;
      break;
    }
  }
  check('janitor: cleanup job purged the expired page', swept);
  check('janitor: purged page is gone for good', (await jclient.restorePage(doomed.id)) === null);
  await janitor.close();

  rmSync(ROOT, {recursive: true, force: true});
  console.log(`\n✅ ALL ${passed} CHECKS PASSED — embedded, persistence, headless, and trash-cleanup flows verified.`);
}

main().catch((err) => {
  console.error('\n❌ E2E FAILED:', err);
  process.exit(1);
});
