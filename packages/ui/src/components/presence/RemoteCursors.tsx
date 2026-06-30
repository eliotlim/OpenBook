import React, {useCallback, useEffect, useState} from 'react';
import {createPortal} from 'react-dom';
import type {AwarenessState} from '@/blockeditor';
import {offsetToDom} from '@/blockeditor/richtext';
import {openDoc} from '@/lib/openDocs';
import {presencePeers, readableTextColor, resolveSelectionIndices} from '@/lib/presence';
import {useAwareness} from './useAwareness';

/**
 * Remote carets + selections in the editor (Collab T5). For every peer with a
 * live selection this paints, in the peer's colour, a caret (with a fading name
 * label) and — for a range — a translucent highlight, positioned over the right
 * block. Decorative only: the layer is `aria-hidden` and `pointer-events:none`, so
 * it never intercepts a click or blocks editing, and it mutates nothing in the
 * CRDT.
 *
 * Like {@link BlockReviewMarkers}, it lives OUTSIDE the editor's provider-less
 * React root and reaches into its DOM by stable block id, portaling the overlay
 * into the editor's positioned wrapper. The hard part is the contenteditable
 * position mapping (WKWebView included): a peer's `Y.RelativePosition` resolves to
 * an absolute offset (T4's round-trip), then `offsetToDom` + a collapsed Range give
 * the caret rect. A peer whose block is off-screen / collapsed (not in the DOM) or
 * whose position no longer resolves is skipped, never thrown on.
 */

interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}

interface CursorView {
  clientId: number;
  color: string;
  name: string;
  caret: Box | null;
  /** Selection highlight rectangles (empty for a collapsed caret). */
  rects: Box[];
  /** Changes when the caret moves — remounts the label to restart its fade. */
  moveKey: string;
}

/** The caret rect for a linear offset inside a text block, in viewport coords. */
function caretRectAt(el: HTMLElement, index: number): DOMRect | null {
  const {node, offset} = offsetToDom(el, index);
  const range = document.createRange();
  try {
    range.setStart(node, offset);
  } catch {
    return null;
  }
  range.collapse(true);
  const rects = range.getClientRects();
  if (rects.length > 0) return rects[0];
  const bounding = range.getBoundingClientRect();
  if (bounding.height || bounding.width || bounding.top || bounding.left) return bounding;
  // Empty line: fall back to the block element's own box (a caret at its start).
  const box = el.getBoundingClientRect();
  return new DOMRect(box.left, box.top, 0, box.height);
}

/** Selection highlight rects between two offsets, in viewport coords. */
function selectionRectsAt(el: HTMLElement, start: number, end: number): DOMRect[] {
  const from = offsetToDom(el, start);
  const to = offsetToDom(el, end);
  const range = document.createRange();
  try {
    range.setStart(from.node, from.offset);
    range.setEnd(to.node, to.offset);
  } catch {
    return [];
  }
  return Array.from(range.getClientRects()).filter((r) => r.width > 0 || r.height > 0);
}

export function RemoteCursors({pageId, containerRef}: {pageId: string; containerRef: React.RefObject<HTMLElement | null>}) {
  const {awareness, tick} = useAwareness(pageId);
  const [views, setViews] = useState<CursorView[]>([]);

  const measure = useCallback((): void => {
    const container = containerRef.current;
    const doc = openDoc(pageId);
    // Returning the SAME reference when nothing's on screen makes React bail out
    // of the re-render — so a local keystroke with no peers present (measure runs
    // on every doc update) doesn't churn a fresh empty array every time.
    if (!container || !doc || !awareness) {
      setViews((prev) => (prev.length === 0 ? prev : []));
      return;
    }
    const cRect = container.getBoundingClientRect();
    const rel = (r: DOMRect): Box => ({
      top: r.top - cRect.top,
      left: r.left - cRect.left,
      width: r.width,
      height: r.height,
    });
    const next: CursorView[] = [];
    // No dedupe: each connection (tab) gets its own caret.
    const peers = presencePeers(awareness.getStates() as Map<number, AwarenessState>, awareness.clientID, {dedupe: false});
    for (const peer of peers) {
      const sel = peer.selection;
      if (!sel || sel.anchor == null) continue; // present, but no caret to draw
      const el = container.querySelector<HTMLElement>(`[data-block-text="${CSS.escape(sel.blockId)}"]`);
      if (!el) continue; // block off-screen / collapsed / not rendered — skip gracefully
      const idx = resolveSelectionIndices(doc, sel);
      if (!idx) continue; // position no longer resolves (block deleted)
      const caretRect = caretRectAt(el, idx.head);
      const rects =
        idx.anchor === idx.head
          ? []
          : selectionRectsAt(el, Math.min(idx.anchor, idx.head), Math.max(idx.anchor, idx.head)).map(rel);
      next.push({
        clientId: peer.clientId,
        color: peer.color,
        name: peer.name,
        caret: caretRect ? rel(caretRect) : null,
        rects,
        moveKey: `${idx.anchor}:${idx.head}`,
      });
    }
    // Same bail when there's nothing now and nothing before (no peer carets).
    setViews((prev) => (prev.length === 0 && next.length === 0 ? prev : next));
  }, [pageId, containerRef, awareness]);

  // Re-measure on layout change (typing reflow, window/container resize) and once
  // shortly after mount, when the editor's async layout has settled.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      setViews((prev) => (prev.length === 0 ? prev : []));
      return;
    }
    const doc = openDoc(pageId);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(container);
    window.addEventListener('resize', measure);
    doc?.on('update', measure);
    const t = setTimeout(measure, 120);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measure);
      doc?.off('update', measure);
      clearTimeout(t);
    };
  }, [pageId, containerRef, measure]);

  // Re-measure on every presence change (a peer joined / moved / left).
  useEffect(() => {
    measure();
  }, [tick, measure]);

  const container = containerRef.current;
  if (!container || views.length === 0) return null;

  return createPortal(
    <div className="obe-rcursor-layer" aria-hidden>
      {views.map((view) => (
        <React.Fragment key={view.clientId}>
          {view.rects.map((r, i) => (
            <div
              key={`sel-${i}`}
              className="obe-rcursor-sel"
              style={{top: r.top, left: r.left, width: r.width, height: r.height, backgroundColor: view.color}}
            />
          ))}
          {view.caret && (
            <div
              className="obe-rcursor-caret"
              style={{top: view.caret.top, left: view.caret.left, height: view.caret.height || 18, backgroundColor: view.color}}
            >
              <span className="obe-rcursor-flag" style={{backgroundColor: view.color}} />
              <span
                key={view.moveKey}
                className="obe-rcursor-label"
                style={{backgroundColor: view.color, color: readableTextColor(view.color)}}
              >
                {view.name}
              </span>
            </div>
          )}
        </React.Fragment>
      ))}
    </div>,
    container,
  );
}

export default RemoteCursors;
