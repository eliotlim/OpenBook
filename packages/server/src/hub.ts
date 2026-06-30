import type {DatabaseRow, PageMeta, StoredPage} from '@book.dev/sdk';

/** An update to a single page, pushed to subscribers of that page. */
export type PageEvent = {type: 'page'; page: StoredPage} | {type: 'deleted'; id: string};
/** The current page list, pushed to subscribers of the list. */
export type ListEvent = {type: 'list'; pages: PageMeta[]};
/** The current row list of a database, pushed to its subscribers. */
export type RowsEvent = {type: 'rows'; rows: DatabaseRow[]};

/**
 * The unified event a single client multiplexes over one connection. Each tab
 * opens exactly one live stream and filters these by the ids it cares about —
 * so N open pages/databases cost one connection, not N (browsers cap concurrent
 * connections per origin, and that cap is shared across tabs).
 */
export type LiveEvent =
  | {type: 'list'; pages: PageMeta[]}
  | {type: 'page'; page: StoredPage}
  | {type: 'deleted'; id: string}
  | {type: 'rows'; databaseId: string; rows: DatabaseRow[]}
  // Live collaboration (Collab T1): an opaque incremental Yjs update (base64)
  // relayed for a page, carrying the author's `Y.Doc` clientId so the author's own
  // connection can drop the echo. Ephemeral — never persisted (see publishPageUpdate).
  | {type: 'yupdate'; pageId: string; update: string; clientId: number}
  // Live collaboration (Collab T4): an ephemeral awareness/presence update (base64
  // `y-protocols/awareness` bytes) for a page. The identity it carries is re-stamped
  // by the server from the verified principal before it reaches here, so the body
  // can't spoof who-you-are. `clientId` lets the author drop its own echo. Never
  // persisted, never read by the durable store (see publishPageAwareness).
  | {type: 'awareness'; pageId: string; update: string; clientId: number};

/**
 * A per-subscriber access gate (OB-190, contract §1.4 / S4). Given an outbound
 * event it returns the event the subscriber may actually see — possibly with
 * unreadable pages/rows filtered out — or `null` to drop it entirely. Async so it
 * can run an `authorize()` decision against the store. A subscription with **no**
 * gate (the legacy single-user path) receives every event unchanged.
 *
 * This is what makes the fan-out principal-aware **by construction**: the hub will
 * not hand an event to a subscriber whose gate rejects (or empties) it, so a live
 * channel cannot become a silent read bypass.
 */
export type EventGate<E> = (event: E) => E | null | Promise<E | null>;

interface Subscription<E> {
  fn: (event: E) => void;
  gate?: EventGate<E>;
}

type PageListener = (event: PageEvent) => void;
type ListListener = (event: ListEvent) => void;
type RowsListener = (event: RowsEvent) => void;
type LiveListener = (event: LiveEvent) => void;

/**
 * In-memory pub/sub powering live updates. Every write to the store publishes
 * here, and the SSE endpoints relay events to connected clients — this is the
 * server-driven refresh loop that keeps collaborators in sync.
 *
 * Two relay shapes are supported: per-resource subscriptions (one channel per
 * page id / database id) and a single firehose ({@link subscribeLive}) carrying
 * everything. The client uses the firehose so each tab needs only one stream.
 *
 * Each subscription may carry an {@link EventGate} (OB-190): the hub evaluates it
 * per event before delivery, so an unreadable page/row never reaches a subscriber
 * that may not see it (and a stream that loses read access simply stops emitting).
 */
export class PageHub {
  private readonly pageListeners = new Map<string, Set<Subscription<PageEvent>>>();
  private readonly listListeners = new Set<Subscription<ListEvent>>();
  private readonly rowsListeners = new Map<string, Set<Subscription<RowsEvent>>>();
  private readonly liveListeners = new Set<Subscription<LiveEvent>>();

  /** Run an event through a subscription's gate (if any), then deliver what
   *  survives. A gate that throws or rejects drops the event (fail-closed). */
  private static deliver<E>(sub: Subscription<E>, event: E): void {
    if (!sub.gate) {
      sub.fn(event);
      return;
    }
    let gated: E | null | Promise<E | null>;
    try {
      gated = sub.gate(event);
    } catch {
      return; // fail closed
    }
    if (gated && typeof (gated as Promise<E | null>).then === 'function') {
      void (gated as Promise<E | null>).then((g) => (g ? sub.fn(g) : undefined)).catch(() => undefined);
    } else if (gated) {
      sub.fn(gated as E);
    }
  }

