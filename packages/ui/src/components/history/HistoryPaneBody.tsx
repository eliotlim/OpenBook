import {useCallback, useEffect, useMemo, useState, type KeyboardEvent as ReactKeyboardEvent} from 'react';
import * as Y from 'yjs';
import {History, RotateCcw} from 'lucide-react';
import type {PageVersionMeta} from '@book.dev/sdk';
import {useData} from '@/data';
import {getHistoryTarget, subscribeHistoryPane} from '@/lib/historyPane';
import {useConfirm, useNavigation, useTranslation} from '@/providers';
import {Button} from '@/components/ui/button';
import {showToast} from '@/components/ui/toast';
import {cn} from '@/lib/utils';
import {PresentBlocks} from '@/blockeditor/PresentBlocks';
import {decodeSnapshot, rootBlocks, type BlockDocSnapshot, type BlockMap} from '@/blockeditor/model';
import {VersionDiff} from './VersionDiff';

/** Relative "3m ago" style label; falls back to "just now" under a minute. */
function timeAgo(iso: string, locale: string, justNow: string): string {
  const secs = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (secs < 60) return justNow;
  const rtf = new Intl.RelativeTimeFormat(locale, {numeric: 'always', style: 'narrow'});
  if (secs < 3600) return rtf.format(-Math.round(secs / 60), 'minute');
  if (secs < 86400) return rtf.format(-Math.round(secs / 3600), 'hour');
  if (secs < 2592000) return rtf.format(-Math.round(secs / 86400), 'day');
  return new Date(iso).toLocaleDateString(locale);
}

/** Sentinel id for the synthetic "Current" row that stands for the live document. */
const CURRENT_ID = '__current__';

/**
 * The read-only preview of a picked entry: decode its snapshot into a fresh,
 * throwaway Y.Doc and render its top-level blocks through {@link PresentBlocks}
 * (the same locked, read-only surface Present mode uses). The doc is local to
 * this preview — it never touches the live document or its persistence.
 *
 * `versionId === null` previews the LIVE document (the synthetic "Current" row):
 * we read the page's current `data` via {@link DataClient.getPage} instead of a
 * captured version, decoding the identical `blockdoc` shape both carry.
 *
 * PVH-6 (a block-level diff against the current content) plugs in beside this — see
 * the disabled "Compare" placeholder in the footer.
 */
