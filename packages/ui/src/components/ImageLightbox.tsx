import * as DialogPrimitive from '@radix-ui/react-dialog';
import {X} from 'lucide-react';
import {DialogPortal} from '@/components/ui/dialog';
import {useTranslation} from '@/providers';
import {closeLightbox, useImageLightbox} from '@/lib/imageLightbox';

/**
 * The image lightbox overlay (LBX-1): a single full-viewport surface that shows
 * one picture fit-to-viewport over a dark scrim. Opened from the block editor's
 * image view — the Expand button in edit mode, a plain click on a read-only /
 * present-mode image. In-app only (no `requestFullscreen`, which WKWebView
 * handles poorly); a Radix Dialog owns Esc-close, scrim-dismiss and focus
 * trapping, matching PresentMode.
 *
 * Mounted once, app-wide (see DefaultLayout), and driven by the module-level
 * {@link lib/imageLightbox} store so any image view can open it without a shared
 * provider. Deliberately does NOT zoom/pan — that's LBX-2; the picture sits in
 * its own centering frame so a zoom/transform layer can slot in around it later.
 */
export default function ImageLightbox() {
  const {t} = useTranslation();
  const state = useImageLightbox();
  const open = Boolean(state);

  return (
    <DialogPrimitive.Root open={open} onOpenChange={(o) => !o && closeLightbox()}>
      <DialogPortal>
        {/* Dark scrim — a lightbox reads better on near-black than the themed
            80%-background used by ordinary dialogs. Still honours the blur var. */}
        <DialogPrimitive.Overlay className="obe-lightbox-scrim fixed inset-0 z-[60] data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          aria-label={state?.alt ? state.alt : t('blocks.image.lightboxLabel')}
          className="obe-lightbox fixed inset-0 z-[60] flex flex-col items-center justify-center p-6 outline-hidden data-[state=open]:animate-in data-[state=open]:fade-in-0"
          onClick={(e) => {
            // A click on the backdrop (the flex frame itself, not the picture or
            // a control) dismisses — Radix's scrim sits behind the content, so we
            // handle background clicks here too.
            if (e.target === e.currentTarget) closeLightbox();
          }}
        >
          <DialogPrimitive.Title className="sr-only">
            {state?.alt ? state.alt : t('blocks.image.lightboxLabel')}
          </DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">
            {t('blocks.image.overlayDescription')}
          </DialogPrimitive.Description>

          {state && (
            <figure className="obe-lightbox-figure" onClick={(e) => e.stopPropagation()}>
              <img className="obe-lightbox-img" src={state.src} alt={state.alt} draggable={false} />
              {state.alt && <figcaption className="obe-lightbox-caption">{state.alt}</figcaption>}
            </figure>
          )}

          <DialogPrimitive.Close
            className="obe-lightbox-close"
            aria-label={t('blocks.image.close')}
            title={t('blocks.image.close')}
          >
            <X className="h-5 w-5" aria-hidden />
          </DialogPrimitive.Close>
        </DialogPrimitive.Content>
      </DialogPortal>
    </DialogPrimitive.Root>
  );
}
