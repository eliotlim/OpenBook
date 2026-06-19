import React, {useCallback, useRef, useState} from 'react';
import {Image as ImageIcon, MoveVertical, Check, Trash2} from 'lucide-react';
import {useTranslation} from '@/providers';
import {Popover, PopoverContent, PopoverTrigger} from '@/components/ui/popover';
import {COVER_GRADIENTS, usePageCover, writePageCover} from '@/lib/pageCover';
import {cn} from '@/lib/utils';

/**
 * The wide cover banner above a page's title (a gradient or an image). Hovering
 * reveals controls to change, reposition (images only), or remove it. The cover
 * is a local per-page preference (see {@link lib/pageCover}).
 */
export function PageCoverBanner({pageId}: {pageId: string}) {
  const cover = usePageCover(pageId);
  const {t} = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const [repositioning, setRepositioning] = useState(false);
  const dragRef = useRef<{startY: number; startPos: number} | null>(null);
  const [livePos, setLivePos] = useState<number | null>(null);

  const position = cover?.kind === 'image' ? livePos ?? cover.position ?? 50 : 50;

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!repositioning || cover?.kind !== 'image') return;
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      dragRef.current = {startY: e.clientY, startPos: position};
    },
    [repositioning, cover, position],
  );

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const h = ref.current?.clientHeight ?? 176;
    if (!drag) return;
    const next = drag.startPos - ((e.clientY - drag.startY) / h) * 100;
    setLivePos(Math.min(100, Math.max(0, Math.round(next))));
  }, []);

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragRef.current) return;
      dragRef.current = null;
      e.currentTarget.releasePointerCapture(e.pointerId);
      if (cover?.kind === 'image' && livePos !== null) writePageCover(pageId, {...cover, position: livePos});
      setLivePos(null); // fall back to the persisted position
    },
    [cover, livePos, pageId],
  );

  if (!cover) return null;

  return (
    <div
      ref={ref}
      className="ob-page-cover group/cover relative w-full overflow-hidden"
      contentEditable={false}
    >
      {cover.kind === 'gradient' ? (
        <div className="absolute inset-0" style={{background: cover.css}} />
      ) : (
        <div
          className="absolute inset-0 bg-cover bg-no-repeat"
          style={{backgroundImage: `url("${cover.url}")`, backgroundPosition: `50% ${position}%`}}
        />
      )}

      {/* Reposition surface — only catches drags while in reposition mode. */}
      {repositioning && cover.kind === 'image' && (
        <div
          className="absolute inset-0 cursor-ns-resize"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          <span className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-md bg-black/55 px-2 py-1 text-xs font-medium text-white">
            {t('page.coverDragHint')}
          </span>
        </div>
      )}

      <div className="absolute bottom-2.5 right-3 flex items-center gap-1 opacity-0 transition-opacity group-hover/cover:opacity-100 focus-within:opacity-100">
        {repositioning ? (
          <CoverButton onClick={() => setRepositioning(false)} icon={<Check className="h-3.5 w-3.5" />} label={t('page.coverDone')} />
        ) : (
          <>
            {cover.kind === 'image' && (
              <CoverButton
                onClick={() => setRepositioning(true)}
                icon={<MoveVertical className="h-3.5 w-3.5" />}
                label={t('page.coverReposition')}
              />
            )}
            <CoverPicker pageId={pageId}>
              <CoverButton icon={<ImageIcon className="h-3.5 w-3.5" />} label={t('page.coverChange')} />
            </CoverPicker>
            <CoverButton
              onClick={() => writePageCover(pageId, null)}
              icon={<Trash2 className="h-3.5 w-3.5" />}
              label={t('page.coverRemove')}
            />
          </>
        )}
      </div>
    </div>
  );
}

/** A frosted pill button overlaid on the cover. */
const CoverButton = React.forwardRef<HTMLButtonElement, {onClick?: () => void; icon: React.ReactNode; label: string}>(
  ({onClick, icon, label}, ref) => (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1 rounded-md bg-black/45 px-2 py-1 text-xs font-medium text-white backdrop-blur-sm transition-colors hover:bg-black/65"
    >
      {icon}
      {label}
    </button>
  ),
);
CoverButton.displayName = 'CoverButton';

/**
 * The cover chooser: a grid of curated gradients plus an image-URL field.
 * `children` is the trigger (used both by the "Add cover" header button and the
 * "Change cover" overlay button).
 */
export function CoverPicker({pageId, children}: {pageId: string; children: React.ReactNode}) {
  const {t} = useTranslation();
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState('');

  const applyImage = () => {
    const trimmed = url.trim();
    if (!trimmed) return;
    writePageCover(pageId, {kind: 'image', url: trimmed, position: 50});
    setUrl('');
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align="start" className="w-80">
        <div className="flex flex-col gap-3">
          <span className="text-sm font-semibold">{t('page.coverChoose')}</span>
          <div className="grid grid-cols-4 gap-2">
            {COVER_GRADIENTS.map((g) => (
              <button
                key={g.id}
                type="button"
                aria-label={g.id}
                onClick={() => {
                  writePageCover(pageId, {kind: 'gradient', css: g.css});
                  setOpen(false);
                }}
                className={cn(
                  'h-10 rounded-md border border-border/60 transition-transform hover:scale-105',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                )}
                style={{background: g.css}}
              />
            ))}
          </div>
          <div className="flex flex-col gap-1.5 border-t border-border pt-3">
            <span className="text-xs font-medium text-muted-foreground">{t('page.coverImageUrl')}</span>
            <div className="flex gap-1.5">
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && applyImage()}
                placeholder="https://…"
                spellCheck={false}
                className="min-w-0 flex-1 rounded-md border border-border bg-card px-2 py-1.5 text-sm outline-hidden transition-[color,border-color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40"
              />
              <button
                type="button"
                onClick={applyImage}
                disabled={!url.trim()}
                className="shrink-0 rounded-md bg-primary px-2.5 py-1.5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
              >
                {t('page.coverApply')}
              </button>
            </div>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
