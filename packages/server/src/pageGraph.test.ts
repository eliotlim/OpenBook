import {rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {
  guestPrincipal,
  mintIdentityKeypair,
  signIdentity,
  type IdentityClaims,
  type IdentityKeypair,
  type Jwks,
} from '@book.dev/sdk';
import {PgliteDb} from './db';
import {PageStore} from './store';
import {PageHub} from './hub';
import {createApp} from './app';
import {LocalDataClient} from './localClient';
import {IdentityService} from './instanceConfig';
import {IDENTITY_HEADER} from './principal';

// OB-33 — the on-the-fly page-link graph. Covers the pure builder (mention +
// relation edges, self-loop / deleted-target / dedup drops), the per-principal
// read gate the route threads in (a restricted page is dropped as a node AND its
// edges vanish from both directions), LocalDataClient parity, and a 500-page
// timing floor.

let store: PageStore;
let dir: string;
let seq = 0;

const emptySnapshot = () => ({editorjs: {blocks: []}, values: [], names: []});
// A document snapshot whose editorjs blocks carry inline `@`-mention anchors for
// each target id — the shape extractMentionIds() matches (data-page-id="…").
const mentionSnapshot = (targetIds: string[]) => ({
  editorjs: {blocks: targetIds.map((id) => ({type: 'paragraph', data: {text: `<a data-page-id="${id}">ref</a>`}}))},
  values: [],
  names: [],
});

beforeEach(async () => {
  seq += 1;
  dir = join(tmpdir(), `ob-pagegraph-test-${process.pid}-${seq}`);
  rmSync(dir, {recursive: true, force: true});
  store = new PageStore(await PgliteDb.create(dir));
  await store.migrate();
});

afterEach(async () => {
  await store.close();
  rmSync(dir, {recursive: true, force: true});
});

describe('store.pageGraph — builder (no read filter)', () => {
  it('emits a mention edge (A→B) and a relation edge (C→D) in one pass', async () => {
    const b = await store.upsertPage({name: 'B', data: emptySnapshot()});
    const d = await store.upsertPage({name: 'D', data: emptySnapshot()});
    const a = await store.upsertPage({name: 'A', data: mentionSnapshot([b.id])});
    const c = await store.upsertPage({name: 'C', data: emptySnapshot()});
    await store.setPageProperties(c.id, {rel: [d.id]});

    const {nodes, edges} = await store.pageGraph();
    expect(nodes.map((n) => n.id).sort()).toEqual([a.id, b.id, c.id, d.id].sort());
    expect(edges).toContainEqual({from: a.id, to: b.id, kind: 'mention'});
    expect(edges).toContainEqual({from: c.id, to: d.id, kind: 'relation'});
    expect(edges).toHaveLength(2);
  });

  it('carries a scalar (non-array) property reference as a relation edge', async () => {
    const target = await store.upsertPage({name: 'T', data: emptySnapshot()});
    const src = await store.upsertPage({name: 'S', data: emptySnapshot()});
    await store.setPageProperties(src.id, {parentRef: target.id});

    const {edges} = await store.pageGraph();
    expect(edges).toContainEqual({from: src.id, to: target.id, kind: 'relation'});
  });

  it('drops self-loops (a page mentioning itself)', async () => {
    const s = await store.upsertPage({name: 'S', data: emptySnapshot()});
    // Rewrite its own body to mention itself.
    await store.upsertPage({id: s.id, name: 'S', data: mentionSnapshot([s.id])});
    const {edges} = await store.pageGraph();
    expect(edges.filter((e) => e.from === s.id)).toEqual([]);
  });

  it('drops edges whose target is deleted or does not exist', async () => {
    const gone = await store.upsertPage({name: 'gone', data: emptySnapshot()});
    const a = await store.upsertPage({name: 'A', data: mentionSnapshot([gone.id, 'no-such-page-id'])});
    await store.deletePage(gone.id);

    const {nodes, edges} = await store.pageGraph();
    expect(nodes.map((n) => n.id)).toEqual([a.id]); // deleted page is not a node
    expect(edges).toEqual([]); // edge to deleted + edge to non-existent id both dropped
  });

  it('dedups a repeated (from,to,kind) edge', async () => {
    const b = await store.upsertPage({name: 'B', data: emptySnapshot()});
    // Two separate blocks both mention B → one mention edge.
    const a = await store.upsertPage({name: 'A', data: mentionSnapshot([b.id, b.id])});
    const {edges} = await store.pageGraph();
    expect(edges.filter((e) => e.from === a.id && e.to === b.id)).toHaveLength(1);
  });

  it('emits BOTH a mention and a relation edge between the same pair (distinct kinds)', async () => {
    const b = await store.upsertPage({name: 'B', data: emptySnapshot()});
    const a = await store.upsertPage({name: 'A', data: mentionSnapshot([b.id])});
    await store.setPageProperties(a.id, {rel: [b.id]});
    const {edges} = await store.pageGraph();
    expect(edges).toContainEqual({from: a.id, to: b.id, kind: 'mention'});
    expect(edges).toContainEqual({from: a.id, to: b.id, kind: 'relation'});
  });

  it('reports the page name + icon on each node', async () => {
    const b = await store.upsertPage({name: 'B', data: emptySnapshot()});
    await store.setPageProperties(b.id, {sys_icon: '📘'});
    const {nodes} = await store.pageGraph();
    const node = nodes.find((n) => n.id === b.id);
    expect(node).toMatchObject({id: b.id, name: 'B', icon: '📘'});
  });
});

describe('store.pageGraph — per-principal read filter (canReadPage seam)', () => {
  it('drops an unreadable node AND every edge touching it (both directions)', async () => {
    const b = await store.upsertPage({name: 'B', data: emptySnapshot()});
    const r = await store.upsertPage({name: 'R (restricted)', data: mentionSnapshot([b.id])});
    // A links to the restricted page; the restricted page links to B.
    const a = await store.upsertPage({name: 'A', data: mentionSnapshot([r.id, b.id])});

    // Predicate that mirrors a principal who cannot read R.
    const canRead = async (id: string) => id !== r.id;
    const {nodes, edges} = await store.pageGraph(canRead);

    expect(nodes.map((n) => n.id).sort()).toEqual([a.id, b.id].sort()); // R gone
    // A→R (out) and R→B (in) both dropped; A→B survives.
    expect(edges).toEqual([{from: a.id, to: b.id, kind: 'mention'}]);
  });

  it('returns the full graph when every page is readable', async () => {
    const b = await store.upsertPage({name: 'B', data: emptySnapshot()});
    const a = await store.upsertPage({name: 'A', data: mentionSnapshot([b.id])});
    const {nodes, edges} = await store.pageGraph(async () => true);
    expect(nodes.map((n) => n.id).sort()).toEqual([a.id, b.id].sort());
    expect(edges).toEqual([{from: a.id, to: b.id, kind: 'mention'}]);
  });
});

describe('LocalDataClient.pageGraph — transport parity', () => {
  it('returns the same shape as the store, unfiltered (single in-webview principal)', async () => {
    const b = await store.upsertPage({name: 'B', data: emptySnapshot()});
    await store.upsertPage({name: 'A', data: mentionSnapshot([b.id])});
    const local = new LocalDataClient(store, new PageHub());
    const viaLocal = await local.pageGraph();
    const viaStore = await store.pageGraph();
    expect(viaLocal).toEqual(viaStore);
    expect(viaLocal.edges).toContainEqual(expect.objectContaining({kind: 'mention'}));
  });
});

describe('GET /api/page-graph — route read-gating end to end', () => {
  const ISS = 'https://account.book.pub';
  let kp: IdentityKeypair;
  let jwks: Jwks;

  const idFor = (sub: string, over: Partial<IdentityClaims> = {}): Promise<string> =>
    signIdentity(
      kp.privateKey,
      {
        iss: ISS,
        sub,
        name: sub,
        iat: Math.floor(Date.now() / 1000) - 30,
        exp: Math.floor(Date.now() / 1000) + 3600,
        jti: `jti-${sub}-${Math.random()}`,
        ...over,
      },
      kp.publicJwk.kid,
    );

  beforeEach(async () => {
    kp = await mintIdentityKeypair('k1');
    jwks = {keys: [kp.publicJwk]};
    // Trust the dev issuer; claim ownership; make ordinary pages guest-readable so
    // ONLY the explicitly-restricted page is filtered for the guest.
    await store.updateInstanceConfig({trustedIssuers: [{issuer: ISS, jwks}], defaultVisibility: 'public'});
    await store.claimOwnership(`${ISS}#owner`);
  });

  const appWithIdentity = () => createApp(store, undefined, new PageHub(), {identity: new IdentityService(store)});

  it('owner sees the restricted node + its edge; a guest gets neither', async () => {
    const b = await store.upsertPage({name: 'B', data: emptySnapshot()});
    const r = await store.upsertPage({name: 'R', data: emptySnapshot()});
    await store.setPageVisibility(r.id, 'restricted');
    const a = await store.upsertPage({name: 'A', data: mentionSnapshot([r.id, b.id])});
    const app = appWithIdentity();

    // Owner: full graph (identity header for the claimed owner subject).
    const ownerRes = await app.request('/api/page-graph', {headers: {[IDENTITY_HEADER]: await idFor('owner')}});
    expect(ownerRes.status).toBe(200);
    const owner = (await ownerRes.json()) as {nodes: {id: string}[]; edges: {from: string; to: string}[]};
    expect(owner.nodes.map((n) => n.id).sort()).toEqual([a.id, b.id, r.id].sort());
    expect(owner.edges).toContainEqual(expect.objectContaining({from: a.id, to: r.id}));

    // Guest (no identity header): passes the STAB-8 read gate like GET /api/pages,
    // but the restricted page + the A→R edge are filtered out.
    const guestRes = await app.request('/api/page-graph');
    expect(guestRes.status).toBe(200);
    const guest = (await guestRes.json()) as {nodes: {id: string}[]; edges: {from: string; to: string}[]};
    expect(guest.nodes.map((n) => n.id).sort()).toEqual([a.id, b.id].sort());
    expect(guest.edges).not.toContainEqual(expect.objectContaining({to: r.id}));
    expect(guest.edges).toContainEqual(expect.objectContaining({from: a.id, to: b.id}));
  });
});

describe('GET /api/page-graph — blanket-read fast path (Sasha)', () => {
  const ISS = 'https://account.book.pub';
  let kp: IdentityKeypair;
  let jwks: Jwks;

  const idFor = (sub: string): Promise<string> =>
    signIdentity(
      kp.privateKey,
      {
        iss: ISS,
        sub,
        name: sub,
        iat: Math.floor(Date.now() / 1000) - 30,
        exp: Math.floor(Date.now() / 1000) + 3600,
        jti: `jti-${sub}-${Math.random()}`,
      },
      kp.publicJwk.kid,
    );

  beforeEach(async () => {
    kp = await mintIdentityKeypair('k1');
    jwks = {keys: [kp.publicJwk]};
  });

  const appWithIdentity = () => createApp(store, undefined, new PageHub(), {identity: new IdentityService(store)});

  it('store.blanketReadDecision returns true (owner) / false (guest-off) / null (per-page)', async () => {
    // Unclaimed + guest access disabled → uniformly DENIED (false).
    await store.updateInstanceConfig({guestAccess: 'off'});
    expect(await store.blanketReadDecision(guestPrincipal())).toBe(false);

    // Claim + trust the issuer; a claimed owner is uniformly READABLE (true).
    await store.updateInstanceConfig({trustedIssuers: [{issuer: ISS, jwks}], defaultVisibility: 'public', guestAccess: 'read'});
    await store.claimOwnership(`${ISS}#owner`);
    const owner = {kind: 'user', subject: `${ISS}#owner`, issuer: ISS, name: 'owner', verifiedVia: 'jws'} as const;
    expect(await store.blanketReadDecision(owner)).toBe(true);

    // A claimed-instance guest is neither — the decision is per page (null).
    expect(await store.blanketReadDecision(guestPrincipal())).toBeNull();
  });

  it('owner-unfiltered: blanket-true serves the whole graph incl. a restricted node', async () => {
    await store.updateInstanceConfig({trustedIssuers: [{issuer: ISS, jwks}], defaultVisibility: 'public'});
    await store.claimOwnership(`${ISS}#owner`);
    const b = await store.upsertPage({name: 'B', data: emptySnapshot()});
    const r = await store.upsertPage({name: 'R', data: emptySnapshot()});
    await store.setPageVisibility(r.id, 'restricted');
    const a = await store.upsertPage({name: 'A', data: mentionSnapshot([r.id, b.id])});

    const res = await appWithIdentity().request('/api/page-graph', {headers: {[IDENTITY_HEADER]: await idFor('owner')}});
    expect(res.status).toBe(200);
    const graph = (await res.json()) as {nodes: {id: string}[]; edges: {from: string; to: string}[]};
    expect(graph.nodes.map((n) => n.id).sort()).toEqual([a.id, b.id, r.id].sort());
    expect(graph.edges).toContainEqual(expect.objectContaining({from: a.id, to: r.id}));
  });

  it('denied-empty: blanket-false (unclaimed, guest access off) serves an empty graph', async () => {
    // Pages exist, but with guest access disabled on an unclaimed instance the whole
    // library is uniformly unreadable → the route returns {nodes:[],edges:[]}.
    const b = await store.upsertPage({name: 'B', data: emptySnapshot()});
    await store.upsertPage({name: 'A', data: mentionSnapshot([b.id])});
    await store.updateInstanceConfig({guestAccess: 'off'});

    // No identity provider ⇒ the guest reaches the route (no guest-gate 401); the
    // blanket fast path denies it.
    const res = await createApp(store, undefined, new PageHub()).request('/api/page-graph');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({nodes: [], edges: []});
  });

  it('mixed-filtered: blanket-null threads the per-page predicate (guest drops a restricted node)', async () => {
    await store.updateInstanceConfig({trustedIssuers: [{issuer: ISS, jwks}], defaultVisibility: 'public'});
    await store.claimOwnership(`${ISS}#owner`);
    const b = await store.upsertPage({name: 'B', data: emptySnapshot()});
    const r = await store.upsertPage({name: 'R', data: emptySnapshot()});
    await store.setPageVisibility(r.id, 'restricted');
    const a = await store.upsertPage({name: 'A', data: mentionSnapshot([r.id, b.id])});

    // Guest (no identity header) on a CLAIMED instance → per-page filter.
    const res = await appWithIdentity().request('/api/page-graph');
    expect(res.status).toBe(200);
    const graph = (await res.json()) as {nodes: {id: string}[]; edges: {from: string; to: string}[]};
    expect(graph.nodes.map((n) => n.id).sort()).toEqual([a.id, b.id].sort()); // R filtered
    expect(graph.edges).not.toContainEqual(expect.objectContaining({to: r.id}));
    expect(graph.edges).toContainEqual(expect.objectContaining({from: a.id, to: b.id}));
  });
});

describe('store.pageGraph — 500-page synthetic library timing', () => {
  it('builds the graph over 500 pages within a reasonable budget', async () => {
    const N = 500;
    const ids: string[] = [];
    for (let i = 0; i < N; i += 1) {
      const p = await store.upsertPage({name: `P${i}`, data: emptySnapshot()});
      ids.push(p.id);
    }
    // Give each page ~3 mention out-edges to the next pages (a dense-ish web).
    for (let i = 0; i < N; i += 1) {
      const targets = [ids[(i + 1) % N], ids[(i + 2) % N], ids[(i + 3) % N]];
      await store.upsertPage({id: ids[i], name: `P${i}`, data: mentionSnapshot(targets)});
    }

    const t0 = performance.now();
    const graph = await store.pageGraph();
    const buildMs = performance.now() - t0;
    console.log(`[OB-33 perf] pageGraph over ${N} pages: nodes=${graph.nodes.length} edges=${graph.edges.length} build=${buildMs.toFixed(1)}ms`);

    expect(graph.nodes).toHaveLength(N);
    expect(graph.edges.length).toBe(N * 3);
    expect(buildMs).toBeLessThan(2000); // generous CI ceiling; real number is logged

    // With the read predicate resolved once up front, filtering stays linear too.
    const t1 = performance.now();
    const filtered = await store.pageGraph(async () => true);
    const filteredMs = performance.now() - t1;
    console.log(`[OB-33 perf] pageGraph (read-filtered) over ${N} pages: build=${filteredMs.toFixed(1)}ms`);
    expect(filtered.edges.length).toBe(N * 3);

    // Sasha INFO: the REAL cost — the actual `canReadPage` predicate (a DB read per
    // node) threaded over the 500-page fixture, i.e. the per-page path the route
    // takes when the blanket fast path doesn't apply. Logged only; no threshold.
    const principal = guestPrincipal();
    const base = await store.accessBase(principal);
    const t2 = performance.now();
    const realFiltered = await store.pageGraph((pageId) => store.canReadPage(principal, pageId, base));
    const realMs = performance.now() - t2;
    console.log(
      `[OB-33 perf] pageGraph (real canReadPage) over ${N} pages: ` +
        `nodes=${realFiltered.nodes.length} edges=${realFiltered.edges.length} build=${realMs.toFixed(1)}ms`,
    );
  });
});
