/**
 * In-webview lexical content search. The hosted {@link AiService} carries the
 * generative engine (node-only: `node:fs`, model providers) and so is stubbed
 * out in the browser bundle — but lexical BM25 search needs *no* engine, only
 * the page text. This class gives the embedded {@link LocalDataClient} the same
 * content search the HTTP client gets from the server, reusing the shared pure
 * index/search primitives in `./search` so both transports rank identically.
 *
 * No Node imports: it depends only on the {@link PageStore} (already in the
 * browser bundle) and the pure `./search` module. See `browser.ts`.
 */
import type {AiSearchResponse} from '@book.dev/sdk';
import type {PageStore} from '../store';
import {assembleSearchResults, bm25Scores, buildIndex, pageRowsToDocs, type Bm25Index} from './search';

export class LocalSearchIndex {
  private index: Bm25Index | null = null;
  // Bumped by page writes; when it moves past `indexedVersion` the next
  // `ensureIndex` rebuilds. Mirrors AiService's staleness counter.
  private indexVersion = 0;
  private indexedVersion = -1;

  constructor(private readonly store: PageStore) {}

  /** Mark the index stale — call after any page write (mirrors app.ts). */
  invalidate(): void {
    this.indexVersion += 1;
  }

  /** Build the index if missing or stale (or `force`). Cheap when fresh. */
  async ensureIndex(force = false): Promise<Bm25Index> {
    if (!force && this.index && this.indexedVersion === this.indexVersion) return this.index;
    const version = this.indexVersion;
    this.index = buildIndex(pageRowsToDocs(await this.store.indexablePages()));
    this.indexedVersion = version;
    return this.index;
  }

  /**
   * Rank the index for a query. Local mode is single-owner, so there is no
   * per-principal read gate — every page is the caller's to read. Always
   * `mode: 'lexical'`: no engine to embed with.
   */
  async search(query: string, limit = 8): Promise<AiSearchResponse> {
    if (!query.trim()) return {results: [], mode: 'lexical'};
    const index = await this.ensureIndex();
    const ranked = bm25Scores(index, query).slice(0, limit * 4);
    return {results: await assembleSearchResults(index, ranked, query, limit), mode: 'lexical'};
  }

  /** Force a rebuild and report its size — backs `aiIndex()`. */
  async reindex(): Promise<{pages: number; chunks: number}> {
    const index = await this.ensureIndex(true);
    return {pages: new Set(index.docs.map((d) => d.pageId)).size, chunks: index.docs.length};
  }
}
