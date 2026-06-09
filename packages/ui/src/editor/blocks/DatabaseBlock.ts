import type {API, BlockTool, BlockToolConstructorOptions, BlockToolData, ToolboxConfig} from '@editorjs/editorjs';
import {pageLinks} from '@/lib/pageLinks';

/**
 * The handshake between an inline {@link DatabaseBlock} and the document that
 * hosts it. EditorJS instantiates block tools outside React's context (each
 * block owns a plain DOM node), so a block can't render the React
 * `DatabaseView` itself — that view needs the data/navigation providers. Instead
 * the block hands its DOM node to the document via this registry, and
 * `PageDocument` portals a `DatabaseView` into it from *inside* the provider
 * tree (so hooks like `useData` resolve). Same singleton-bridge idea as
 * {@link pageLinks}, but per-editor and carrying a DOM mount point.
 */
/** What a registered inline-database block needs the host to render for it. */
export interface InlineDatabaseEntry {
  /** The host page of the database to show; null until created/linked (chooser). */
  pageId: string | null;
  /** Create a fresh child database for this block. */
  onCreate: () => void;
  /** Link an existing database (its host page id) to this block. */
  onPick: (pageId: string) => void;
}

export interface InlineDatabaseRegistry {
  /** A block mounted its node and described what to render (view, or a chooser). */
  register(blockId: string, el: HTMLElement, entry: InlineDatabaseEntry): void;
  /** The block resolved its database page (created or linked). */
  setPageId(blockId: string, pageId: string): void;
  /** The block was destroyed (removed / editor torn down). */
  unregister(blockId: string): void;
}

interface DatabaseBlockData extends BlockToolData {
  /** The host page of this inline database. Created or linked once, then persisted. */
  pageId?: string;
}

// Dedup child-database creation across block instances (React StrictMode double
// mounts; an editor re-init before the id is persisted re-instantiates the
// block) so a single block makes exactly one child database. Mirrors SubpageBlock.
const creatingByBlockId = new Map<string, Promise<string>>();

const DB_ICON =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14a9 3 0 0 0 18 0V5"/><path d="M3 12a9 3 0 0 0 18 0"/></svg>';

/**
 * An EditorJS block that embeds a database **inline** in a document. On insert
 * it creates a child page hosting a database (nested under the page being
 * edited) and records its id; the host document portals a live `DatabaseView`
 * into the block, so the full table/board/gallery/chart UI — with its own views,
 * properties, and rows — renders right inside the page.
 */
export class DatabaseBlock implements BlockTool {
  private readonly data: DatabaseBlockData;
  private readonly block: BlockToolConstructorOptions<DatabaseBlockData>['block'];
  private readonly config: Record<string, unknown>;
  private readonly blockId: string;
  private dom: HTMLElement | null = null;
  private creating: Promise<string> | null = null;

  constructor({data, block, config}: BlockToolConstructorOptions<DatabaseBlockData> & {api?: API}) {
    this.data = data ?? {};
    this.block = block;
    this.config = (config as Record<string, unknown> | undefined) ?? {};
    this.blockId = block?.id ?? `db-${Math.random().toString(36).slice(2)}`;
  }

  static get toolbox(): ToolboxConfig {
    return {title: 'Inline database', icon: DB_ICON};
  }

  static get pasteConfig(): false {
    return false;
  }

  private get hostPageId(): string | undefined {
    return typeof this.config.hostPageId === 'string' ? this.config.hostPageId : undefined;
  }

  private get registry(): InlineDatabaseRegistry | undefined {
    return this.config.registry as InlineDatabaseRegistry | undefined;
  }

  /** Create the child database page exactly once for this block. */
  private ensureCreated(): Promise<string> {
    if (!this.creating) {
      let shared = creatingByBlockId.get(this.blockId);
      if (!shared) {
        shared = pageLinks.createSubpage(this.hostPageId!, 'database');
        creatingByBlockId.set(this.blockId, shared);
        shared.catch(() => creatingByBlockId.delete(this.blockId));
      }
      this.creating = shared.then((id) => {
        this.data.pageId = id;
        // Persist the new child id into the block (so a reload reuses it instead
        // of orphaning a fresh database), and tell the host to portal the view in.
        this.block?.dispatchChange();
        this.registry?.setPageId(this.blockId, id);
        return id;
      });
    }
    return this.creating;
  }

  /** Persist a linked database choice (an existing database's host page). */
  private link(pageId: string): void {
    this.data.pageId = pageId;
    this.block?.dispatchChange();
    this.registry?.setPageId(this.blockId, pageId);
  }

  render(): HTMLElement {
    this.dom = document.createElement('div');
    this.dom.className = 'block-database';
    // A fresh block has no database yet — the host renders a chooser ("new" vs
    // "link existing"); we don't auto-create, so the choice is the user's.
    this.registry?.register(this.blockId, this.dom, {
      pageId: this.data.pageId ?? null,
      onCreate: () => void this.ensureCreated().catch(() => undefined),
      onPick: (id) => this.link(id),
    });
    return this.dom;
  }

  destroy(): void {
    this.registry?.unregister(this.blockId);
  }

  async save(): Promise<DatabaseBlockData> {
    if (!this.data.pageId && this.creating) {
      try {
        await this.creating;
      } catch {
        // creation failed; persist without a pageId so the block can be removed
      }
    }
    return {pageId: this.data.pageId};
  }
}
