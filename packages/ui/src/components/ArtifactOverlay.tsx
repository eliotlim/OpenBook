import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import {AppWindow, X} from 'lucide-react';
import {DialogPortal} from '@/components/ui/dialog';
import {Button} from '@/components/ui/button';
import {SandboxedHtml} from '@/components/SandboxedHtml';
import {t} from '@/i18n';

/**
 * "Run / present" an HTML artifact full-window: the sandboxed document
 * edge-to-edge in a full-viewport overlay, with a slim chrome bar (title +
 * close). Mirrors the PresentMode surface (a Radix Dialog portaled over the
 * app, Esc closes, fade-in enter) but is deliberately its own component: it
 * mounts from the block editor's bare React root, so — like the block views —
 * it must stay provider-free (bare `t`, no HUD/navigation hooks).
 *
 * ── Sandbox state: CLEAN RE-INSTANTIATION (deterministic, by design) ────────
 * The overlay renders a SECOND {@link SandboxedHtml} from the same source
 * document. Reparenting the inline iframe into the overlay would reload its
 * srcdoc anyway (moving an iframe re-instantiates it), and CSS-expanding it in
 * place is fragile across mount surfaces (any transformed ancestor — a slide
 * animation, the presenter preview scale — silently becomes its containing
 * block). So the contract is:
 *  - expanding starts the artifact FRESH from its initial state;
 *  - the inline frame underneath is untouched — closing the overlay returns
 *    you to the inline instance exactly as you left it.
 *
 * ── Focus recovery (the sandbox-focus ergonomic) ────────────────────────────
 * Clicking inside the artifact focuses the cross-origin frame, where the app
 * cannot see keystrokes — Esc only works once focus returns to the app. A
 * mouse user is never trapped: the close button in the chrome bar always
 * works, and any click on the chrome (it is app DOM) restores focus so Esc
 * works again. Esc itself is handled by Radix (topmost layer only, so inside
 * present mode it closes the overlay first, then present).
 */
export interface ArtifactOverlayProps {
  /** The artifact's source document (already resolved from the asset store). */
  html: string;
  /** Chrome-bar caption; also the frame's accessible title. */
  title: string;
  onClose: () => void;
}

export function ArtifactOverlay({html, title, onClose}: ArtifactOverlayProps): React.ReactElement {
  return (
    <DialogPrimitive.Root open onOpenChange={(open) => !open && onClose()}>
      <DialogPortal>
        <DialogPrimitive.Content
          data-testid="artifact-overlay"
          className="fixed inset-0 z-50 flex flex-col bg-background outline-hidden data-[state=open]:animate-in data-[state=open]:fade-in-0"
        >
          <DialogPrimitive.Title className="sr-only">{title}</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">{t('blocks.artifact.overlayDescription')}</DialogPrimitive.Description>
          {/* Chrome bar: app DOM — clicking anywhere on it recovers focus from
              the sandboxed frame, and the close button always works. */}
          <header className="flex h-11 flex-none items-center gap-2 border-b border-border px-3">
            <AppWindow className="h-4 w-4 flex-none text-muted-foreground" aria-hidden />
            <span className="min-w-0 flex-1 truncate text-sm font-medium">{title}</span>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-8 w-8 cursor-pointer"
              aria-label={t('blocks.artifact.close')}
              title={`${t('blocks.artifact.close')} (Esc)`}
              onClick={onClose}
            >
              <X className="h-4 w-4" />
            </Button>
          </header>
          {/* Edge-to-edge frame: a fresh sandboxed instance filling the rest
              of the viewport (see the state contract in the doc comment). */}
          <div className="min-h-0 flex-1">
            <SandboxedHtml
              html={html}
              fill
              className="rounded-none border-0"
              title={title}
              emptyLabel={t('blocks.artifact.empty')}
              errorLabel={t('blocks.artifact.error')}
            />
          </div>
        </DialogPrimitive.Content>
      </DialogPortal>
    </DialogPrimitive.Root>
  );
}

export default ArtifactOverlay;
