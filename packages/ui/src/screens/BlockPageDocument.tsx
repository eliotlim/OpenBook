import React, {useEffect, useRef, useState} from 'react';
import * as Y from 'yjs';
import {Download, FileCode, FileText as FileTextIcon, MoreHorizontal, Trash2} from 'lucide-react';
import type {PageSnapshot} from '@open-book/sdk';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {IconButton} from '@/components/ui/icon-button';
import {BlockEditor} from '@/blockeditor/BlockEditor';
import {
  createSeededDoc,
  decodeSnapshot,
  docToJSON,
  encodeSnapshot,
  migrateEditorJs,
  type BlockDocSnapshot,
} from '@/blockeditor/model';
import {blocksToHtml, blocksToMarkdown} from '@/blockeditor/exportBlocks';
import {connectBroadcast} from '@/blockeditor/provider';
import {PageProperties} from '@/components/PageProperties';
import {useHud, useTranslation} from '@/providers';
import {downloadText, safeFilename} from '@/lib/download';
import {cn} from '@/lib/utils';
import {PageHeader, type PageDocumentProps} from './PageDocument';

/**
 * The CRDT block editor mounted as a page document. Speaks the same contract
 * as the EditorJS-based {@link PageDocument} (onLoad/onSave/incoming/footer),
 * so {@link ConnectedPageDocument} can swap between them per page:
 *
 *  - load: `data.blockdoc` decodes into a Y.Doc; a legacy EditorJS document
 *    migrates deterministically (seed replica keyed off the page id, so two
 *    clients migrating concurrently converge instead of duplicating).
 *  - save: local edits debounce into a full snapshot — the CRDT update plus
 *    its JSON projection — stamped `editor: 'blocks'`.
 *  - collaboration: server pushes (`incoming`) merge via Y.applyUpdate, which
 *    is idempotent and order-tolerant; same-browser tabs additionally sync
 *    instantly over the BroadcastChannel provider.
 */
const BlockPageDocument: React.FC<PageDocumentProps> = ({
  onSave,
  onLoad,
  title = '',
  onTitleChange,
  icon = '📄',
  onIconChange,
  onDelete,
  incoming,
  onTitleActiveChange,
  footer,
  pageId,
  hasDatabase = false,
}) => {
  const {hud} = useHud();
  const {t} = useTranslation();
  const [doc, setDoc] = useState<Y.Doc | null>(null);
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'save failed'>('idle');
  const lastSnapshot = useRef<PageSnapshot | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Load (or migrate) ──────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const snap = await onLoad?.();
      if (cancelled) return;
      lastSnapshot.current = snap ?? null;
      if (snap?.blockdoc) {
        setDoc(decodeSnapshot(snap.blockdoc as BlockDocSnapshot));
        return;
      }
      const legacy = (snap?.editorjs as {blocks?: {type: string; data: Record<string, unknown>}[]} | undefined)?.blocks;
      setDoc(createSeededDoc(migrateEditorJs(legacy ?? []), `mig-${pageId ?? 'page'}`));
    })();
    return () => {
      cancelled = true;
    };
  }, [pageId]);  

  // ── Save local edits ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!doc || !onSave) return;
    const handler = (_update: Uint8Array, origin: unknown): void => {
      // Only local edits save; merged remote state was saved by its author.
      if (origin === 'bc-remote' || origin === 'server') return;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      setStatus('saving');
      saveTimer.current = setTimeout(() => {
        const base = lastSnapshot.current ?? {editorjs: {blocks: []}, values: [], names: []};
        const snapshot: PageSnapshot = {
          ...base,
          editor: 'blocks',
          blockdoc: encodeSnapshot(doc),
        };
        lastSnapshot.current = snapshot;
        void Promise.resolve(onSave(snapshot))
          .then(() => setStatus('saved'))
          .catch(() => setStatus('save failed'));
      }, 600);
    };
    doc.on('update', handler);
    return () => {
      doc.off('update', handler);
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [doc, onSave]);

  // ── Live collaboration ────────────────────────────────────────────────────
  // Server-pushed snapshots merge into the live doc (CRDT union, no clobber).
  const incomingVersion = useRef(0);
  useEffect(() => {
    if (!doc || !incoming || incoming.version === incomingVersion.current) return;
    incomingVersion.current = incoming.version;
    const blockdoc = incoming.data.blockdoc as BlockDocSnapshot | undefined;
    if (!blockdoc?.update) return;
    try {
      const binary = atob(blockdoc.update);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      Y.applyUpdate(doc, bytes, 'server');
    } catch {
      // malformed remote update — ignore rather than corrupt local state
    }
  }, [doc, incoming]);

  // Same-browser tabs sync instantly (and presence rides along).
  useEffect(() => {
    if (!doc || !pageId) return;
    const conn = connectBroadcast(doc, `page:${pageId}`);
    return () => conn.disconnect();
  }, [doc, pageId]);

  // ── Export ────────────────────────────────────────────────────────────────
  const handleExport = (kind: 'md' | 'html'): void => {
    if (!doc) return;
    const blocks = docToJSON(doc);
    const name = safeFilename(title || 'untitled');
    if (kind === 'md') {
      downloadText(`${name}.md`, `# ${title}\n\n${blocksToMarkdown(blocks)}`, 'text/markdown');
    } else {
      const html = `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1>\n${blocksToHtml(blocks)}</body></html>`;
      downloadText(`${name}.html`, html, 'text/html');
    }
  };

  const statusLabel = status === 'saving' ? t('page.saving') : status === 'saved' ? t('page.saved') : status === 'save failed' ? t('page.saveFailed') : '';
  const columnClass = cn('mx-auto w-full', hud.viewMode.fullWidth ? 'max-w-none' : 'max-w-content');

  return (
    <div className="w-full px-6 pb-40 pt-6 md:px-10">
      <div className={columnClass}>
        <div className="flex h-8 items-center justify-end gap-2 text-xs text-muted-foreground print:hidden">
          <span className={cn('transition-opacity', status === 'save failed' && 'text-destructive')}>{statusLabel}</span>
          {pageId && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <IconButton aria-label={t('page.actions')}>
                  <MoreHorizontal className="h-4 w-4" />
                </IconButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44">
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>
                    <Download className="mr-2 h-4 w-4" />
                    {t('page.export')}
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>
                    <DropdownMenuItem onClick={() => handleExport('md')}>
                      <FileTextIcon className="mr-2 h-4 w-4" />
                      {t('page.exportMarkdown')}
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => handleExport('html')}>
                      <FileCode className="mr-2 h-4 w-4" />
                      {t('page.exportHtml')}
                    </DropdownMenuItem>
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
                {onDelete && (
                  <DropdownMenuItem onClick={onDelete} className="text-destructive focus:text-destructive">
                    <Trash2 className="mr-2 h-4 w-4" />
                    {t('page.delete')}
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>

        <PageHeader
          title={title}
          icon={icon}
          pageId={pageId}
          onTitleChange={onTitleChange}
          onIconChange={onIconChange}
          onTitleActiveChange={onTitleActiveChange}
        />
        {pageId && <PageProperties pageId={pageId} />}

        <div className={cn(hasDatabase ? 'min-h-0' : 'min-h-[40vh]', 'pt-2')}>
          {doc && <BlockEditor doc={doc} ariaLabel={title || 'Page content'} />}
        </div>

        {footer}
      </div>
    </div>
  );
};

export default BlockPageDocument;
