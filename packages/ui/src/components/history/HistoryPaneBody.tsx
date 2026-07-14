import {useCallback, useEffect, useMemo, useState} from 'react';
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

/**
 * The read-only preview of a picked version: decode its snapshot into a fresh,
 * throwaway Y.Doc and render its top-level blocks through {@link PresentBlocks}
 * (the same locked, read-only surface Present mode uses). The doc is local to
 * this preview — it never touches the live document or its persistence.
 *
 * PVH-6 (a block-level diff against the current content) plugs in here: swap this
 * preview for a diff view, or add a "Compare" toggle beside the header.
 */
function VersionPreview({pageId, versionId}: {pageId: string; versionId: string}) {
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
        const version = await client.getVersion(pageId, versionId);
        if (cancelled) return;
        if (!version) {
          setError(true);
          return;
        }
        const snapshot = (version.data as {blockdoc?: unknown}).blockdoc as
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

/**
 * The Version-history side-pane body (PVH-5): lists a page's captured versions
 * newest-first (relative time + author) and previews the picked one read-only.
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
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [restoringId, setRestoringId] = useState<string | null>(null);

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
      // Keep the current selection if it still exists, else default to newest.
      setSelectedId((prev) => (prev && list.some((v) => v.id === prev) ? prev : list[0]?.id ?? null));
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

  const items = useMemo(
    () =>
      versions.map((v, i) => ({
        version: v,
        when: timeAgo(v.createdAt, locale, t('home.justNow')),
        who: authorLabel(v, t('history.serverAuthor'), t('history.unknownAuthor')),
        isCurrent: i === 0,
      })),
    [versions, locale, t],
  );
  const selectedItem = items.find((it) => it.version.id === selectedId) ?? null;

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
          {/* The version list. */}
          <div className="min-h-0 overflow-y-auto border-b border-border p-2">
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
            {items.map(({version, when, who, isCurrent}) => (
              <button
                key={version.id}
                type="button"
                onClick={() => setSelectedId(version.id)}
                aria-pressed={selectedId === version.id}
                className={cn(
                  'flex w-full flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left transition-colors',
                  selectedId === version.id ? 'bg-accent' : 'hover:bg-accent/60',
                )}
              >
                <span className="flex w-full items-center gap-2">
                  <span className="truncate text-xs font-medium">{when}</span>
                  {isCurrent && (
                    <span className="rounded-sm bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                      {t('history.current')}
                    </span>
                  )}
                </span>
                <span className="truncate text-[11px] text-muted-foreground">{who}</span>
              </button>
            ))}
          </div>

          {/* The read-only preview of the picked version + its restore action. */}
          <div className="flex min-h-0 flex-col">
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              {selectedId ? (
                <VersionPreview pageId={pageId} versionId={selectedId} />
              ) : (
                !loading && (
                  <p className="text-xs text-muted-foreground">{t('history.selectHint')}</p>
                )
              )}
            </div>
            {selectedItem && !selectedItem.isCurrent && (
              <div className="shrink-0 border-t border-border p-2.5">
                {/* PVH-6: a "Compare" toggle (diff vs. current) plugs in here,
                    beside Restore. */}
                <Button
                  size="sm"
                  variant="outline"
                  className="w-full"
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