function VersionPreview({pageId, versionId}: {pageId: string; versionId: string | null}) {
  const client = useData();
  const {t} = useTranslation();
  const [blocks, setBlocks] = useState<BlockMap[] | null>(null);
  const [doc, setDoc] = useState<Y.Doc | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    let created: Y.Doc | null = null;
    setLoading(true);
    setError(false);
    setBlocks(null);
    setDoc(null);
    void (async () => {
      try {
        // `getPage` (live document) and `getVersion` (a captured past state) both
        // return a record whose `data` carries the same `blockdoc` snapshot.
        const source = versionId
          ? await client.getVersion(pageId, versionId)
          : await client.getPage(pageId);
        if (cancelled) return;
        if (!source) {
          setError(true);
          return;
        }
        const snapshot = (source.data as {blockdoc?: unknown}).blockdoc as
          | BlockDocSnapshot
          | undefined;
        created = decodeSnapshot(snapshot);
        setDoc(created);
        setBlocks(rootBlocks(created).toArray());
      } catch {
        if (!cancelled) setError(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      // Destroy the throwaway doc the *next* effect run replaced; the one still
      // rendered is destroyed on unmount by the state it lives in.
      created?.destroy();
    };
  }, [client, pageId, versionId]);

  if (loading) return <p className="text-xs text-muted-foreground">{t('history.loading')}</p>;
  if (error || !doc || !blocks)
    return <p className="text-xs text-muted-foreground">{t('history.previewError')}</p>;
  // `.ob-viewer` hides every editing affordance (gutters, kit gear, add-buttons)
  // with no layout side effects; the wrapper also disables pointer interaction so
  // the preview reads purely — a look, not a place to edit.
  return (
    <div className="ob-viewer pointer-events-none">
      <PresentBlocks doc={doc} blocks={blocks} />
    </div>
  );
}

/** The verified author of a version, or a fallback for server checkpoints. */
function authorLabel(v: PageVersionMeta, serverAuthor: string, unknown: string): string {
  if (v.authorName && v.authorName.trim()) return v.authorName.trim();
  // All three author fields null → a server-merged checkpoint (no saving principal).
  if (!v.authorSubject && !v.authorIssuer) return serverAuthor;
  return unknown;
}

/** One row in the list: the synthetic live "Current" entry, or a captured version. */
type HistoryItem =
  | {kind: 'current'; id: typeof CURRENT_ID}
  | {kind: 'version'; id: string; version: PageVersionMeta; when: string; who: string};

/**
 * The Version-history side-pane body (PVH-5): lists a page's history and previews
 * the picked entry read-only. The version-capture model (PVH-1) stores the state
 * each save *replaced*, so every `page_versions` row is a restorable PAST state and
 * the live document is never itself a row. So the list leads with a synthetic
 * "Current" entry (the live doc, non-restorable — you're already on it), followed
 * by every captured version, each restorable (relative time + author).
 * Reads the target page from the `historyPane` bridge (set by the "Version
 * history" affordance), mirroring how the Review pane reads `reviewPane`.
 * Mounted by SplitPane for the {@link HISTORY_PANE_ID} pseudo-pane.
 */
export function HistoryPaneBody() {
  const [target, setTarget] = useState(getHistoryTarget());
  useEffect(() => subscribeHistoryPane(() => setTarget(getHistoryTarget())), []);

  const pageId = target.pageId;
  const client = useData();
  const confirm = useConfirm();
  const {pageLabel} = useNavigation();
  const {t, locale} = useTranslation();

  const [versions, setVersions] = useState<PageVersionMeta[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(CURRENT_ID);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  // Preview (read-only) ⇄ Compare (block/word diff vs. current) for the picked
  // version. Only meaningful for a captured version — the live "Current" row has
  // nothing to compare against, so it always renders the preview.
  const [mode, setMode] = useState<'preview' | 'compare'>('preview');

  const refetch = useCallback(async () => {
    if (!pageId) {
      setVersions([]);
      return;
    }
    setLoading(true);
    setError(false);
    try {
      const list = await client.listVersions(pageId, {limit: 100});
      setVersions(list);
      // Keep the current selection if it still resolves; otherwise default to the
      // live "Current" entry (present whenever there is any history to show).
      setSelectedId((prev) => {
        if (list.length === 0) return null;
        if (prev === CURRENT_ID || list.some((v) => v.id === prev)) return prev;
        return CURRENT_ID;
      });
    } catch {
      setError(true);
      setVersions([]);
    } finally {
      setLoading(false);
    }
  }, [client, pageId]);

  // Refetch when the target page changes, or the pane is re-opened on the same
  // page (revision bump) — a fresh open should show any newly captured versions.
  useEffect(() => {
    void refetch();
  }, [refetch, target.revision]);

  // Restore is non-destructive: the server captures the current (pre-restore)
  // state as a fresh version first, so a restore is itself undoable. The restore
  // rides the normal save/broadcast, so the live document updates on its own SSE;
  // here we just confirm, call, and refetch the list (which now leads with the
  // freshly-captured pre-restore version).
  const restore = useCallback(
    async (version: PageVersionMeta) => {
      if (!pageId) return;
      const ok = await confirm({
        title: t('history.confirmTitle'),
        description: t('history.confirmBody'),
        confirmText: t('history.confirmAction'),
      });
      if (!ok) return;
      setRestoringId(version.id);
      try {
        const restored = await client.restoreVersion(pageId, version.id);
        if (!restored) throw new Error('restore returned null');
        await refetch();
        showToast({message: t('history.restored')});
      } catch {
        showToast({message: t('history.restoreError')});
      } finally {
        setRestoringId(null);
      }
    },
    [client, confirm, pageId, refetch, t],
  );

  // The synthetic "Current" entry only makes sense once there is history to show;
  // with zero versions the list falls through to its empty state instead.
  const items = useMemo<HistoryItem[]>(() => {
    if (versions.length === 0) return [];
    return [
      {kind: 'current', id: CURRENT_ID},
      ...versions.map(
        (v): HistoryItem => ({
          kind: 'version',
          id: v.id,
          version: v,
          when: timeAgo(v.createdAt, locale, t('home.justNow')),
          who: authorLabel(v, t('history.serverAuthor'), t('history.unknownAuthor')),
        }),
      ),
    ];
  }, [versions, locale, t]);
  const selectedItem = items.find((it) => it.id === selectedId) ?? null;
  // Compare only applies to a captured version; the live "Current" row falls back
  // to the read-only preview regardless of the toggle.
  const comparing = selectedItem?.kind === 'version' && mode === 'compare';

  // Single-select listbox nav (mirrors SlashMenu): arrows move the selection,
  // Home/End jump to the ends. Selection *is* the active option (aria-activedescendant).
  const orderedIds = useMemo(() => items.map((it) => it.id), [items]);
  const onListKeyDown = useCallback(
    (e: ReactKeyboardEvent) => {
      if (orderedIds.length === 0) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const cur = selectedId && orderedIds.includes(selectedId) ? orderedIds.indexOf(selectedId) : 0;
        const delta = e.key === 'ArrowDown' ? 1 : -1;
        setSelectedId(orderedIds[(cur + delta + orderedIds.length) % orderedIds.length]);
      } else if (e.key === 'Home') {
        e.preventDefault();
        setSelectedId(orderedIds[0]);
      } else if (e.key === 'End') {
        e.preventDefault();
        setSelectedId(orderedIds[orderedIds.length - 1]);
      }
    },
    [orderedIds, selectedId],
  );

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 border-b border-border px-4 py-2.5">
        <p className="truncate text-sm font-semibold">{t('history.title')}</p>
        <p className="truncate text-xs text-muted-foreground">
          {pageId ? pageLabel(pageId) : t('history.noPage')}
        </p>
      </div>

      {!pageId ? (
        <div className="min-h-0 flex-1 p-4">
          <p className="text-xs text-muted-foreground">{t('history.noPage')}</p>
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,2fr)_minmax(0,3fr)]">
          {/* The history list — a single-select listbox (Current + versions). */}
          <div
            role="listbox"
            aria-label={t('history.title')}
            tabIndex={0}
            aria-activedescendant={selectedId ? `history-opt-${selectedId}` : undefined}
            onKeyDown={onListKeyDown}
            className="min-h-0 overflow-y-auto border-b border-border p-2 outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            {loading && versions.length === 0 && (
              <p className="px-2 py-1.5 text-xs text-muted-foreground">{t('history.loading')}</p>
            )}
            {error && (
              <div className="flex flex-col items-start gap-2 px-2 py-1.5">
                <p className="text-xs text-destructive">{t('history.loadError')}</p>
                <Button size="sm" variant="outline" onClick={() => void refetch()}>
                  {t('history.retry')}
                </Button>
              </div>
            )}
            {!loading && !error && versions.length === 0 && (
              <div className="flex flex-col items-center gap-2 py-8 text-center">
                <History className="size-5 text-muted-foreground" aria-hidden />
                <p className="text-xs text-muted-foreground">{t('history.empty')}</p>
                <p className="max-w-[16rem] text-[11px] text-muted-foreground">
                  {t('history.emptyHint')}
                </p>
              </div>
            )}
            {items.map((item) => {
              const selected = selectedId === item.id;
              const isCurrent = item.kind === 'current';
              return (
                <div
                  key={item.id}
                  id={`history-opt-${item.id}`}
                  role="option"
                  aria-selected={selected}
                  onClick={() => setSelectedId(item.id)}
                  className={cn(
                    'flex w-full cursor-pointer flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left transition-colors',
                    selected ? 'bg-accent' : 'hover:bg-accent/60',
                  )}
                >
                  <span className="flex w-full items-center gap-2">
                    <span className="truncate text-xs font-medium">
                      {isCurrent ? t('history.currentVersion') : item.when}
                    </span>
                    {isCurrent && (
                      <span className="rounded-sm bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                        {t('history.current')}
                      </span>
                    )}
                  </span>
                  <span className="truncate text-[11px] text-muted-foreground">
                    {isCurrent ? t('history.currentHint') : item.who}
                  </span>
                </div>
              );
            })}
          </div>

          {/* The read-only preview of the picked entry + its restore action. */}
          <div className="flex min-h-0 flex-col">
            <div className="min-h-0 flex-1 overflow-y-auto">
              {selectedItem ? (
                <>
                  {/* Sticky context header: what you're previewing, kept in view as
                      the list/preview scroll (nit #2). */}
                  <div className="sticky top-0 z-10 border-b border-border bg-background/95 px-4 py-2 backdrop-blur">
                    <p className="truncate text-[11px] font-medium text-muted-foreground">
                      {selectedItem.kind === 'current'
                        ? t('history.currentVersion')
                        : comparing
                          ? t('history.comparing', {when: selectedItem.when})
                          : t('history.previewing', {when: selectedItem.when, who: selectedItem.who})}
                    </p>
                  </div>
                  <div className="p-4">
                    {comparing && selectedItem.kind === 'version' ? (
                      <VersionDiff pageId={pageId} versionId={selectedItem.version.id} />
                    ) : (
                      <VersionPreview
                        pageId={pageId}
                        versionId={selectedItem.kind === 'current' ? null : selectedItem.version.id}
                      />
                    )}
                  </div>
                </>
              ) : (
                !loading &&
                items.length > 0 && (
                  <p className="p-4 text-xs text-muted-foreground">{t('history.selectHint')}</p>
                )
              )}
            </div>
            {/* Every captured version is a restorable past state; the live "Current"
                entry is not (you're already on it), so its footer is omitted. */}
            {selectedItem?.kind === 'version' && (
              <div className="flex shrink-0 items-center gap-2 border-t border-border p-2.5">
                {/* PVH-6: Preview ⇄ Compare. Preview keeps the read-only render;
                    Compare swaps in the block/word diff of this version vs. current. */}
                <div
                  role="group"
                  aria-label={t('history.compare')}
                  className="flex shrink-0 items-center rounded-md border border-border p-0.5"
                >
                  <Button
                    size="sm"
                    variant={mode === 'preview' ? 'secondary' : 'ghost'}
                    className="h-6 px-2 text-[11px]"
                    aria-pressed={mode === 'preview'}
                    title={t('history.previewTitle')}
                    onClick={() => setMode('preview')}
                  >
                    {t('history.preview')}
                  </Button>
                  <Button
                    size="sm"
                    variant={mode === 'compare' ? 'secondary' : 'ghost'}
                    className="h-6 px-2 text-[11px]"
                    aria-pressed={mode === 'compare'}
                    title={t('history.compareTitle')}
                    onClick={() => setMode('compare')}
                  >
                    {t('history.compare')}
                  </Button>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="flex-1"
                  disabled={restoringId !== null}
                  onClick={() => void restore(selectedItem.version)}
                >
                  <RotateCcw className="mr-2 h-3.5 w-3.5" />
                  {restoringId === selectedItem.version.id
                    ? t('history.restoring')
                    : t('history.restore')}
                </Button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default HistoryPaneBody;
