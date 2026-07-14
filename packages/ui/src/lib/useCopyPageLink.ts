import {useCallback} from 'react';
import {useForwarding, useHud, useTranslation} from '@/providers';
import {copyGroupLink, copyPageLink, copyRowLink} from '@/lib/pageActions';
import {showToast} from '@/components/ui/toast';

/** Optionally anchor the copied link at a database row or group of the target
 *  page (`{row}` → `?…&row=`, `{group}` → `?…&group=`). Omit for a plain page link. */
export type CopyLinkAnchor = {row?: string; group?: string};

/**
 * Copy a page's deep link, guarding the desktop dead-link case (SHR-1). On a
 * publish-capable host (desktop) that isn't currently published, `window.location`
 * is `tauri://localhost`, so a copied link is dead for anyone else — the bare
 * "Copy link" buttons used to copy it and report success silently. Instead of
 * that quiet lie, surface a toast that points at publishing (with an action that
 * opens Settings → Sharing & publishing). Once published — or anywhere the link
 * is genuinely reachable (the standalone web app, a LAN/remote server) — the
 * normal forwarded/absolute link is copied exactly as before.
 */
export function useCopyPageLink(): (pageId: string, anchor?: CopyLinkAnchor) => void {
  const {supported: canPublish, publishedHost} = useForwarding();
  const {setHud} = useHud();
  const {t} = useTranslation();
  // Desktop can publish but currently isn't — the only case where the copied
  // link resolves to the dead `tauri://localhost` origin for a recipient.
  const linkIsLocalOnly = canPublish && !publishedHost;
  return useCallback(
    (pageId: string, anchor?: CopyLinkAnchor) => {
      if (linkIsLocalOnly) {
        showToast({
          message: t('menu.copyLinkLocalOnly'),
          actionLabel: t('menu.copyLinkPublish'),
          onAction: () =>
            setHud((draft) => {
              draft.settings.open = true;
              draft.settings.tab = 'sharing';
              return draft;
            }),
        });
        return;
      }
      // A row/group anchor reopens the host db page in context; without one the
      // plain page link is copied exactly as before.
      if (anchor?.row) void copyRowLink(pageId, anchor.row);
      else if (anchor?.group) void copyGroupLink(pageId, anchor.group);
      else void copyPageLink(pageId);
    },
    [linkIsLocalOnly, setHud, t],
  );
}