  subscribePage(id: string, fn: PageListener, gate?: EventGate<PageEvent>): () => void {
    let set = this.pageListeners.get(id);
    if (!set) {
      set = new Set();
      this.pageListeners.set(id, set);
    }
    const sub: Subscription<PageEvent> = {fn, gate};
    set.add(sub);
    return () => {
      const current = this.pageListeners.get(id);
      current?.delete(sub);
      if (current && current.size === 0) this.pageListeners.delete(id);
    };
  }

  subscribeList(fn: ListListener, gate?: EventGate<ListEvent>): () => void {
    const sub: Subscription<ListEvent> = {fn, gate};
    this.listListeners.add(sub);
    return () => this.listListeners.delete(sub);
  }

  subscribeRows(databaseId: string, fn: RowsListener, gate?: EventGate<RowsEvent>): () => void {
    let set = this.rowsListeners.get(databaseId);
    if (!set) {
      set = new Set();
      this.rowsListeners.set(databaseId, set);
    }
    const sub: Subscription<RowsEvent> = {fn, gate};
    set.add(sub);
    return () => {
      const current = this.rowsListeners.get(databaseId);
      current?.delete(sub);
      if (current && current.size === 0) this.rowsListeners.delete(databaseId);
    };
  }

  /** Subscribe to the firehose of every event (list / page / deleted / rows). */
  subscribeLive(fn: LiveListener, gate?: EventGate<LiveEvent>): () => void {
    const sub: Subscription<LiveEvent> = {fn, gate};
    this.liveListeners.add(sub);
    return () => this.liveListeners.delete(sub);
  }

  publishPage(page: StoredPage): void {
    this.pageListeners.get(page.id)?.forEach((sub) => PageHub.deliver<PageEvent>(sub, {type: 'page', page}));
    this.liveListeners.forEach((sub) => PageHub.deliver<LiveEvent>(sub, {type: 'page', page}));
  }

  publishDeleted(id: string): void {
    this.pageListeners.get(id)?.forEach((sub) => PageHub.deliver<PageEvent>(sub, {type: 'deleted', id}));
    this.liveListeners.forEach((sub) => PageHub.deliver<LiveEvent>(sub, {type: 'deleted', id}));
  }

  publishList(pages: PageMeta[]): void {
    this.listListeners.forEach((sub) => PageHub.deliver<ListEvent>(sub, {type: 'list', pages}));
    this.liveListeners.forEach((sub) => PageHub.deliver<LiveEvent>(sub, {type: 'list', pages}));
  }

  publishRows(databaseId: string, rows: DatabaseRow[]): void {
    this.rowsListeners.get(databaseId)?.forEach((sub) => PageHub.deliver<RowsEvent>(sub, {type: 'rows', rows}));
    this.liveListeners.forEach((sub) => PageHub.deliver<LiveEvent>(sub, {type: 'rows', databaseId, rows}));
  }

  /**
   * Relay one incremental Yjs update for a page to the firehose (Collab T1). Pure
   * fan-out — it writes nothing to the store (the debounced snapshot save is the
   * durable checkpoint); each firehose subscriber's `live` gate still read-filters
   * it, and the `clientId` lets a subscriber drop its own echo. Catch-up for a late
   * joiner is handled separately by {@link CollabRelay}.
   */
  publishPageUpdate(pageId: string, update: string, clientId: number): void {
    this.liveListeners.forEach((sub) => PageHub.deliver<LiveEvent>(sub, {type: 'yupdate', pageId, update, clientId}));
  }

  /**
   * Relay one ephemeral awareness/presence update for a page to the firehose
   * (Collab T4). Like {@link publishPageUpdate} it is pure fan-out — writes nothing
   * to the store and rides each subscriber's `live` read-gate (so an unreadable
   * page's presence never leaks). The `update` bytes must ALREADY be
   * identity-stamped by the caller (the route re-stamps from the verified
   * principal); the hub is transport, not policy.
   */
  publishPageAwareness(pageId: string, update: string, clientId: number): void {
    this.liveListeners.forEach((sub) => PageHub.deliver<LiveEvent>(sub, {type: 'awareness', pageId, update, clientId}));
  }

  /** Whether anyone is watching a database's rows (per-db channel or firehose). */
  hasRowsListeners(databaseId: string): boolean {
    return (this.rowsListeners.get(databaseId)?.size ?? 0) > 0 || this.liveListeners.size > 0;
  }
}
