import React, {useCallback, useEffect, useRef, useState} from 'react';
import {ICON_PROPERTY_ID, type PageSnapshot, type StoredPage} from '@book.dev/sdk';
import {useData} from '@/data';
import {clearLastPage, useConfirm, useNavigation, usePreferences, useTranslation} from '@/providers';
import {ErrorBoundary, ErrorFallback} from '@/components/ErrorBoundary';
import {HOME_PAGE_ID} from '@/lib/homePage';
import {markPageCrashed} from '@/lib/crashRecovery';
import {hydratePageIcons, usePageIcon, writePageIcon} from '@/lib/pageIcon';
import {pageSaveStatus, setPageSaveStatus} from '@/lib/pageSaveStatus';
import {DatabaseView} from '@/components/database/DatabaseView';
import BlockPageDocument from './BlockPageDocument';

export interface ConnectedPageDocumentProps {
  /** Stable page id (UUID) this editor reads from and writes to. */
  pageId: string;
}


/**
 * A {@link PageDocument} wired to the data client + {@link NavigationProvider}.
 * Loads content + name, autosaves edits, renames from the title field, and —
 * for real-time collaboration — subscribes to the server's live page stream and
 * applies snapshots saved by other clients. Our own saves carry an `updatedAt`
 * we remember, so the echoed event is ignored.
 */
