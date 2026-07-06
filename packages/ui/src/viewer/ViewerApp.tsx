import React, {useEffect, useMemo, useState} from 'react';
import {PresentBlocks} from '@/blockeditor/PresentBlocks';
import {decodeSnapshot, rootBlocks, type BlockDocSnapshot} from '@/blockeditor/model';
import {KitPageLockContext} from '@/blockeditor/kit/lock';
import {SandboxCspContext} from '@/components/SandboxedHtml';
import {EXPORT_ARTIFACT_CSP} from '@/lib/srcdoc';
import {DataSchemeProvider, readGlobalDataScheme} from '@/lib/dataScheme';
import type {SpaceBundleJson, SpaceBundlePage, ViewerPage, ViewerSource} from './types';

/**
 * The viewer's React shell: locked-but-interactive rendering of one page (a
 * `.book.html` island) or a whole space bundle with minimal hash-based page
 * navigation (`#page=<id>`).
 *
 * Rendering reuses {@link PresentBlocks} — the same locked surface Present
 * mode uses (real BlockRow renderer, `KitLockContext {locked:true}`), so kit
 * widgets stay operable while text/structure are read-only. On top of that the
 * viewer provides {@link KitPageLockContext} so widget *chrome* (inline labels,
 * group names) freezes to plain text exactly like the app's whole-page
 * read-only mode — interaction may mutate the in-memory Y.Doc (that's what
 * makes sliders/charts live), but nothing is ever persisted anywhere.
 */

const pageIcon = (page: SpaceBundlePage): string | null => {
  const icon = page.properties?.sys_icon;
  return typeof icon === 'string' ? icon : null;
};

/** Normalise either source shape to a flat page list. */
export function pagesOf(source: ViewerSource): ViewerPage[] {
  if ('pages' in source && Array.isArray(source.pages)) {
    return (source as SpaceBundleJson).pages
      .filter((p) => p && typeof p.id === 'string')
      .map((p) => ({id: p.id, name: p.name ?? null, icon: pageIcon(p), data: p.data ?? {}}));
  }
  const page = source as {id: string; name?: string | null; icon?: string | null; data?: ViewerPage['data']};
  return [{id: page.id, name: page.name ?? null, icon: page.icon ?? null, data: page.data ?? {}}];
}

/** The block-doc snapshot inside a page's data, when it carries one. */
const blockdocOf = (data: ViewerPage['data']): BlockDocSnapshot | undefined => {
  const bd = data?.blockdoc as BlockDocSnapshot | undefined;
  return bd && (typeof bd.update === 'string' || Array.isArray(bd.blocks)) ? bd : undefined;
};

const hashPageId = (): string | null => {
  if (typeof window === 'undefined') return null;
  const m = /(?:^#|[#&])page=([^&]*)/.exec(window.location.hash);
  return m ? decodeURIComponent(m[1]) : null;
};

/** One page, rendered read-only with live widgets. */
const PageView: React.FC<{page: ViewerPage}> = ({page}) => {
  // The Y.Doc is rebuilt per page from the island snapshot (base64 update,
  // falling back to the JSON blocks projection) and lives only in memory.
  const doc = useMemo(() => decodeSnapshot(blockdocOf(page.data)), [page]);
  const blocks = useMemo(() => rootBlocks(doc).toArray(), [doc]);
  const title = (page.name ?? '').trim() || 'Untitled';
  return (
    <article className="ob-viewer-page" data-viewer-page={page.id}>
      <h1 className="ob-viewer-title">
        {page.icon && (
          <span className="ob-viewer-title-icon" aria-hidden>
            {page.icon}
          </span>
        )}
        {title}
      </h1>
      <PresentBlocks doc={doc} blocks={blocks} />
    </article>
  );
};

export const ViewerApp: React.FC<{source: ViewerSource; initialPage?: string}> = ({source, initialPage}) => {
  const pages = useMemo(() => pagesOf(source), [source]);

  const resolve = (ref: string | null | undefined): ViewerPage | undefined =>
    ref ? (pages.find((p) => p.id === ref) ?? pages.find((p) => p.name === ref)) : undefined;

  const [activeId, setActiveId] = useState<string>(
    () => (resolve(hashPageId()) ?? resolve(initialPage) ?? pages[0])?.id ?? '',
  );

  // Hash-based navigation (`#page=<id>`): plain anchors drive the hash, the
  // hash drives the page — so browser back/forward work, even from file://.
  useEffect(() => {
    const onHash = (): void => {
      const ref = hashPageId();
      // A cleared hash (browser back past the first navigation) is the
      // default page again; an unknown ref keeps the current page.
      const page = ref ? resolve(ref) : pages[0];
      if (page) setActiveId(page.id);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [pages]);

  const active = pages.find((p) => p.id === activeId) ?? pages[0];

  // In-content page mentions navigate within the bundle. PresentBlocks renders
  // mentions as inert anchors (the click handler lives on the editable editor's
  // root, which the viewer never mounts), so the viewer provides its own.
  const onClick = (e: React.MouseEvent): void => {
    const anchor = (e.target as HTMLElement).closest?.('a.obe-mention');
    if (!(anchor instanceof HTMLElement)) return;
    const ref = anchor.dataset.pageId;
    if (ref && pages.some((p) => p.id === ref)) {
      e.preventDefault();
      window.location.hash = `page=${encodeURIComponent(ref)}`;
    } else {
      e.preventDefault(); // a mention of a page outside the export: inert
    }
  };

  if (!active) return <div className="ob-viewer-empty">Nothing to show.</div>;

  return (
    // The concrete-hex chart/map surfaces (kit charts) resolve the scheme the
    // export baked in, matching the CSS-var surfaces applyDataColors set (OB-379).
    <DataSchemeProvider value={readGlobalDataScheme()}>
      <KitPageLockContext.Provider value={true}>
        {/* Standalone exports stay quiet on open: artifacts get the sub-resource-
          off CSP on top of the opaque-origin sandbox (closes fetch/img/media/
          font/form loads; frame self-navigation is the documented residual —
          see EXPORT_ARTIFACT_CSP). */}
        <SandboxCspContext.Provider value={EXPORT_ARTIFACT_CSP}>
          <div className="ob-viewer" onClick={onClick}>
            {pages.length > 1 && (
              <nav className="ob-viewer-nav" aria-label="Pages">
                {pages.map((p) => (
                  <a
                    key={p.id}
                    href={`#page=${encodeURIComponent(p.id)}`}
                    className={`ob-viewer-nav-link${p.id === active.id ? ' ob-viewer-nav-on' : ''}`}
                    aria-current={p.id === active.id ? 'page' : undefined}
                  >
                    {p.icon ? `${p.icon} ` : ''}
                    {(p.name ?? '').trim() || 'Untitled'}
                  </a>
                ))}
              </nav>
            )}
            <PageView key={active.id} page={active} />
          </div>
        </SandboxCspContext.Provider>
      </KitPageLockContext.Provider>
    </DataSchemeProvider>
  );
};
