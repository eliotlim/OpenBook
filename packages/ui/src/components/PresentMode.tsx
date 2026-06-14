import React, {useCallback, useEffect, useMemo, useReducer, useRef, useState} from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import {ChevronLeft, ChevronRight, Maximize2, Monitor, X} from 'lucide-react';
import {DialogPortal} from '@/components/ui/dialog';
import {useHud, useNavigation} from '@/providers';
import {openDoc, subscribeOpenDocs} from '@/lib/openDocs';
import {readPageIcon} from '@/lib/pageIcon';
import {splitSlides} from '@/blockeditor/present';
import {PresentBlocks} from '@/blockeditor/PresentBlocks';
import type {PresentMode as PresentModeKind} from '@/lib/hud';

/**
 * Present mode: a page rendered as a slide deck (split at every `divider`),
 * read-only but with its interactive widgets still live. Two layouts — an
 * immersive full-screen deck, or a presenter console with the next slide and
 * speaker notes. Entered from the page's "…" menu; driven by HUD state.
 */
export default function PresentMode() {
  const {hud, setHud} = useHud();
  const {open, mode, pageId} = hud.present;
  const close = useCallback(() => setHud((d) => {d.present.open = false; return d;}), [setHud]);
  const setMode = useCallback(
    (next: PresentModeKind) => setHud((d) => {d.present.mode = next; return d;}),
    [setHud],
  );

  return (
    <DialogPrimitive.Root open={open} onOpenChange={(o) => !o && close()}>
      <DialogPortal>
        <DialogPrimitive.Content
          aria-label="Present"
          className="fixed inset-0 z-50 outline-hidden data-[state=open]:animate-in data-[state=open]:fade-in-0"
        >
          <DialogPrimitive.Title className="sr-only">Present</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">Slide presentation of the page</DialogPrimitive.Description>
          {open && <Deck pageId={pageId} mode={mode} onClose={close} onSetMode={setMode} />}
        </DialogPrimitive.Content>
      </DialogPortal>
    </DialogPrimitive.Root>
  );
}

