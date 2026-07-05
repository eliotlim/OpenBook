import {describe, expect, it} from 'vitest';
import {pageIslandScript, HTML_ARTIFACT_PENDING_PROP, type PageInput, type StoredPage, type ImportedBlock, type PageSnapshot} from '@book.dev/sdk';
import {parseHtmlImport} from '../htmlImport';
import {
  artifactChoiceFor,
  htmlDocTitle,
  preferArtifactImport,
  runArtifactImport,
  type ArtifactImportClient,
} from '../artifactImport';

/**
 * Run-as-artifact HTML import: the script/canvas heuristic that preselects the
 * chooser, <title> extraction, the one seam that keeps island files OUT of the
 * chooser, and the land-then-rehydrate flow (page via importDoc, bytes via
 * putAsset, pending block rewritten to the assetId).
 */

const COUNTER = '<html><head><title>Counter Widget</title></head><body><button id="b">go</button><script>1</script></body></html>';
const PLAIN = '<html><head><title>Plain Notes</title></head><body><h2>Section</h2><p>Text.</p></body></html>';

describe('preferArtifactImport — the chooser default heuristic', () => {
  it('preselects artifact for <script>-bearing HTML', () => {
    expect(preferArtifactImport(COUNTER)).toBe(true);
    expect(preferArtifactImport('<SCRIPT src="x.js"></SCRIPT>')).toBe(true); // case-insensitive
  });

  it('preselects artifact for <canvas>-bearing HTML', () => {
    expect(preferArtifactImport('<body><canvas width="100"></canvas></body>')).toBe(true);
  });

  it('preselects convert for plain markup', () => {
    expect(preferArtifactImport(PLAIN)).toBe(false);
    expect(preferArtifactImport('')).toBe(false);
    // Words like "description" or a <scripture> tag must not trip the regex.
    expect(preferArtifactImport('<p>the script of the play</p><scripture/>')).toBe(false);
  });
});

describe('htmlDocTitle', () => {
  it('extracts and trims the <title> text', () => {
    expect(htmlDocTitle(COUNTER)).toBe('Counter Widget');
    expect(htmlDocTitle('<title>\n  Spaced   out \n</title>')).toBe('Spaced out');
  });

  it('decodes the entities titles legitimately carry', () => {
    expect(htmlDocTitle('<title>Q&amp;A &lt;draft&gt; &quot;v2&quot;</title>')).toBe('Q&A <draft> "v2"');
  });

  it('returns null when absent or empty (caller falls back to the file name)', () => {
    expect(htmlDocTitle('<p>no title</p>')).toBeNull();
    expect(htmlDocTitle('<title>   </title>')).toBeNull();
  });
});

describe('artifactChoiceFor — the chooser seam', () => {
  it('offers the choice for foreign HTML, titled from <title> first', () => {
    const parsed = parseHtmlImport(COUNTER);
    const choice = artifactChoiceFor(parsed, COUNTER, 'my_counter.html');
    expect(choice).toEqual({html: COUNTER, title: 'Counter Widget', preferArtifact: true});
  });

  it('falls back to the file name when there is no <title>', () => {
    const html = '<body><p>hi</p></body>';
    const choice = artifactChoiceFor(parseHtmlImport(html), html, 'weekly_report.html');
    expect(choice?.title).toBe('weekly report');
    expect(choice?.preferArtifact).toBe(false);
  });

  it('BYPASSES the chooser for island-bearing HTML (OpenBook exports)', () => {
    // A real page island, the shape every OpenBook HTML export embeds — island
    // handling belongs to the lossless restore path, never the chooser.
    const island = pageIslandScript({
      id: 'orig-1',
      name: 'Exported Page',
      icon: null,
      updatedAt: '2026-01-01',
      data: {
        editor: 'blocks',
        blockdoc: {blocks: [{id: 'p', type: 'paragraph', text: [{t: 'hi'}]}]},
        editorjs: {blocks: []},
        values: [],
        names: [],
      } as unknown as PageSnapshot,
    });
    const html = `<html><head><title>Exported Page</title></head><body><p>hi</p>${island}<script>runtime()</script></body></html>`;
    const parsed = parseHtmlImport(html);
    expect(parsed.kind).toBe('island'); // sanity: the island IS detected…
    expect(artifactChoiceFor(parsed, html, 'export.html')).toBeNull(); // …so no chooser
  });
});

