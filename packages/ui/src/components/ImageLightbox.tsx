import {useCallback, useEffect, useRef, useState} from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import {Minus, Plus, RotateCcw, X} from 'lucide-react';
import {DialogPortal} from '@/components/ui/dialog';
import {useTranslation} from '@/providers';
import {closeLightbox, useImageLightbox} from '@/lib/imageLightbox';
import {suppressContextMenu} from '@/lib/suppressContextMenu';
import {
  clampPan,
  fitTransform,
  isFit,
  Metrics,
  toggleFitHundred,
  Transform,
  zoomByFactor,
  zoomPercent,
} from '@/lib/lightboxZoom';

/**
 * The image lightbox overlay (LBX-1 + zoom/pan LBX-2): a single full-viewport
 * surface showing one picture over a dark scrim. Opened from the block editor's
 * image view — the Expand button in edit mode, a plain click on a read-only /
 * present-mode image. In-app only (no `requestFullscreen`, which WKWebView
 * handles poorly); a Radix Dialog owns Esc-close, scrim-dismiss and focus
 * trapping, matching PresentMode.
 *
 * Zoom/pan (LBX-2): wheel / trackpad-pinch zooms centred on the cursor; drag
 * pans once zoomed past fit; double-click and the chrome toggle fit ↔ 100%;
 * `+`/`=`/`-` zoom and `0` fits. The zoom is a CSS `transform` on the live
 * `<img>` so animated GIFs keep playing (no canvas). All keys and the wheel are
 * kept from leaking to the PresentMode Deck's window keydown listener (which
 * would otherwise advance slides on Arrow/Space) via a capture-phase guard.
 */
