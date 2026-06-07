import React, {useEffect, useReducer, useState} from 'react';
import type {ReactElement} from 'react';
import type {ToolboxConfig} from '@editorjs/editorjs';
import {ReactBlockTool} from './editorJsReactAdapter';
import {pageLinks, subscribePageLinks, type SubpageKind} from '@/lib/pageLinks';
import {t} from '@/i18n';

interface SubpageData {
  pageId?: string;
  kind?: SubpageKind;
}

// In-flight child creations, keyed by the block's stable id. `this.creating`
// already dedups within one block instance; this adds dedup *across* instances
// of the same block — React StrictMode double-mounts in dev, and an editor that
// re-inits before the new page id is persisted re-instantiates the block — so a
// single block still creates exactly one child page. A failed creation is
// dropped so it can be retried.
const creatingByBlockId = new Map<string, Promise<string>>();

interface SubpageViewProps {
  kind: SubpageKind;
  initialPageId: string | null;
  /** Create the child page (idempotent at the block level), or null if it can't. */
  ensureCreated: (() => Promise<string>) | null;
}

/** Inline link to a nested page/database. Creates the child once, after mount. */
const SubpageView: React.FC<SubpageViewProps> = ({kind, initialPageId, ensureCreated}) => {
  const [pageId, setPageId] = useState<string | null>(initialPageId);
  // Re-render when page titles/icons change (the bridge notifies subscribers).
  const [, force] = useReducer((x: number) => x + 1, 0);

  // Create the child once, in an effect (so EditorJS has finished inserting the
  // block before we touch the data layer). The actual creation is deduped on
  // the block instance, so a double render/mount still makes only one page.
  useEffect(() => {
    if (pageId || !ensureCreated) return;
    let cancelled = false;
    void ensureCreated()
      .then((id) => !cancelled && setPageId(id))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [pageId, ensureCreated]);

  useEffect(() => subscribePageLinks(force), []);

  if (!pageId) {
    return (
      <div className="rounded-md border border-border px-2.5 py-1.5 text-sm text-muted-foreground">
        {t('blocks.creating', {kind: kind === 'database' ? t('blocks.subpageDatabase') : t('blocks.subpagePage')})}
      </div>
    );
  }

  return (
    <button
      type="button"
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => pageLinks.openPage(pageId)}
      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent"
    >
      <span className="shrink-0 text-base leading-none">{pageLinks.icon(pageId)}</span>
      <span className="truncate font-medium underline decoration-muted-foreground/30 underline-offset-2">
        {pageLinks.label(pageId)}
      </span>
    </button>
  );
};

const PAGE_ICON =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';
const DB_ICON =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14a9 3 0 0 0 18 0V5"/><path d="M3 12a9 3 0 0 0 18 0"/></svg>';

/**
 * An EditorJS block that links to a nested page or database, inline in the
 * content. Selecting it from the block menu creates a child page under the page
 * being edited (the `hostPageId` passed via the tool config) and renders a
 * clickable link to it; clicking navigates there.
 */
export class SubpageBlock extends ReactBlockTool {
  private creating: Promise<string> | null = null;

  static get toolbox(): ToolboxConfig {
    return [
      {title: t('blocks.subpagePage'), icon: PAGE_ICON, data: {kind: 'page'}},
      {title: t('blocks.subpageDatabase'), icon: DB_ICON, data: {kind: 'database'}},
    ] as unknown as ToolboxConfig;
  }

  static get pasteConfig(): false {
    return false;
  }

  protected toolName(): string {
    return 'subpage';
  }

  private get hostPageId(): string | undefined {
    return typeof this.config.hostPageId === 'string' ? this.config.hostPageId : undefined;
  }

  /** Create the child page exactly once for this block, regardless of how many
   *  times the view mounts (EditorJS can render a block more than once). */
  private ensureCreated(): Promise<string> {
    if (!this.creating) {
      const data = this.data as SubpageData;
      let shared = creatingByBlockId.get(this.cellId);
      if (!shared) {
        shared = pageLinks.createSubpage(this.hostPageId!, data.kind === 'database' ? 'database' : 'page');
        creatingByBlockId.set(this.cellId, shared);
        // Let a failed creation be retried (but keep successes cached so a later
        // re-mount of the same block reuses the page instead of making a new one).
        shared.catch(() => creatingByBlockId.delete(this.cellId));
      }
      this.creating = shared.then((id) => {
        (this.data as SubpageData).pageId = id;
        // Persist the new page id into the document. Without this the block is
        // saved as `{kind}` with no `pageId`, so every reload thinks the child
        // is missing and creates another orphan. dispatchChange() fires the
        // editor's onChange, which autosaves the block (now carrying pageId).
        this.block?.dispatchChange();
        return id;
      });
    }
    return this.creating;
  }

  protected renderComponent(): ReactElement {
    const data = this.data as SubpageData;
    return (
      <SubpageView
        kind={data.kind === 'database' ? 'database' : 'page'}
        initialPageId={data.pageId ?? null}
        ensureCreated={this.hostPageId ? () => this.ensureCreated() : null}
      />
    );
  }

  async save(): Promise<SubpageData> {
    const data = this.data as SubpageData;
    if (!data.pageId && this.creating) {
      try {
        await this.creating;
      } catch {
        // creation failed; persist without a pageId so the block can be removed
      }
    }
    return {pageId: (this.data as SubpageData).pageId, kind: data.kind};
  }
}