/** A capturing mock of the client surface a run-as-artifact import drives
 *  (mirrors islandImport.test's mock; putAsset is content-addressed). */
function mockClient() {
  const saved: PageInput[] = [];
  const pages = new Map<string, StoredPage>();
  const putCalls: Array<{bytes: Uint8Array; mime: string; pageId: string}> = [];
  const store = (input: PageInput, id: string): StoredPage => {
    const page: StoredPage = {
      id,
      name: input.name ?? null,
      data: input.data,
      hostedDatabaseId: null,
      databaseId: null,
      parentId: input.parentId ?? null,
      properties: {},
      deletedAt: null,
      createdAt: '',
      updatedAt: '',
    } as StoredPage;
    pages.set(id, page);
    return page;
  };
  const client = {
    savePage: async (input: PageInput): Promise<StoredPage> => {
      saved.push(input);
      const id = (input as {id?: string}).id ?? `landed-${saved.length}`;
      return store(input, id);
    },
    getPage: async (id: string): Promise<StoredPage | null> => pages.get(id) ?? null,
    setPageProperties: async () => undefined,
    createDatabase: async () => {
      throw new Error('unused');
    },
    createRow: async () => {
      throw new Error('unused');
    },
    importSpace: async () => {
      throw new Error('unused — a single artifact page uses the create strategy');
    },
    putAsset: async (bytes: Uint8Array, mime: string, pageId: string) => {
      putCalls.push({bytes, mime, pageId});
      return {id: `sha-${bytes.byteLength}`}; // content-addressed stand-in
    },
  } as unknown as ArtifactImportClient;
  return {client, saved, putCalls, pages};
}

describe('runArtifactImport — land page, upload bytes, rewrite the pending block', () => {
  it('creates one page titled from the choice, uploads text/html bytes ref’d to it, and sets the assetId', async () => {
    const {client, saved, putCalls, pages} = mockClient();
    const result = await runArtifactImport(client, {html: COUNTER, title: 'Counter Widget', preferArtifact: true});

    expect(result.pageIds).toHaveLength(1);
    const landedId = result.pageIds[0];
    expect(saved[0].name).toBe('Counter Widget');

    // Bytes went to the store AS the original file, ref'd to the LANDED page.
    expect(putCalls).toHaveLength(1);
    expect(putCalls[0].mime).toBe('text/html');
    expect(putCalls[0].pageId).toBe(landedId);
    expect(new TextDecoder().decode(putCalls[0].bytes)).toBe(COUNTER);

    // The pending block was rewritten: assetId set, marker gone, title kept.
    const blocks = (pages.get(landedId)!.data.blockdoc as {blocks: ImportedBlock[]}).blocks;
    const art = blocks.find((b) => b.type === 'htmlArtifact')!;
    expect(art.props?.assetId).toBe(`sha-${putCalls[0].bytes.byteLength}`);
    expect(art.props?.title).toBe('Counter Widget');
    expect(art.props?.[HTML_ARTIFACT_PENDING_PROP]).toBeUndefined();
  });

  it('rejects an over-cap (>10 MiB) file BEFORE anything lands', async () => {
    const {client, saved, putCalls} = mockClient();
    const big = {html: 'x'.repeat(10 * 1024 * 1024 + 1), title: 'Big', preferArtifact: true};
    await expect(runArtifactImport(client, big)).rejects.toThrow(/over 10 MB/);
    expect(saved).toHaveLength(0);
    expect(putCalls).toHaveLength(0);
  });

  it('a failed upload degrades to the visible pending placeholder — the page still lands', async () => {
    const {client, saved, pages} = mockClient();
    (client as unknown as {putAsset: () => Promise<never>}).putAsset = () => Promise.reject(new Error('offline'));
    const result = await runArtifactImport(client, {html: PLAIN, title: 'Plain Notes', preferArtifact: false});
    expect(result.pageIds).toHaveLength(1);
    expect(saved).toHaveLength(1); // the page landed…
    const blocks = (pages.get(result.pageIds[0])!.data.blockdoc as {blocks: ImportedBlock[]}).blocks;
    const art = blocks.find((b) => b.type === 'htmlArtifact')!;
    // …with the pending marker intact (renders as the editor's add-artifact
    // placeholder), never silently dropped.
    expect(art.props?.[HTML_ARTIFACT_PENDING_PROP]).toBe(true);
    expect(art.props?.assetId).toBeUndefined();
  });
});