const Deck: React.FC<{
  pageId: string | null;
  mode: PresentModeKind;
  onClose: () => void;
  onSetMode: (m: PresentModeKind) => void;
}> = ({pageId, mode, onClose, onSetMode}) => {
  const {pageLabel} = useNavigation();
  const rootRef = useRef<HTMLDivElement>(null);

  // Track the live doc (it may register a tick after the overlay opens) and
  // re-split when its structure changes (a divider added mid-present).
  const [ver, refresh] = useReducer((n: number) => n + 1, 0);
  useEffect(() => subscribeOpenDocs(refresh), []);
  const doc = openDoc(pageId);
  useEffect(() => {
    if (!doc) return;
    const onUpdate = (): void => refresh();
    doc.on('update', onUpdate);
    return () => doc.off('update', onUpdate);
  }, [doc]);

  const slides = useMemo(() => (doc ? splitSlides(doc) : []), [doc, ver]);
  const [index, setIndex] = useState(0);
  const count = slides.length;
  const i = Math.min(index, Math.max(0, count - 1));
  const go = useCallback(
    (delta: number) => setIndex((cur) => Math.max(0, Math.min(count - 1, cur + delta))),
    [count],
  );

  // Full screen: take the real OS fullscreen so browser chrome vanishes too.
  useEffect(() => {
    if (mode !== 'fullscreen') return;
    const el = rootRef.current;
    void el?.requestFullscreen?.().catch(() => undefined);
    return () => {
      if (typeof document !== 'undefined' && document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    };
  }, [mode]);

  // Keyboard: arrows / space / page keys navigate; Esc exits. Skip when a form
  // control has focus so an interactive widget (slider, input) keeps its keys.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') return; // Radix Dialog closes on Escape
      const t = e.target as HTMLElement | null;
      if (t && t.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ' || e.key === 'Spacebar') {
        e.preventDefault();
        go(1);
      } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
        e.preventDefault();
        go(-1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [go]);

  if (!doc) {
    return (
      <div className="ob-present grid h-full place-items-center text-muted-foreground">
        Open the page to present it.
      </div>
    );
  }

  const slide = slides[i];
  const next = slides[i + 1];
  const title = pageId ? pageLabel(pageId) : '';
  const icon = pageId ? readPageIcon(pageId) : '';

  // The audience deck — a centred, scrollable sheet that fades+slides up on
  // change (re-keyed by index so the whole slide animates as one).
  const stage = (
    <div className="ob-present-stage">
      <div key={i} className="ob-slide" data-slide={i}>
        {i === 0 && (title || icon) && (
          <header className="ob-slide-title">
            {icon && <span className="ob-slide-title-icon">{icon}</span>}
            {title && <h1>{title}</h1>}
          </header>
        )}
        <PresentBlocks doc={doc} blocks={slide?.content ?? []} />
      </div>
    </div>
  );

  const counter = (
    <span className="ob-present-counter" aria-live="polite">
      {i + 1} / {count}
    </span>
  );

  const controls = (
    <div className="ob-present-controls">
      <button type="button" aria-label="Previous slide" disabled={i === 0} onClick={() => go(-1)}>
        <ChevronLeft className="h-5 w-5" />
      </button>
      {counter}
      <button type="button" aria-label="Next slide" disabled={i >= count - 1} onClick={() => go(1)}>
        <ChevronRight className="h-5 w-5" />
      </button>
    </div>
  );

  const topbar = (
    <div className="ob-present-topbar">
      <button
        type="button"
        className="ob-present-modebtn"
        aria-label={mode === 'fullscreen' ? 'Presenter view' : 'Full screen'}
        title={mode === 'fullscreen' ? 'Presenter view' : 'Full screen'}
        onClick={() => onSetMode(mode === 'fullscreen' ? 'presenter' : 'fullscreen')}
      >
        {mode === 'fullscreen' ? <Monitor className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
      </button>
      <button type="button" className="ob-present-modebtn" aria-label="Exit present" title="Exit (Esc)" onClick={onClose}>
        <X className="h-4 w-4" />
      </button>
    </div>
  );

  if (mode === 'presenter') {
    return (
      <div ref={rootRef} className="ob-present ob-present-presenter">
        <main className="ob-present-main">
          {stage}
          {controls}
        </main>
        <aside className="ob-present-aside">
          {topbar}
          <PresenterClock />
          <section className="ob-present-next">
            <h2>Next</h2>
            {next ? (
              <div className="ob-present-next-frame">
                <div className="ob-present-next-scale">
                  <PresentBlocks doc={doc} blocks={next.content} />
                </div>
              </div>
            ) : (
              <p className="ob-present-empty">End of deck</p>
            )}
          </section>
          <section className="ob-present-notes-panel">
            <h2>Speaker notes</h2>
            {slide && slide.notes.length > 0 ? (
              <PresentBlocks doc={doc} blocks={slide.notes} />
            ) : (
              <p className="ob-present-empty">No notes for this slide</p>
            )}
          </section>
        </aside>
      </div>
    );
  }

  // Full screen: immersive; the top bar + controls fade in on hover.
  return (
    <div ref={rootRef} className="ob-present ob-present-full" onClick={(e) => advanceOnBackground(e, () => go(1))}>
      {topbar}
      {stage}
      {controls}
    </div>
  );
};

/** Advance only when the click lands on empty slide space — never on a widget,
 *  link, or control (so interactive elements keep working). */
function advanceOnBackground(e: React.MouseEvent, advance: () => void): void {
  const t = e.target as HTMLElement;
  if (t.closest('a, button, input, textarea, select, [role="slider"], .obe-kit, .obe-codeblock, [contenteditable="true"]')) return;
  advance();
}

/** Elapsed-time clock for the presenter console. */
const PresenterClock: React.FC = () => {
  const start = useRef(Date.now());
  const [, tick] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);
  const secs = Math.floor((Date.now() - start.current) / 1000);
  const mm = String(Math.floor(secs / 60)).padStart(2, '0');
  const ss = String(secs % 60).padStart(2, '0');
  return (
    <div className="ob-present-timer" aria-label="Elapsed time">
      {mm}:{ss}
    </div>
  );
};
