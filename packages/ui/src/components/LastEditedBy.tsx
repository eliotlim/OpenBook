import {useEffect, useState} from 'react';
import {History} from 'lucide-react';
import type {StoredEdit} from '@book.dev/sdk';
import {useData} from '@/data/DataProvider';
import {useTranslation} from '@/providers';

/** Compact relative time, matching the home/trash style: "just now", Nm, Nh, Nd. */
function ago(iso: string, justNow: string): string {
  const secs = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (secs < 60) return justNow;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/**
 * A subtle "Edited by X · 2h" indicator in the page header cluster (OB-165),
 * read from the change provenance log so the *who* and *when* of the last edit
 * are visible, not just stored. Renders nothing when the server has no edit log
 * (an older build) or the page has no recorded edits yet. Refreshes when the
 * page is saved so it reflects the latest editor (including you).
 */
export function LastEditedBy({pageId}: {pageId: string}) {
  const client = useData();
  const {t} = useTranslation();
  const [edit, setEdit] = useState<StoredEdit | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = (): void => {
      client
        .listPageEdits(pageId, 1)
        .then((edits) => {
          if (!cancelled) setEdit(edits[0] ?? null);
        })
        .catch(() => {
          if (!cancelled) setUnavailable(true);
        });
    };
    load();
    // Refresh on save. The server logs the edit *after* it publishes the page,
    // so refetch on a short delay to let that row land (avoids a one-save lag).
    const unsub = client.subscribePage(pageId, {
      onPage: () => {
        setTimeout(() => {
          if (!cancelled) load();
        }, 250);
      },
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, [client, pageId]);

  if (unavailable || !edit) return null;

  const name =
    edit.authorName?.trim() || (edit.verifiedVia === 'guest' ? t('provenance.aGuest') : t('provenance.someone'));
  const label = t('provenance.editedBy', {name});
  const verified = edit.verifiedVia === 'jws';
  const full = `${label} · ${new Date(edit.createdAt).toLocaleString()}${verified ? '' : ` · ${t('provenance.unverified')}`}`;

  return (
    <span className="inline-flex shrink-0 items-center gap-1 px-1 text-xs text-muted-foreground/80" title={full}>
      <History className="h-3.5 w-3.5" aria-hidden />
      <span className="truncate">
        {label} · {ago(edit.createdAt, t('provenance.justNow'))}
      </span>
    </span>
  );
}

export default LastEditedBy;
