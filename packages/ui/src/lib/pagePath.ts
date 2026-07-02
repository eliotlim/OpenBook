import type {PageMeta} from '@book.dev/sdk';
import {t} from '@/i18n';

/**
 * A page's ancestor chain as "Parent / Child" — the disambiguating subtitle
 * every name-keyed picker needs now that names are not unique (two "Meeting
 * notes" rows must be tellable apart in the palette, link pickers, and the
 * Move-to dialog). Cycle-guarded; returns '' for top-level pages.
 */
export function pagePathLabel(page: PageMeta, byId: Map<string, PageMeta>): string {
  const parts: string[] = [];
  let cur = page.parentId ? byId.get(page.parentId) : undefined;
  const seen = new Set<string>();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    parts.unshift(cur.name && cur.name.trim().length > 0 ? cur.name : t('common.untitled'));
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return parts.join(' / ');
}
