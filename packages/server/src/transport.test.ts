import {describe, expect, it} from 'vitest';
import {HttpDataClient, type FetchLike, type LiveSourceLike, type PageMeta} from '@open-book/sdk';

/** A LiveSourceLike whose events can be driven by the test. */
function fakeSource(): LiveSourceLike & {emit: (type: string, data: string) => void} {
  const handlers = new Map<string, Array<(e: {data?: string}) => void>>();
  return {
    addEventListener(type, handler) {
      const list = handlers.get(type) ?? [];
      list.push(handler);
      handlers.set(type, list);
    },
    close() {
      handlers.clear();
    },
    emit(type, data) {
      for (const h of handlers.get(type) ?? []) h({data});
    },
  };
}

const okFetch: FetchLike = async () => new Response('[]', {status: 200, headers: {'Content-Type': 'application/json'}});

describe('HttpDataClient — pluggable transport', () => {
  it('routes requests through an injected fetchImpl instead of global fetch', async () => {
    const calls: Array<{input: string; method?: string}> = [];
    const fetchImpl: FetchLike = async (input, init) => {
      calls.push({input, method: init?.method});
      return new Response(JSON.stringify([{id: 'p1', name: 'X'}]), {status: 200});
    };

    // Empty baseUrl + IPC fetch: the path arrives verbatim for the host to route.
    const client = new HttpDataClient('', undefined, {fetchImpl, createLiveSource: () => fakeSource()});
    const pages = await client.listPages();

    expect(pages).toEqual([{id: 'p1', name: 'X'}]);
    expect(calls[0]).toEqual({input: '/api/pages', method: 'GET'});
  });

  it('delivers live page-list updates through an injected source', () => {
    const source = fakeSource();
    const client = new HttpDataClient('', undefined, {fetchImpl: okFetch, createLiveSource: () => source});

    const seen: PageMeta[][] = [];
    client.subscribePages((pages) => seen.push(pages));

    source.emit('list', JSON.stringify({type: 'list', pages: [{id: 'p1', name: 'Live'}]}));
    expect(seen.at(-1)?.map((p) => p.id)).toEqual(['p1']);
  });

  it('resyncs open subscriptions on reconnect (error then open)', async () => {
    const source = fakeSource();
    let listCalls = 0;
    const fetchImpl: FetchLike = async (input) => {
      if (input === '/api/pages') listCalls += 1;
      return new Response(JSON.stringify([{id: 'p1', name: 'Resynced'}]), {status: 200});
    };
    const client = new HttpDataClient('', undefined, {fetchImpl, createLiveSource: () => source});

    const seen: PageMeta[][] = [];
    client.subscribePages((pages) => seen.push(pages));

    // A drop then a reconnect must re-fetch the page list (OB-132 resync).
    source.emit('error', '');
    source.emit('open', '');
    await new Promise((r) => setTimeout(r, 0));
    expect(listCalls).toBeGreaterThan(0);
    expect(seen.at(-1)?.[0]?.name).toBe('Resynced');
  });
});
