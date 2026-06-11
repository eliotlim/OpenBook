import React, {useEffect, useRef, useState} from 'react';
import * as Y from 'yjs';
import {Download, FileCode, FileText as FileTextIcon, FileType, MoreHorizontal, Trash2} from 'lucide-react';
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
  encodeSnapshot,
  migrateEditorJs,
  type BlockDocSnapshot,
} from '@/blockeditor/model';
import {blockSnapshotToEditorJs} from '@/blockeditor/exportBlocks';
import {buildDocumentModel} from '@/export/documentModel';
import {toMarkdown} from '@/export/toMarkdown';
import {downloadBlob} from '@/lib/download';
import {useData} from '@/data';
import {connectBroadcast} from '@/blockeditor/provider';
import {registerReactiveBlocks} from '@/blockeditor/reactiveBlocks';
import {registerArtifactKit} from '@/blockeditor/kit';
import {PageContextMenu} from '@/components/PageContextMenu';
import {PageProperties} from '@/components/PageProperties';
import {useHud, usePreferences, useTranslation} from '@/providers';
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
registerReactiveBlocks(); // built-in reactive plugins (slider + formula)
registerArtifactKit(); // interactive artifact blocks (inputs, charts, cards)

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
  const {preferences} = usePreferences();
  const client = useData();
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
      const legacy = (snap?.editorjs as {blocks?: {type: string; data: Record<string, unknown>}[]} | undefined)?.blocks ?? [];
      // Resolve linked-page titles first so subpage/database blocks migrate
      // into mentions that carry their real names.
      const linkedIds = [...new Set(legacy.filter((b) => b.type === 'subpage' || b.type === 'database').map((b) => b.data?.pageId).filter((v): v is string => typeof v === 'string'))];
      const pageLabels = new Map<string, string>();
      await Promise.all(
        linkedIds.map(async (linkId) => {
          const linked = await client.getPage(linkId).catch(() => null);
          if (linked?.name) pageLabels.set(linkId, linked.name);
        }),
      );
      if (cancelled) return;
      // The reactive context (cell values + the name index) rides along so
      // sliders keep their live values and expr sources resolve to names.
      setDoc(createSeededDoc(migrateEditorJs(legacy, {values: snap?.values, names: snap?.names, pageLabels}), `mig-${pageId ?? 'page'}`));
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
  // The block document projects into the EditorJS shape, then rides the same
  // pipeline as classic pages — markdown, paged/continuous PDF, and the
  // interactive HTML site (live sliders/formulas, navigable subtree).
  const handleExport = async (kind: 'md' | 'pdf-paged' | 'pdf-continuous' | 'html'): Promise<void> => {
    if (!doc) return;
    const snapshot = blockSnapshotToEditorJs({
      editorjs: {blocks: []},
      values: [],
      names: [],
      editor: 'blocks',
      blockdoc: encodeSnapshot(doc),
    });
    const base = safeFilename(title);
    try {
      if (kind === 'md') {
        downloadText(`${base}.md`, toMarkdown(buildDocumentModel({title, icon, snapshot})), 'text/markdown');
      } else if (kind === 'pdf-paged' || kind === 'pdf-continuous') {
        const {toPdf} = await import('@/export/toPdf');
        downloadBlob(`${base}.pdf`, await toPdf(buildDocumentModel({title, icon, snapshot}), kind === 'pdf-paged' ? 'paged' : 'continuous'));
      } else {
        const [{toHtmlSite}, {gatherSite}] = await Promise.all([import('@/export/toHtml'), import('@/export/exportSite')]);
        const bundle = pageId
          ? await gatherSite(client, pageId, {snapshot, title, icon})
          : {rootId: '', pages: [{id: '', title, icon, snapshot}]};
        downloadText(`${base}.html`, toHtmlSite(bundle), 'text/html');
      }
    } catch (e) {
      console.error('BlockPageDocument: export failed:', e);
    }
  };

  const statusLabel = status === 'saving' ? t('page.saving') : status === 'saved' ? t('page.saved') : status === 'save failed' ? t('page.saveFailed') : '';
  const columnClass = cn('mx-auto w-full', hud.viewMode.fullWidth ? 'max-w-none' : 'max-w-content');

  // Right-clicking the page body opens the shared page actions (favorite,
  // open in split, rename, duplicate, trash, …) — same menu as classic pages.
  const body = (
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
                    <DropdownMenuItem onClick={() => void handleExport('md')}>
                      <FileTextIcon className="mr-2 h-4 w-4" />
                      {t('page.exportMarkdown')}
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => void handleExport('html')}>
                      <FileCode className="mr-2 h-4 w-4" />
                      {t('page.exportHtml')}
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => void handleExport('pdf-paged')}>
                      <FileType className="mr-2 h-4 w-4" />
                      {t('page.exportPdfPaged')}
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => void handleExport('pdf-continuous')}>
                      <FileType className="mr-2 h-4 w-4" />
                      {t('page.exportPdfContinuous')}
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
          {doc && (
            <BlockEditor
              doc={doc}
              ariaLabel={title || 'Page content'}
              fullWidth={hud.viewMode.fullWidth}
              compact={hasDatabase}
              spellcheck={preferences.general.spellcheck}
            />
          )}
        </div>

        {footer}
      </div>
    </div>
  );

  return pageId ? <PageContextMenu pageId={pageId}>{body}</PageContextMenu> : body;
};

export default BlockPageDocument;
