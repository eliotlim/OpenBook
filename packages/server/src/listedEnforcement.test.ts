import {rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {
  guestPrincipal,
  HttpDataClient,
  mintIdentityKeypair,
  signIdentity,
  type FetchLike,
  type IdentityKeypair,
  type Jwks,
  type LiveSourceLike,
  type PageMeta,
  type Principal,
} from '@book.dev/sdk';
import {PgliteDb} from './db';
import {PageStore} from './store';
import {PageHub, type ListEvent} from './hub';
import {createApp} from './app';
import {IdentityService} from './instanceConfig';
import {IDENTITY_HEADER} from './principal';
import {streamGates} from './access';
import {AiService} from './ai/service';

const ISS = 'https://account.book.pub';
let store: PageStore;
let db: PgliteDb;
let dir: string;
let seq = 0;
let kp: IdentityKeypair;
let jwks: Jwks;

const snapshot = (text = '', mentions: string[] = []) => ({
  editorjs: {
    blocks: [{
      type: 'paragraph',
      data: {text: `${text} ${mentions.map((id) => `<a data-page-id="${id}">ref</a>`).join(' ')}`},
    }],
  },
  values: [],
  names: [],
});

const principal = (sub: string): Principal => ({
  kind: 'user',
  subject: `${ISS}#${sub}`,
  issuer: ISS,
  name: sub,
  verifiedVia: 'jws',
});

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

type App = ReturnType<typeof createApp>;
const appFetch = (app: App): FetchLike => (input, init) => Promise.resolve(app.request(input, init));

/** Read a real app SSE response through the SDK's EventSource-shaped seam. */
function appLiveSource(app: App, openedUrls: string[] = []): (url: string) => LiveSourceLike {
  return (url) => {
    openedUrls.push(url);
    const handlers = new Map<string, Array<(event: {data?: string}) => void>>();
    const fire = (type: string, data?: string): void => {
      for (const handler of handlers.get(type) ?? []) handler({data});
    };
    let cancelled = false;
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    void (async () => {
      const response = await app.request(url);
      fire('open');
      if (!response.body) return;
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let event = 'message';
      let data = '';
      for (;;) {
        const {done, value} = await reader.read();
        if (done || cancelled) break;
        buffer += decoder.decode(value, {stream: true});
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data = line.slice(5).trim();
          else if (line === '') {
            if (data.length > 0 || event !== 'message') fire(event, data);
            event = 'message';
            data = '';
          }
        }
      }
    })();
    return {
      addEventListener(type, handler) {
        const list = handlers.get(type) ?? [];
        list.push(handler);
        handlers.set(type, list);
      },
      close() {
        cancelled = true;
        void reader?.cancel().catch(() => undefined);
      },
    };
  };
}

const waitFor = async (predicate: () => boolean, ms = 2000): Promise<void> => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

beforeEach(async () => {
  seq += 1;
  dir = join(tmpdir(), `ob-listed-enforcement-${process.pid}-${seq}`);
  rmSync(dir, {recursive: true, force: true});
  db = await PgliteDb.create(dir);
  store = new PageStore(db);
  await store.migrate();
  kp = await mintIdentityKeypair('k1');
  jwks = {keys: [kp.publicJwk]};
});

afterEach(async () => {
  await store.close();
  rmSync(dir, {recursive: true, force: true});
});

