import React, {useEffect, useRef, useState} from 'react';
import {AppWindow, FileWarning, Loader2, Maximize2, Upload} from 'lucide-react';
import {blockId, blockProp, setBlockProp, type BlockMap} from './model';
import {htmlArtifactBlockFromFile, isHtmlFile, type HtmlArtifactBlockProps} from './htmlArtifactBlock';
import {useKitLock} from './kit/lock';
import {assetBridge} from '@/lib/assetBridge';
import {getPageIdForDoc} from '@/lib/aiBridge';
import {SandboxedHtml} from '@/components/SandboxedHtml';
import {ArtifactOverlay} from '@/components/ArtifactOverlay';
import {t} from '../i18n';
import type {BlockEditorController} from './useBlockEditor';
import type {EditorUI} from './BlockEditor';

/**
 * The HTML artifact block: an untrusted, self-contained HTML document rendered
 * through the reusable sandboxed-iframe surface ({@link SandboxedHtml} — opaque
 * origin, never `allow-same-origin`; see lib/srcdoc.ts for the contract).
 *
 * The document lives in the content-addressed asset store; this view resolves
 * the block's `assetId` to text via the asset bridge and hands it to the
 * renderer. (The server intentionally serves stored assets as octet-stream so
 * they can never execute on the app origin — the bytes only become "HTML" again
 * inside the sandbox.) The artifact itself stays INTERACTIVE everywhere —
 * present mode, viewer read-only, locked groups — that is the point of the
 * block; only the *chrome* (title, replace, resize) is authoring UI, frozen
 * whenever the block is read-only or kit-locked. The frame keeps a fixed,
 * prop-driven height, so loading (skeleton) → loaded never shifts the layout of
 * a long page with several artifacts.
 */

/** Default frame height (px) — matches SandboxedHtml's own default. */
export const DEFAULT_ARTIFACT_HEIGHT = 320;
const MIN_ARTIFACT_HEIGHT = 120;
const MAX_ARTIFACT_HEIGHT = 1200;