export const ConnectedPageDocument: React.FC<ConnectedPageDocumentProps> = ({pageId}) => {
  const client = useData();
  const confirm = useConfirm();
  const {preferences} = usePreferences();
  const {t} = useTranslation();
  const {pages, deletePage, setPageHint, closePage, selectPage} = useNavigation();

  const [title, setTitle] = useState('');
  // The icon lives on page.properties (lib/pageIcon's cache); read it reactively
  // so it updates when the page loads or the user picks a new one.
  const icon = usePageIcon(pageId);
  const [incoming, setIncoming] = useState<{data: PageSnapshot; version: number} | undefined>(undefined);
  // The hosted-database id resolved from the page record itself (getPage /
  // subscribePage both join it). This is independent of the nav `pages` list, so
  // it's available right after a database page is created — before the list has
  // re-streamed to include it — which keeps the editor in `compact` layout from
  // the first paint instead of briefly reserving a document's worth of trailing
  // whitespace above the view. `undefined` = not yet known (probe by page id).
  const [resolvedHostedDbId, setResolvedHostedDbId] = useState<string | null | undefined>(undefined);

  const nameRef = useRef<string | null>(null);
  const renameTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // True once this document unmounted or switched pages — gates the rename
  // retry so a late rejection can't re-arm a timer nothing will ever clear.
  const disposedRef = useRef(false);
  // True while the user has typed a title the server hasn't confirmed yet. The
  // `updatedAt` ordering guard below can't protect the title on its own: a
  // concurrent page write (a content save, this page's database-creation echo,
  // or a peer) comes back with a *newer* updatedAt but the *pre-rename* name,
  // which would otherwise overwrite the freshly-typed title and — via
  // `nameRef` — get re-persisted by the pending rename. While this is set,
  // incoming names are not applied (OB-278: "UI renames silently revert").
  const hasPendingRenameRef = useRef(false);
  // Highest updatedAt this client has saved or applied — used to drop stale
  // events. Echo handling (not re-saving content a peer sent us) lives in
  // PageDocument's content-digest check, so this is just an ordering guard.
  const lastUpdatedRef = useRef<string>('');
  const titleActiveRef = useRef(false);
  const versionRef = useRef(0);

  const applyPage = useCallback(
    (page: StoredPage) => {
      // Stale event (older than what we've already applied/saved) — ignore.
      if (page.updatedAt <= lastUpdatedRef.current) return;
      lastUpdatedRef.current = page.updatedAt;
      // Don't let an incoming name overwrite the title while the field is
      // focused (the user is typing) or a local rename is still unconfirmed
      // (its echo predates this edit) — OB-278.
      if (!titleActiveRef.current && !hasPendingRenameRef.current) {
        setTitle(page.name ?? '');
        nameRef.current = page.name ?? null;
        setPageHint(pageId, page.name);
      }
      setResolvedHostedDbId(page.hostedDatabaseId);
      hydratePageIcons([{id: page.id, icon: page.properties[ICON_PROPERTY_ID] as string | null | undefined}]);
      versionRef.current += 1;
      setIncoming({data: page.data, version: versionRef.current});
    },
    [pageId, setPageHint],
  );

  const pagesRef = useRef(pages);
  pagesRef.current = pages;

  // Commit the debounced rename and drop the pending-rename guard once the
  // server confirms it. The guard stays up while the request is in flight so a
  // stale page echo can't revert the title mid-rename (OB-278). Called by the
  // debounce timer and on blur (commit) — clearing any pending timer first so a
  // blur-then-quick-navigate can't strand the rename in an un-fired debounce.
  const commitRename = useCallback(() => {
    if (renameTimer.current) {
      clearTimeout(renameTimer.current);
      renameTimer.current = null;
    }
    if (!hasPendingRenameRef.current) return;
    void client
      .renamePage(pageId, nameRef.current)
      .then((saved) => {
        lastUpdatedRef.current = saved.updatedAt;
        // Clear the guard only once the server matches our latest local name; a
        // keystroke that landed mid-flight keeps it pending for its own commit.
        if ((saved.name ?? null) === nameRef.current) hasPendingRenameRef.current = false;
        // A prior rename failure has healed; don't leave a stale failure pill up.
        if (pageSaveStatus(pageId) === 'save failed') setPageSaveStatus(pageId, 'saved');
      })
      .catch(() => {
        // A rename can only fail for transport reasons (names are not unique).
        // Surface it in the save-status pill and retry; the pending guard stays
        // up so the unconfirmed title is never clobbered by a stale echo.
        // Never re-arm after the document unmounted / switched pages — a
        // rejection landing post-cleanup would otherwise start a detached
        // 4s retry loop nothing can cancel (adversarial review, 2026-07-03).
        if (disposedRef.current) return;
        setPageSaveStatus(pageId, 'save failed');
        renameTimer.current = setTimeout(commitRename, 4000);
      });
  }, [client, pageId]);

  // Seed title/icon and reset live state on every page switch.
  useEffect(() => {
    disposedRef.current = false;
    const meta = pagesRef.current.find((p) => p.id === pageId);
    setTitle(meta?.name ?? '');
    nameRef.current = meta?.name ?? null;
    hasPendingRenameRef.current = false;
    setIncoming(undefined);
    // Seed from the nav-list meta when we have it; otherwise leave `undefined`
    // until getPage/subscribePage resolves it (don't carry the prior page's id).
    setResolvedHostedDbId(meta ? meta.hostedDatabaseId : undefined);
    lastUpdatedRef.current = meta?.updatedAt ?? '';
    return () => {
      disposedRef.current = true;
      if (renameTimer.current) clearTimeout(renameTimer.current);
    };
  }, [pageId]);

  const onLoad = useCallback(async (): Promise<PageSnapshot | null> => {
    const page = await client.getPage(pageId);
    // A slow load can resolve after the user has already started renaming; the
    // server's pre-rename name must not clobber the in-progress edit (OB-278).
    if (!hasPendingRenameRef.current) {
      nameRef.current = page?.name ?? null;
      setTitle(page?.name ?? '');
      setPageHint(pageId, page?.name ?? null);
    }
    if (page) {
      lastUpdatedRef.current = page.updatedAt;
      setResolvedHostedDbId(page.hostedDatabaseId);
      hydratePageIcons([{id: page.id, icon: page.properties[ICON_PROPERTY_ID] as string | null | undefined}]);
    }
    return page ? page.data : null;
  }, [client, pageId, setPageHint]);

  const onSave = useCallback(
    async (snapshot: PageSnapshot): Promise<void> => {
      const saved = await client.savePage({id: pageId, name: nameRef.current, data: snapshot});
      lastUpdatedRef.current = saved.updatedAt;
    },
    [client, pageId],
  );

  const onTitleChange = useCallback(
    (next: string) => {
      setTitle(next);
      nameRef.current = next.trim().length > 0 ? next : null;
      hasPendingRenameRef.current = true;
      setPageHint(pageId, nameRef.current);
      if (renameTimer.current) clearTimeout(renameTimer.current);
      renameTimer.current = setTimeout(commitRename, 600);
    },
    [pageId, setPageHint, commitRename],
  );

  const onIconChange = useCallback(
    (emoji: string) => {
      writePageIcon(pageId, emoji);
    },
    [pageId],
  );

  const onDelete = useCallback(async () => {
    // Skip the confirm when the user has turned it off in General settings.
    if (preferences.general.confirmOnTrash) {
      const ok = await confirm({
        title: t('confirm.trashTitle'),
        description: t('confirm.trashBody'),
        confirmText: t('confirm.trashConfirm'),
        destructive: true,
      });
      if (!ok) return;
    }
    void deletePage(pageId);
  }, [pageId, deletePage, confirm, preferences.general.confirmOnTrash, t]);

  const onTitleActiveChange = useCallback(
    (active: boolean) => {
      titleActiveRef.current = active;
      // Blur commits the title (Tab, or clicking into the body / another page):
      // persist now instead of waiting out the debounce, so the rename is durable
      // the moment the field is left and a quick navigate can't drop it (OB-278).
      if (!active) commitRename();
    },
    [commitRename],
  );

  // Real-time: apply page snapshots saved by other clients. Our own echoes are
  // harmless now — applying identical content is a no-op patch and the
  // content-digest check in PageDocument stops it being re-saved — so we no
  // longer need to race-guard the echo here.
  useEffect(() => {
    return client.subscribePage(pageId, {
      onPage: (page) => applyPage(page),
      // Close any tab showing this page when it is deleted elsewhere. Top-level
      // pages are also covered by the list stream; this additionally handles
      // subpages (database rows), which never appear in the page list.
      onDeleted: () => closePage(pageId),
    });
  }, [client, pageId, applyPage, closePage]);

  // Whether this page hosts a database. The nav `pages` list knows this for
  // top-level pages, but not for freshly-created pages (not yet re-streamed) or
  // subpages (database rows, never listed). So prefer the list value when present
  // and fall back to the id resolved from the page record itself — keeping both
  // the `compact` editor layout and the hosted view correct from the first paint.
  const meta = pages.find((p) => p.id === pageId);
  const databaseIdHint = meta ? meta.hostedDatabaseId : resolvedHostedDbId;

  // Page-level render-crash containment (STAB-3): a page whose stored content
  // throws while rendering must not blank the whole app — the sidebar, tabs and
  // nav live outside this boundary and stay usable. On catch we quarantine the
  // page (so startup won't auto-reopen it into the same crash) and forget the
  // last-page key, then offer a one-click way Home. Keyed by pageId so navigating
  // to a healthy page mounts a fresh boundary (auto-recovers).
  return (
    <ErrorBoundary
      key={pageId}
      resetKey={pageId}
      onError={(error) => {
        console.error(`OpenBook: page "${pageId}" crashed while rendering:`, error);
        markPageCrashed(pageId);
        clearLastPage();
      }}
      fallback={() => (
        <ErrorFallback
          variant="inline"
          title="This page couldn't be opened"
          message="Its content ran into an error while rendering. Your other pages are fine — open one from the sidebar, or head home."
          onHome={() => selectPage(HOME_PAGE_ID)}
        />
      )}
    >
      <BlockPageDocument
        title={title}
        icon={icon}
        incoming={incoming}
        onTitleChange={onTitleChange}
        onTitleActiveChange={onTitleActiveChange}
        onIconChange={onIconChange}
        onDelete={onDelete}
        onLoad={onLoad}
        onSave={onSave}
        pageId={pageId}
        hasDatabase={!!databaseIdHint}
        footer={<DatabaseView pageId={pageId} databaseIdHint={databaseIdHint} />}
      />
    </ErrorBoundary>
  );
};

export default ConnectedPageDocument;