describe('listed:false enumeration enforcement (UP-2)', () => {
  it.each([true, false])('publishes a rename to a public guest through the %s listing path', async (listed) => {
    await store.updateInstanceConfig({
      trustedIssuers: [{issuer: ISS, jwks}],
      ownerSubject: `${ISS}#owner`,
      defaultVisibility: 'public',
      guestAccess: 'read',
    });
    const page = await store.upsertPage({name: 'Before', data: snapshot(), listed});
    await store.setPageVisibility(page.id, 'public');
    const hub = new PageHub();
    const gates = streamGates(store, guestPrincipal());
    const firehose: string[] = [];
    const direct: string[] = [];
    const offLive = hub.subscribeLive((event) => {
      if (event.type === 'page') firehose.push(event.page.name ?? '');
    }, gates.live);
    const offPage = hub.subscribePage(page.id, (event) => {
      if (event.type === 'page') direct.push(event.page.name ?? '');
    }, gates.page);
    const app = createApp(store, undefined, hub, {identity: new IdentityService(store)});

    const response = await app.request(`/api/pages/${page.id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'X-OpenBook-Client': '1',
        [IDENTITY_HEADER]: await idFor('owner'),
      },
      body: JSON.stringify({name: 'After'}),
    });
    expect(response.status).toBe(200);
    await waitFor(() => direct.includes('After'));
    if (listed) await waitFor(() => firehose.includes('After'));
    else expect(firehose).not.toContain('After');
    offLive();
    offPage();
  });

  it('fails closed when a future PageMeta producer omits listed', async () => {
    const page = await store.upsertPage({name: `producer-${seq}`, data: snapshot()});
    const meta = (await store.listPages()).find((entry) => entry.id === page.id)!;
    expect(meta.listed).toBe(true);
    expect(await store.filterReadablePages(guestPrincipal(), [meta])).toEqual([meta]);

    const missingListed: PageMeta = {...meta};
    delete missingListed.listed;
    expect(await store.filterReadablePages(guestPrincipal(), [missingListed])).toEqual([]);
  });

  it('applies per page across public/members/restricted scopes with no parent inheritance', async () => {
    await store.updateInstanceConfig({
      trustedIssuers: [{issuer: ISS, jwks}],
      ownerSubject: `${ISS}#owner`,
      defaultVisibility: 'public',
      guestAccess: 'read',
    });
    await store.addMember({subject: `${ISS}#member`, role: 'viewer', status: 'active'});

    const publicHidden = await store.upsertPage({name: `public-hidden-${seq}`, data: snapshot()});
    const membersHidden = await store.upsertPage({name: `members-hidden-${seq}`, data: snapshot()});
    const restrictedHidden = await store.upsertPage({name: `restricted-hidden-${seq}`, data: snapshot()});
    const parentHidden = await store.upsertPage({name: `parent-hidden-${seq}`, data: snapshot()});
    const childListed = await store.upsertPage({
      name: `child-listed-${seq}`,
      parentId: parentHidden.id,
      data: snapshot(),
    });
    await store.setPageVisibility(publicHidden.id, {visibility: 'public', listed: false});
    await store.setPageVisibility(membersHidden.id, {visibility: 'members', listed: false});
    await store.setPageVisibility(restrictedHidden.id, {visibility: 'restricted', listed: false});
    await store.setPageAcl(restrictedHidden.id, {subject: `${ISS}#granted`, level: 'read'});
    await store.setPageVisibility(parentHidden.id, {visibility: 'public', listed: false});
    await store.setPageVisibility(childListed.id, {visibility: 'public', listed: true});

    const a = createApp(store, undefined, new PageHub(), {identity: new IdentityService(store)});
    const headers = (jws?: string) => ({'X-OpenBook-Client': '1', ...(jws ? {[IDENTITY_HEADER]: jws} : {})});
    const ids = async (jws?: string): Promise<string[]> => {
      const res = await a.request('/api/pages', {headers: headers(jws)});
      expect(res.status).toBe(200);
      return ((await res.json()) as Array<{id: string}>).map((page) => page.id);
    };

    const ownerJws = await idFor('owner');
    expect(await ids(ownerJws)).toEqual(
      expect.arrayContaining([publicHidden.id, membersHidden.id, restrictedHidden.id, parentHidden.id, childListed.id]),
    );

    const guestIds = await ids();
    expect(guestIds).not.toContain(publicHidden.id);
    expect(guestIds).toContain(childListed.id); // the parent's flag does not inherit
    expect((await a.request(`/api/pages/${publicHidden.id}`, {headers: headers()})).status).toBe(200);

    const memberJws = await idFor('member');
    expect(await ids(memberJws)).not.toContain(membersHidden.id);
    expect((await a.request(`/api/pages/${membersHidden.id}`, {headers: headers(memberJws)})).status).toBe(200);

    const grantedJws = await idFor('granted');
    expect(await ids(grantedJws)).not.toContain(restrictedHidden.id);
    expect((await a.request(`/api/pages/${restrictedHidden.id}`, {headers: headers(grantedJws)})).status).toBe(200);
  });

  it('covers every enumeration for owner/admin/member/authenticated/anonymous/blanket guests', async () => {
    const token = `listed-matrix-${seq}`;
    const target = await store.upsertPage({name: `target-${seq}`, data: snapshot()});
    const hidden = await store.upsertPage({
      name: `${token}-hidden`,
      data: snapshot(`${token} hidden`, [target.id]),
    });
    const visible = await store.upsertPage({
      name: `${token}-visible`,
      data: snapshot(`${token} visible`, [target.id, hidden.id]),
    });
    const host = await store.upsertPage({name: `database-${seq}`, data: snapshot()});
    const database = await store.createDatabase({
      pageId: host.id,
      name: `database-${seq}`,
      schema: {properties: [], views: []},
    });
    const visibleRow = await store.createRow(database.id, {name: `visible-row-${seq}`});
    const hiddenRow = await store.createRow(database.id, {name: `hidden-row-${seq}`});
    const visibleTrash = await store.upsertPage({name: `visible-trash-${seq}`, data: snapshot()});
    const hiddenTrash = await store.upsertPage({name: `hidden-trash-${seq}`, data: snapshot()});

    for (const id of [target.id, hidden.id, visible.id, host.id, visibleTrash.id, hiddenTrash.id]) {
      await store.setPageVisibility(id, 'public');
    }
    await store.setPageVisibility(hidden.id, {listed: false});
    await store.setPageVisibility(hiddenRow.id, {listed: false});
    await store.setPageVisibility(hiddenTrash.id, {listed: false});
    await store.deletePage(visibleTrash.id);
    await store.deletePage(hiddenTrash.id);

    const ai = new AiService(db, join(dir, 'models'));
    let nonPrivilegedContentCases = 0;

    const assertSurfaces = async (
      label: string,
      a: ReturnType<typeof createApp>,
      actor: Principal,
      jws: string | undefined,
      privileged: boolean,
    ): Promise<void> => {
      const headers = {'X-OpenBook-Client': '1', ...(jws ? {[IDENTITY_HEADER]: jws} : {})};
      const getJson = async <T>(path: string): Promise<T> => {
        const res = await a.request(path, {headers});
        expect(res.status, `${label}: GET ${path}`).toBe(200);
        return res.json() as Promise<T>;
      };
      const ids = (items: Array<{id: string}>): string[] => items.map((item) => item.id);
      const expectPresence = (actual: string[], id: string, present: boolean, message: string): void => {
        if (present) expect(actual, message).toContain(id);
        else expect(actual, message).not.toContain(id);
      };

      const list = await getJson<PageMeta[]>('/api/pages');
      expect(ids(list), `${label}: list visible`).toContain(visible.id);
      expectPresence(ids(list), hidden.id, privileged, `${label}: list hidden`);
      if (privileged) {
        expect(list.find((meta) => meta.id === hidden.id), `${label}: list preserves hidden metadata`).toMatchObject({
          listed: false,
        });
      }

      const frame = (await streamGates(store, actor).list({
        type: 'list',
        pages: await store.listPages(),
      })) as ListEvent;
      expect(ids(frame.pages), `${label}: stream visible`).toContain(visible.id);
      expectPresence(ids(frame.pages), hidden.id, privileged, `${label}: stream hidden`);
      if (privileged) {
        expect(frame.pages.find((meta) => meta.id === hidden.id), `${label}: stream preserves hidden metadata`).toMatchObject({
          listed: false,
        });
      }

      const graph = await getJson<{
        nodes: Array<{id: string}>;
        edges: Array<{from: string; to: string}>;
      }>('/api/page-graph');
      expectPresence(ids(graph.nodes), hidden.id, privileged, `${label}: graph hidden node`);
      expect(
        graph.edges.some((edge) => edge.from === hidden.id || edge.to === hidden.id),
        `${label}: graph hidden edges`,
      ).toBe(privileged);

      const backlinks = await getJson<Array<{id: string}>>(`/api/pages/${target.id}/backlinks`);
      expect(ids(backlinks), `${label}: backlinks visible`).toContain(visible.id);
      expectPresence(ids(backlinks), hidden.id, privileged, `${label}: backlinks hidden`);

      const searchRes = await a.request('/api/ai/search', {
        method: 'POST',
        headers: {'Content-Type': 'application/json', ...headers},
        body: JSON.stringify({query: token, limit: 25}),
      });
      expect(searchRes.status, `${label}: search status`).toBe(200);
      const search = (await searchRes.json()) as {results: Array<{pageId: string}>};
      const searchIds = search.results.map((result) => result.pageId);
      expect(searchIds, `${label}: search visible`).toContain(visible.id);
      expectPresence(searchIds, hidden.id, privileged, `${label}: search hidden`);

      const trash = await getJson<Array<{id: string}>>('/api/trash');
      expect(ids(trash), `${label}: trash visible`).toContain(visibleTrash.id);
      expectPresence(ids(trash), hiddenTrash.id, privileged, `${label}: trash hidden`);

      const rows = await getJson<Array<{id: string}>>(`/api/databases/${database.id}/rows`);
      expect(ids(rows), `${label}: rows visible`).toContain(visibleRow.id);
      expectPresence(ids(rows), hiddenRow.id, privileged, `${label}: rows hidden`);

      // `listed` is discovery-only: a readable direct URL remains readable.
      expect((await a.request(`/api/pages/${hidden.id}`, {headers})).status, `${label}: direct GET`).toBe(200);

      // The multiplexed stream is a discovery surface too: snapshots, incremental
      // collaboration, presence and even tombstone ids for an unlisted page are
      // absent for every non-listing-privileged principal. Owner/admin retain them.
      const hiddenPage = (await store.getPage(hidden.id))!;
      const liveGate = streamGates(store, actor).live;
      for (const event of [
        {type: 'page' as const, page: hiddenPage},
        {type: 'yupdate' as const, pageId: hidden.id, update: 'secret-update', clientId: 41},
        {type: 'awareness' as const, pageId: hidden.id, update: 'secret-presence', clientId: 42},
        // Use a row that is actually soft-deleted: the gate must inspect its
        // retained listed posture rather than relying on the live-page query.
        {type: 'deleted' as const, id: hiddenTrash.id},
      ]) {
        const gated = await liveGate(event);
        if (privileged) expect(gated, `${label}: ${event.type} hidden frame`).not.toBeNull();
        else expect(gated, `${label}: ${event.type} hidden frame`).toBeNull();
      }
      if (!privileged) nonPrivilegedContentCases += 1;
    };

    // Rule-0 makes this guest blanket-readable, but it is not an owner/admin and
    // therefore must still lose unlisted pages before every fast path.
    await assertSurfaces(
      'blanket-read guest',
      createApp(store, ai, new PageHub()),
      guestPrincipal(),
      undefined,
      false,
    );

    await store.updateInstanceConfig({
      trustedIssuers: [{issuer: ISS, jwks}],
      ownerSubject: `${ISS}#owner`,
      defaultVisibility: 'public',
      // Search is a POST; `write` lets the anonymous principal reach its
      // read-only result gate instead of being stopped by the guest method floor.
      guestAccess: 'write',
    });
    await store.addMember({subject: `${ISS}#admin`, role: 'admin', status: 'active'});
    await store.addMember({subject: `${ISS}#member`, role: 'viewer', status: 'active'});
    await store.setPageAcl(hidden.id, {subject: `${ISS}#acl-reader`, level: 'read'});
    await store.setPageAcl(hidden.id, {subject: `${ISS}#acl-writer`, level: 'write'});
    const shared = createApp(store, ai, new PageHub(), {identity: new IdentityService(store)});
    const cases = [
      {label: 'owner', actor: principal('owner'), jws: await idFor('owner'), privileged: true},
      {label: 'admin', actor: principal('admin'), jws: await idFor('admin'), privileged: true},
      {label: 'member', actor: principal('member'), jws: await idFor('member'), privileged: false},
      {label: 'authenticated', actor: principal('stranger'), jws: await idFor('stranger'), privileged: false},
      {label: 'anonymous guest', actor: guestPrincipal(), jws: undefined, privileged: false},
      {label: 'ACL reader', actor: principal('acl-reader'), jws: await idFor('acl-reader'), privileged: false},
      {label: 'ACL writer', actor: principal('acl-writer'), jws: await idFor('acl-writer'), privileged: false},
    ];
    for (const entry of cases) {
      await assertSurfaces(entry.label, shared, entry.actor, entry.jws, entry.privileged);
    }
    expect(nonPrivilegedContentCases).toBe(6);
  });

  it('keeps a visitor-opened unlisted page live through the direct page-stream fallback', async () => {
    await store.updateInstanceConfig({
      trustedIssuers: [{issuer: ISS, jwks}],
      ownerSubject: `${ISS}#owner`,
      defaultVisibility: 'public',
      guestAccess: 'read',
    });
    const hidden = await store.upsertPage({
      name: `fallback-${seq}`,
      data: snapshot('initial'),
      listed: false,
    });
    await store.setPageVisibility(hidden.id, 'public');

    const hub = new PageHub();
    const a = createApp(store, undefined, hub, {identity: new IdentityService(store)});
    const openedUrls: string[] = [];
    const visitor = new HttpDataClient('', undefined, {
      fetchImpl: appFetch(a),
      createLiveSource: appLiveSource(a, openedUrls),
    });
    const seen: string[] = [];
    const deleted: string[] = [];
    const unsubscribe = visitor.subscribePage(hidden.id, {
      onPage: (page) => seen.push(JSON.stringify(page.data)),
      onDeleted: (id) => deleted.push(id),
    });

    await waitFor(() => openedUrls.includes('/api/live'));
    await waitFor(() => openedUrls.includes(`/api/pages/${hidden.id}/stream`));
    await waitFor(() => seen.some((body) => body.includes('initial')));

    const ownerHeaders = {
      'Content-Type': 'application/json',
      'X-OpenBook-Client': '1',
      [IDENTITY_HEADER]: await idFor('owner'),
    };
    const save = await a.request(`/api/pages/${hidden.id}`, {
      method: 'PUT',
      headers: ownerHeaders,
      body: JSON.stringify({id: hidden.id, name: hidden.name, data: snapshot('fallback-update')}),
    });
    expect(save.status).toBe(200);
    await waitFor(() => seen.some((body) => body.includes('fallback-update')));

    const remove = await a.request(`/api/pages/${hidden.id}`, {method: 'DELETE', headers: ownerHeaders});
    expect(remove.status).toBe(204);
    await waitFor(() => deleted.includes(hidden.id));

    unsubscribe();
    // Let the firehose's asynchronous canListPage tombstone gate settle before
    // afterEach closes PGlite; the page-stream deletion arrives independently.
    await new Promise((resolve) => setTimeout(resolve, 100));
  });

  it('removes a listed→false page from an open hub stream in the next list frame', async () => {
    await store.updateInstanceConfig({
      trustedIssuers: [{issuer: ISS, jwks}],
      ownerSubject: `${ISS}#owner`,
      defaultVisibility: 'public',
    });
    await store.addMember({subject: `${ISS}#member`, role: 'viewer', status: 'active'});
    const page = await store.upsertPage({name: `flip-${seq}`, data: snapshot()});
    await store.setPageVisibility(page.id, 'public');

    const hub = new PageHub();
    const a = createApp(store, undefined, hub, {identity: new IdentityService(store)});
    const waiters: Array<(event: ListEvent) => void> = [];
    const unsubscribe = hub.subscribeList(
      (event) => waiters.shift()?.(event),
      streamGates(store, principal('member')).list,
    );
    const nextFrame = (): Promise<ListEvent> => new Promise((resolve) => waiters.push(resolve));

    const before = nextFrame();
    hub.publishList(await store.listPages());
    expect((await before).pages.map((meta) => meta.id)).toContain(page.id);

    const after = nextFrame();
    const flip = await a.request(`/api/pages/${page.id}/visibility`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-OpenBook-Client': '1',
        [IDENTITY_HEADER]: await idFor('owner'),
      },
      body: JSON.stringify({listed: false}),
    });
    expect(flip.status).toBe(200);
    expect((await after).pages.map((meta) => meta.id)).not.toContain(page.id);
    unsubscribe();
  });
});