export default function ImageLightbox() {
  const {t} = useTranslation();
  const state = useImageLightbox();
  const open = Boolean(state);

  const stageRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const [tr, setTr] = useState<Transform>(fitTransform);
  // A resolved-metrics flag so the chrome (percent readout) only appears once we
  // actually know the picture + stage size (post-load / -measure).
  const [ready, setReady] = useState(false);

  // Read live measurements off the DOM: the fit-rendered picture size
  // (offsetWidth/Height, pre-transform), the stage size and the 1:1 scale.
  const measure = useCallback((): Metrics | null => {
    const img = imgRef.current;
    const stage = stageRef.current;
    if (!img || !stage) return null;
    const renderW = img.offsetWidth;
    const renderH = img.offsetHeight;
    const rect = stage.getBoundingClientRect();
    if (renderW <= 0 || renderH <= 0 || rect.width <= 0) return null;
    const hundredScale = img.naturalWidth > 0 ? img.naturalWidth / renderW : 1;
    return {renderW, renderH, viewportW: rect.width, viewportH: rect.height, hundredScale};
  }, []);

  // The cursor's offset from the stage centre — the pivot the zoom keeps fixed.
  const cursorDelta = useCallback((clientX: number, clientY: number): [number, number] => {
    const stage = stageRef.current;
    if (!stage) return [0, 0];
    const rect = stage.getBoundingClientRect();
    return [clientX - (rect.left + rect.width / 2), clientY - (rect.top + rect.height / 2)];
  }, []);

  // Reset the transform whenever a new picture opens (or it closes).
  useEffect(() => {
    setTr(fitTransform());
    setReady(false);
  }, [state?.src]);

  // ── Wheel / trackpad-pinch zoom ────────────────────────────────────────────
  // A non-passive native listener so we can preventDefault (React's onWheel is
  // passive and can't). ctrlKey wheel === a trackpad pinch. Zoom is centred on
  // the cursor. stopPropagation keeps the page/Deck from also reacting.
  useEffect(() => {
    const stage = stageRef.current;
    if (!open || !stage) return;
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      e.stopPropagation();
      const m = measure();
      if (!m) return;
      // Pinch (ctrlKey) deltas are tiny; ordinary wheel deltas are large.
      const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
      const [dx, dy] = cursorDelta(e.clientX, e.clientY);
      setTr((prev) => zoomByFactor(prev, factor, dx, dy, m));
    };
    stage.addEventListener('wheel', onWheel, {passive: false});
    return () => stage.removeEventListener('wheel', onWheel);
  }, [open, measure, cursorDelta]);

  // ── Keyboard: +/=/- zoom, 0 fit; keep Arrow/Space from leaking to the Deck ──
  // A capture-phase window listener (runs before PresentMode's bubble-phase
  // window keydown) so, while the lightbox is open, navigation keys never reach
  // the Deck. Escape is deliberately left alone — Radix owns close.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') return; // Radix Dialog closes on Escape
      if (e.metaKey || e.altKey) return; // don't shadow browser/OS shortcuts
      // Latent safety: never hijack keys typed into a form control (none exist in
      // the lightbox today, but a caption editor or search box could arrive).
      if (
        e.target instanceof Element &&
        e.target.closest('input, textarea, select, [contenteditable="true"]')
      )
        return;
      // Keyboard zoom is centred on the picture (cursor delta 0,0).
      if (e.key === '+' || e.key === '=') {
        e.preventDefault();
        e.stopPropagation();
        const m = measure();
        if (m) setTr((prev) => zoomByFactor(prev, 1.25, 0, 0, m));
      } else if (e.key === '-' || e.key === '_') {
        e.preventDefault();
        e.stopPropagation();
        const m = measure();
        if (m) setTr((prev) => zoomByFactor(prev, 0.8, 0, 0, m));
      } else if (e.key === '0') {
        e.preventDefault();
        e.stopPropagation();
        setTr(fitTransform());
      } else if (
        e.key === 'ArrowRight' ||
        e.key === 'ArrowLeft' ||
        e.key === 'ArrowUp' ||
        e.key === 'ArrowDown' ||
        e.key === ' ' ||
        e.key === 'Spacebar' ||
        e.key === 'PageUp' ||
        e.key === 'PageDown'
      ) {
        // Swallow so the PresentMode Deck underneath doesn't advance slides.
        e.stopPropagation();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, measure]);

  // ── Drag to pan (only meaningful once zoomed past fit) ──────────────────────
  const drag = useRef<{id: number; x: number; y: number; moved: boolean} | null>(null);
  const zoomed = !isFit(tr);

  const onPointerDown = (e: React.PointerEvent): void => {
    if (!zoomed || e.button !== 0) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = {id: e.pointerId, x: e.clientX, y: e.clientY, moved: false};
  };
  const onPointerMove = (e: React.PointerEvent): void => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (Math.abs(dx) + Math.abs(dy) > 2) d.moved = true;
    d.x = e.clientX;
    d.y = e.clientY;
    const m = measure();
    if (!m) return;
    // Add the raw drag delta and re-clamp so panning can't strand the picture.
    setTr((prev) => clampPan({scale: prev.scale, tx: prev.tx + dx, ty: prev.ty + dy}, m));
  };
  const endDrag = (e: React.PointerEvent): void => {
    const d = drag.current;
    if (d && d.id === e.pointerId) {
      try {
        (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
      } catch {
        // capture may already be gone
      }
    }
  };
  const cancelDrag = (e: React.PointerEvent): void => {
    endDrag(e);
    // Unlike pointerup, a pointercancel is not followed by a click — so clear the
    // drag state here or a stale `moved` would swallow the next background click.
    drag.current = null;
  };

  // A background click (not a drag, not on the picture) dismisses.
  const onStageClick = (e: React.MouseEvent): void => {
    if (drag.current?.moved) {
      drag.current = null;
      return;
    }
    drag.current = null;
    if (e.target === stageRef.current) closeLightbox();
  };

  const doToggle = (clientX?: number, clientY?: number): void => {
    const m = measure();
    if (!m) return;
    const [dx, dy] = clientX != null && clientY != null ? cursorDelta(clientX, clientY) : [0, 0];
    setTr((prev) => toggleFitHundred(prev, dx, dy, m));
  };

  const onReady = (): void => setReady(true);

  const metricsForPercent = measure();
  const percent = metricsForPercent && ready ? zoomPercent(tr, metricsForPercent) : null;

  return (
    <DialogPrimitive.Root open={open} onOpenChange={(o) => !o && closeLightbox()}>
      <DialogPortal>
        {/* Dark scrim — a lightbox reads better on near-black than the themed
            80%-background used by ordinary dialogs. Still honours the blur var. */}
        <DialogPrimitive.Overlay className="obe-lightbox-scrim fixed inset-0 z-lightbox data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          aria-label={state?.alt ? state.alt : t('blocks.image.lightboxLabel')}
          className="obe-lightbox fixed inset-0 z-lightbox flex flex-col outline-hidden data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0"
        >
          <DialogPrimitive.Title className="sr-only">
            {state?.alt ? state.alt : t('blocks.image.lightboxLabel')}
          </DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">
            {t('blocks.image.overlayDescription')}
          </DialogPrimitive.Description>

          {state && (
            <>
              <div
                ref={stageRef}
                className={`obe-lightbox-stage${zoomed ? ' obe-lightbox-stage-zoomed' : ''}`}
                data-zoomed={zoomed ? 'yes' : 'no'}
                onContextMenu={suppressContextMenu}
                onClick={onStageClick}
                onDoubleClick={(e) => doToggle(e.clientX, e.clientY)}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={endDrag}
                onPointerCancel={cancelDrag}
              >
                <img
                  ref={imgRef}
                  className="obe-lightbox-img"
                  src={state.src}
                  alt={state.alt}
                  draggable={false}
                  style={{transform: `translate3d(${tr.tx}px, ${tr.ty}px, 0) scale(${tr.scale})`}}
                  onLoad={onReady}
                  // Defensive: if the src is revoked out from under us (a
                  // concurrent asset swap revokes the objectURL), the img errors
                  // — close gracefully rather than show a broken picture.
                  onError={() => closeLightbox()}
                />
              </div>

              {state.alt && <figcaption className="obe-lightbox-caption">{state.alt}</figcaption>}
            </>
          )}

          {/* Zoom chrome: a live percentage + a reset-to-fit control. */}
          {percent != null && (
            <div className="obe-lightbox-zoombar" role="group" aria-label={t('blocks.image.zoomControls')}>
              <button
                type="button"
                className="obe-lightbox-zoombtn"
                aria-label={t('blocks.image.zoomOut')}
                title={t('blocks.image.zoomOut') + ' (−)'}
                onClick={() => {
                  const m = measure();
                  if (m) setTr((prev) => zoomByFactor(prev, 0.8, 0, 0, m));
                }}
              >
                <Minus className="h-4 w-4" aria-hidden />
              </button>
              <span className="obe-lightbox-zoomvalue">
                {t('blocks.image.zoomLevel', {percent})}
              </span>
              <button
                type="button"
                className="obe-lightbox-zoombtn"
                aria-label={t('blocks.image.zoomIn')}
                title={t('blocks.image.zoomIn') + ' (+)'}
                onClick={() => {
                  const m = measure();
                  if (m) setTr((prev) => zoomByFactor(prev, 1.25, 0, 0, m));
                }}
              >
                <Plus className="h-4 w-4" aria-hidden />
              </button>
              <button
                type="button"
                className="obe-lightbox-zoombtn obe-lightbox-zoomreset"
                aria-label={t('blocks.image.zoomReset')}
                title={t('blocks.image.zoomReset') + ' (0)'}
                disabled={!zoomed}
                onClick={() => setTr(fitTransform())}
              >
                <RotateCcw className="h-4 w-4" aria-hidden />
              </button>
            </div>
          )}

          <DialogPrimitive.Close
            className="obe-lightbox-close"
            aria-label={t('blocks.image.close')}
            title={t('blocks.image.close')}
          >
            <X className="h-4 w-4" aria-hidden />
          </DialogPrimitive.Close>
        </DialogPrimitive.Content>
      </DialogPortal>
    </DialogPrimitive.Root>
  );
}