export const HtmlArtifactBlockView: React.FC<{block: BlockMap; editor: BlockEditorController; ui: EditorUI}> = ({
  block,
  editor,
}) => {
  const id = blockId(block);
  const assetId = blockProp<string>(block, 'assetId');
  const title = blockProp<string>(block, 'title') ?? '';
  const rawHeight = blockProp<number>(block, 'height');
  const height = Math.max(
    MIN_ARTIFACT_HEIGHT,
    Math.min(MAX_ARTIFACT_HEIGHT, typeof rawHeight === 'number' && Number.isFinite(rawHeight) ? rawHeight : DEFAULT_ARTIFACT_HEIGHT),
  );
  // The artifact content is always live (the sandbox is the boundary); the
  // authoring chrome freezes under editor read-only OR any kit lock (a locked
  // group, present mode's page lock, a viewer who can't write).
  const locked = useKitLock();
  const chrome = !editor.readOnly && !locked;

  const [html, setHtml] = useState<string | null>(null);
  const [broken, setBroken] = useState(false);
  // Full-window run/present overlay (ArtifactOverlay). A VIEWING affordance:
  // available to readers, present mode, and locked groups alike — not chrome.
  const [expanded, setExpanded] = useState(false);
  // Seed from the assetId so a block with one paints the loading placeholder on
  // the first frame — never a flash of the "add an artifact" empty state.
  const [resolving, setResolving] = useState(Boolean(assetId));
  const [notice, setNotice] = useState<{message: string; soft: boolean} | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const set = (key: string, value: unknown): void =>
    editor.doc.transact(() => setBlockProp(block, key, value), 'local');

  // ── Resolve assetId → the document text ────────────────────────────────────
  useEffect(() => {
    if (!assetId) {
      setHtml(null);
      return;
    }
    let cancelled = false;
    setHtml(null);
    setResolving(true);
    setBroken(false);
    void assetBridge
      .getAsset(assetId)
      .then((asset) => {
        if (cancelled) return;
        if (!asset) {
          setBroken(true); // missing / unreadable → broken state
          return;
        }
        // The store hands back bytes (as octet-stream); they are only ever
        // interpreted as HTML inside the sandboxed frame.
        setHtml(new TextDecoder('utf-8').decode(asset.bytes));
      })
      .catch(() => {
        if (!cancelled) setBroken(true);
      })
      .finally(() => {
        if (!cancelled) setResolving(false);
      });
    return () => {
      cancelled = true;
    };
  }, [assetId]);

  const pickFile = (): void => fileRef.current?.click();

  const ingestFile = async (file: File | null | undefined): Promise<void> => {
    if (!isHtmlFile(file)) {
      setNotice({message: t('blocks.artifact.notHtml'), soft: false});
      return;
    }
    const res = await htmlArtifactBlockFromFile(file, getPageIdForDoc(editor.doc) ?? undefined);
    if ('error' in res) {
      setNotice({message: res.error, soft: Boolean(res.soft)});
      return;
    }
    setNotice(null);
    setBroken(false);
    const props = res.block.props as unknown as HtmlArtifactBlockProps;
    editor.doc.transact(() => {
      setBlockProp(block, 'assetId', props.assetId);
      // Seed the title from the file name only when the author hasn't set one.
      if (props.title && !title) setBlockProp(block, 'title', props.title);
    }, 'local');
  };

  const onFileInput = (e: React.ChangeEvent<HTMLInputElement>): void => {
    void ingestFile(e.target.files?.[0]);
    e.target.value = ''; // allow re-picking the same file
  };

  // Drag the bottom handle to set the frame height (persisted to props).
  //
  // The drag crosses a CROSS-ORIGIN iframe, which breaks the plain
  // window-listener pattern the image block uses: pointer events entering the
  // nested browsing context are routed INTO the frame's document, so shrinking
  // freezes at the frame edge and a release over the frame leaks the listeners
  // (height then tracks the cursor with the button up — a stuck drag). Two
  // defences, both required:
  //  1. the iframe goes `pointer-events: none` for the drag's duration, so
  //     every move/up stays in the parent document (restored in `end`);
  //  2. `setPointerCapture` pins the remaining events to the HANDLE, with
  //     `lostpointercapture` as the guaranteed cleanup signal (fires after
  //     pointerup's implicit release AND on any capture loss, e.g. a cancelled
  //     touch) — nothing can leave a stuck drag behind.
  const onResizeDown = (e: React.PointerEvent): void => {
    if (!chrome) return;
    e.preventDefault();
    e.stopPropagation();
    const handle = e.currentTarget as HTMLElement;
    const frame = handle.closest('.obe-artifact-frame')?.querySelector('iframe');
    const startY = e.clientY;
    const startHeight = height;
    const move = (ev: PointerEvent): void => {
      const next = Math.max(
        MIN_ARTIFACT_HEIGHT,
        Math.min(MAX_ARTIFACT_HEIGHT, Math.round(startHeight + (ev.clientY - startY))),
      );
      set('height', next === DEFAULT_ARTIFACT_HEIGHT ? undefined : next);
    };
    const end = (): void => {
      if (frame) frame.style.pointerEvents = '';
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('lostpointercapture', end);
    };
    if (frame) frame.style.pointerEvents = 'none';
    try {
      handle.setPointerCapture(e.pointerId);
    } catch {
      // A synthetic event without a live pointer (tests) — the listeners below
      // still cover the plain in-parent drag path.
    }
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('lostpointercapture', end);
  };

  const noticeEl = notice && (
    <div className={notice.soft ? 'obe-image-notice' : 'obe-image-error'} role="alert">
      {notice.message}
    </div>
  );

  const fileInput = chrome && (
    <input
      ref={fileRef}
      type="file"
      accept=".html,.htm,text/html"
      className="obe-sr-only"
      aria-label={t('blocks.artifact.choose')}
      onChange={onFileInput}
    />
  );

  // The title bar: an inline-editable title plus the replace affordance. Chrome
  // only — a reader sees a static caption (or nothing when untitled).
  const titleBar = chrome ? (
    <div className="obe-artifact-bar" contentEditable={false}>
      <AppWindow className="obe-artifact-bar-icon" aria-hidden />
      <input
        className="obe-artifact-title"
        value={title}
        placeholder={t('blocks.artifact.titlePlaceholder')}
        aria-label={t('blocks.artifact.titleLabel')}
        spellCheck
        onChange={(e) => set('title', e.target.value || undefined)}
      />
      {assetId && (
        <button
          type="button"
          className="obe-artifact-tool"
          aria-label={t('blocks.artifact.replace')}
          title={t('blocks.artifact.replace')}
          onClick={pickFile}
        >
          <Upload className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  ) : (
    title && (
      <div className="obe-artifact-bar obe-artifact-bar-static" contentEditable={false}>
        <AppWindow className="obe-artifact-bar-icon" aria-hidden />
        <span className="obe-artifact-title-static">{title}</span>
      </div>
    )
  );

  // ── Loading state (resolving the assetId) ──────────────────────────────────
  // Fixed at the block's frame height so several artifacts loading in on a long
  // page never shift the layout when their frames arrive.
  if (resolving && assetId && html === null && !broken) {
    return (
      <figure className="obe-artifact" contentEditable={false} data-block-artifact={id}>
        {titleBar}
        <div
          className="obe-image-placeholder obe-image-placeholder-static obe-artifact-loading"
          style={{height}}
          aria-label={t('blocks.artifact.loading')}
          aria-busy
        >
          <Loader2 className="obe-image-placeholder-icon animate-spin" aria-hidden />
          <span>{t('blocks.artifact.loading')}</span>
        </div>
      </figure>
    );
  }

  // ── Placeholder / broken state ──────────────────────────────────────────────
  if (!assetId || broken) {
    if (!chrome) {
      return (
        <figure className="obe-artifact obe-artifact-empty" contentEditable={false} data-block-artifact={id}>
          {titleBar}
          <div className="obe-image-placeholder obe-image-placeholder-static" aria-label={t('blocks.artifact.unavailable')}>
            <FileWarning className="obe-image-placeholder-icon" aria-hidden />
            <span>{t('blocks.artifact.unavailable')}</span>
          </div>
        </figure>
      );
    }
    return (
      <figure className="obe-artifact obe-artifact-empty" contentEditable={false} data-block-artifact={id}>
        {titleBar}
        <button
          type="button"
          className="obe-image-placeholder"
          aria-label={broken ? t('blocks.artifact.broken') : t('blocks.artifact.add')}
          onClick={pickFile}
        >
          {broken ? <FileWarning className="obe-image-placeholder-icon" aria-hidden /> : <AppWindow className="obe-image-placeholder-icon" aria-hidden />}
          <span className="obe-image-placeholder-title">{broken ? t('blocks.artifact.broken') : t('blocks.artifact.add')}</span>
          <span className="obe-image-placeholder-hint">{broken ? t('blocks.artifact.brokenHint') : t('blocks.artifact.addHint')}</span>
        </button>
        {noticeEl}
        {fileInput}
      </figure>
    );
  }

  // ── Artifact state ──────────────────────────────────────────────────────────
  return (
    <figure className="obe-artifact" contentEditable={false} data-block-artifact={id}>
      {titleBar}
      <div className="obe-artifact-frame">
        <SandboxedHtml
          html={html ?? ''}
          height={height}
          title={title || t('blocks.artifact.fallbackTitle')}
          emptyLabel={t('blocks.artifact.empty')}
          errorLabel={t('blocks.artifact.error')}
        />
        {/* Run full-window: hover chrome, but a VIEWING affordance — offered
            to readers/present mode too (only obe-artifact-tool/resize are
            authoring chrome). Overlay state contract: see ArtifactOverlay. */}
        {html !== null && (
          <button
            type="button"
            className="obe-artifact-expand"
            aria-label={t('blocks.artifact.expand')}
            title={t('blocks.artifact.expand')}
            onClick={() => setExpanded(true)}
          >
            <Maximize2 className="h-3.5 w-3.5" aria-hidden />
          </button>
        )}
        {chrome && (
          <button
            type="button"
            className="obe-artifact-resize"
            aria-label={t('blocks.artifact.resize')}
            title={t('blocks.artifact.resize')}
            onPointerDown={onResizeDown}
          />
        )}
      </div>
      {expanded && html !== null && (
        <ArtifactOverlay
          html={html}
          title={title || t('blocks.artifact.fallbackTitle')}
          onClose={() => setExpanded(false)}
        />
      )}
      {noticeEl}
      {fileInput}
    </figure>
  );
};

export default HtmlArtifactBlockView;
