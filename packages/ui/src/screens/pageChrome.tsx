import React, {useEffect, useRef} from 'react';
import type {PageSnapshot} from '@open-book/sdk';
import {useTranslation} from '@/providers';
import {IconPicker} from '@/components/IconPicker';
import {consumePendingRename, onRenamePageRequest} from '@/lib/pageActions';

/**
 * Shared page-document chrome: the prop contract a page editor speaks to
 * {@link ConnectedPageDocument}, and the {@link PageHeader} (icon + title) that
 * sits above the editing surface. Extracted so the block editor owns it now that
 * the classic EditorJS surface is gone.
 */
export interface PageDocumentProps {
  onSave?: (snap: PageSnapshot) => void | Promise<void>;
  onLoad?: () => Promise<PageSnapshot | null>;
  /** Current page title (the page name). Controlled. */
  title?: string;
  /** Called when the title input changes. */
  onTitleChange?: (title: string) => void;
  /** Page icon (emoji). */
  icon?: string;
  /** Called when the icon changes. */
  onIconChange?: (emoji: string) => void;
  /** When provided, enables the delete action in the page menu. */
  onDelete?: () => void;
  /** A newer snapshot pushed from the server to apply live (collaboration). */
  incoming?: {data: PageSnapshot; version: number};
  /** Notifies when the title input gains/loses focus (to avoid clobbering it). */
  onTitleActiveChange?: (active: boolean) => void;
  /** Extra content rendered below the editor, in the same content column (e.g.
   *  the database view for a page that hosts a database). */
  footer?: React.ReactNode;
  /** The page being edited — passed to the subpage block so new children nest here. */
  pageId?: string;
  /** True when this page hosts a database (its view renders as the {@link footer}).
   *  The empty editor then drops its tall min-height so the database sits directly
   *  under the header instead of being pushed down by a big gap. */
  hasDatabase?: boolean;
}

export const PageHeader: React.FC<{
  title: string;
  icon: string;
  pageId?: string;
  onTitleChange?: (title: string) => void;
  onIconChange?: (emoji: string) => void;
  onTitleActiveChange?: (active: boolean) => void;
}> = ({title, icon, pageId, onTitleChange, onIconChange, onTitleActiveChange}) => {
  const {t} = useTranslation();
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Auto-grow the title textarea to its content (it never scrolls).
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [title]);

  // "Rename" from a menu focuses + selects this title field. Handle both a
  // request fired while we're already mounted, and one queued just before a
  // page switch mounted this header (claimed via consumePendingRename).
  useEffect(() => {
    if (!pageId) return;
    const focusTitle = () => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.select();
    };
    // The implicit new-page autofocus can land LATE (the document loads
    // async): if the user is already typing somewhere — an input, the
    // editor, an open dropdown's field — stealing focus would also dismiss
    // whatever they had open. Yield to any text-entry surface; the explicit
    // Rename request below stays unconditional (deliberate user intent).
    if (consumePendingRename(pageId)) {
      const active = document.activeElement as HTMLElement | null;
      const busy = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable);
      if (!busy) focusTitle();
    }
    return onRenamePageRequest((id) => {
      if (id === pageId) focusTitle();
    });
  }, [pageId]);

  return (
    <div className="pt-2 pb-1">
      <IconPicker
        value={icon}
        onPick={(emoji) => onIconChange?.(emoji)}
        ariaLabel={t('page.changeIcon')}
        className="-ml-1 mb-1 inline-flex h-[68px] w-[68px] items-center justify-center rounded-lg text-[3.5rem] leading-none transition-colors hover:bg-hover"
      />
      {/* A textarea (not an input) so long titles wrap instead of clipping;
          auto-grown to fit, Enter commits rather than inserting a newline. */}
      <textarea
        ref={inputRef}
        rows={1}
        className="ob-page-title w-full resize-none overflow-hidden bg-transparent text-[2.5rem] font-bold leading-tight tracking-tight outline-hidden placeholder:text-muted-foreground/35"
        value={title}
        placeholder={t('common.untitled')}
        onChange={(e) => onTitleChange?.(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            e.currentTarget.blur();
          }
        }}
        onFocus={() => onTitleActiveChange?.(true)}
        onBlur={() => onTitleActiveChange?.(false)}
        aria-label={t('page.titleLabel')}
      />
    </div>
  );
};
