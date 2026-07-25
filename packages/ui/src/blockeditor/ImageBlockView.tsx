import React, {useEffect, useRef, useState} from 'react';
import {ImageOff, ImagePlus, Loader2, Maximize2, Upload} from 'lucide-react';
import {t} from '@/i18n';
import {openLightbox} from '@/lib/imageLightbox';
import {blockId, blockProp, setBlockProp, type BlockMap} from './model';
import {
  dataUrlMime,
  dataUrlToBytes,
  imageBlockFromFile,
  isDataUrl,
  isImageFile,
  type ImageBlockProps,
} from './imageBlock';
import {assetBridge} from '@/lib/assetBridge';
import {getPageIdForDoc} from '@/lib/aiBridge';
import type {BlockEditorController} from './useBlockEditor';
import type {EditorUI} from './BlockEditor';

/**
 * The native image block (Assets A2).
 *
 * The picture is stored as an **`assetId`** (a content-addressed asset store id);
 * this view resolves it to an **object URL** via the asset bridge for `<img src>`,
 * revoking the URL on unmount / change so nothing leaks. A block still holding a
 * legacy A0 `data:` URL in `src` renders it directly (back-compat) and — in an
 * editable context with an asset backend — is lazily migrated to an `assetId`
 * once (its bytes uploaded, the inline data-URL dropped from the CRDT). Renders
 * an editable **alt** + **caption**, **resize** handle + preset sizes, and
 * loading / placeholder / broken states. All edit affordances are gated on
 * `editor.readOnly`, so a viewer / present-mode / locked-group reader sees a
 * clean figure with no chrome.
 */

const SIZE_PRESETS: Array<{label: string; title: string; width: string | undefined}> = [
  {label: 'S', title: 'Small', width: '30%'},
  {label: 'M', title: 'Medium', width: '60%'},
  {label: 'L', title: 'Full width', width: undefined},
];

export const ImageBlockView: React.FC<{block: BlockMap; editor: BlockEditorController; ui: EditorUI}> = ({
  block,
  editor,
}) => {
  const id = blockId(block);
  const assetId = blockProp<string>(block, 'assetId');
  const rawSrc = blockProp<string>(block, 'src') ?? '';
  // A legacy inline `data:` URL (A0) vs any other stored `src` (a plain URL).
  const legacyDataUrl = isDataUrl(rawSrc) ? rawSrc : '';
  const directSrc = !isDataUrl(rawSrc) && rawSrc ? rawSrc : '';
  const alt = blockProp<string>(block, 'alt') ?? '';
  const caption = blockProp<string>(block, 'caption') ?? '';
  const width = blockProp<string>(block, 'width');
  const readOnly = editor.readOnly;
  const [broken, setBroken] = useState(false);
  // The resolved object URL for an assetId, and whether we're still fetching it.
  // `resolving` seeds from whether we have an assetId so a block with one paints
  // the loading state on the FIRST frame — never a flash of the empty "add image"
  // placeholder before the resolve effect runs.
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [resolving, setResolving] = useState(Boolean(assetId));
  // A failed/limited ingest: `soft` (a size cap) reads as a muted info note, a
  // hard error as destructive red — both are announced (role="alert").
  const [notice, setNotice] = useState<{message: string; soft: boolean} | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);

  const set = (key: string, value: unknown): void =>
    editor.doc.transact(() => setBlockProp(block, key, value), 'local');

  // ── Resolve an assetId → an object URL for <img src> ───────────────────────
  // Fetch the bytes via the asset bridge, wrap them in a Blob, create an object
  // URL; revoke it on unmount / when the assetId changes so nothing leaks.
  useEffect(() => {
    if (!assetId) {
      setObjectUrl(null);
      return;
    }
    let cancelled = false;
    let created: string | null = null;
    setObjectUrl(null); // show the loading state while (re)resolving
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
        created = URL.createObjectURL(new Blob([asset.bytes as BlobPart], {type: asset.mime}));
        setObjectUrl(created);
      })
      .catch(() => {
        if (!cancelled) setBroken(true);
      })
      .finally(() => {
        if (!cancelled) setResolving(false);
      });
    return () => {
      cancelled = true;
      if (created) URL.revokeObjectURL(created);
    };
  }, [assetId]);

  // ── Lazy migration: legacy `data:` URL → assetId (Assets A2) ────────────────
  // Once, in an editable context with an asset backend, upload the inline bytes
  // then rewrite the block to an assetId and drop the data-URL from the CRDT.
  // Guarded so it uploads at most once; a transient failure clears the guard for
  // a later retry. A viewer never migrates (can't write) — the data-URL renders
  // directly. Content-addressed dedup makes a re-upload idempotent regardless.
  const migratedRef = useRef(false);
  useEffect(() => {
    if (readOnly || assetId || !legacyDataUrl || migratedRef.current) return;
    if (!assetBridge.ready()) return;
    const pageId = getPageIdForDoc(editor.doc);
    if (!pageId) return;
    const bytes = dataUrlToBytes(legacyDataUrl);
    if (!bytes) return;
    migratedRef.current = true;
    let cancelled = false;
    void (async () => {
      try {
        const {id: newId} = await assetBridge.putAsset(bytes, dataUrlMime(legacyDataUrl), pageId);
        if (cancelled) return;
        editor.doc.transact(() => {
          setBlockProp(block, 'assetId', newId);
          setBlockProp(block, 'src', undefined); // drop the inline base64 from the CRDT
        }, 'local');
      } catch {
        migratedRef.current = false; // allow a retry on the next render / remount
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [assetId, legacyDataUrl, readOnly, editor, block]);

  const pickFile = (): void => fileRef.current?.click();

  const ingestFile = async (file: File | null | undefined): Promise<void> => {
    if (!isImageFile(file)) {
      setNotice({message: 'That file isn’t an image.', soft: false});
      return;
    }
    const res = await imageBlockFromFile(file, getPageIdForDoc(editor.doc) ?? undefined);
    if ('error' in res) {
      setNotice({message: res.error, soft: Boolean(res.soft)});
      return;
    }
    setNotice(null);
    setBroken(false);
    const props = res.block.props as unknown as ImageBlockProps;
    editor.doc.transact(() => {
      // Set the produced form and clear the other, so replacing an image never
      // leaves a stale assetId + src on the same block.
      if (props.assetId) {
        setBlockProp(block, 'assetId', props.assetId);
        setBlockProp(block, 'src', undefined);
      } else if (props.src) {
        setBlockProp(block, 'src', props.src);
        setBlockProp(block, 'assetId', undefined);
      }
      // Seed alt from the file name only when the author hasn't written one.
      if (props.alt && !alt) setBlockProp(block, 'alt', props.alt);
    }, 'local');
  };

  const onFileInput = (e: React.ChangeEvent<HTMLInputElement>): void => {
    void ingestFile(e.target.files?.[0]);
    e.target.value = ''; // allow re-picking the same file
  };

  // Drag the right edge to set a percentage width against the content column.
  const onResizeDown = (e: React.PointerEvent): void => {
    if (readOnly) return;
    e.preventDefault();
    e.stopPropagation();
    const frame = frameRef.current;
    // The frame's parent is the <figure> (.obe-image); it stretches to the
    // content column, so its width is the 100% the percentage is measured against.
    const container = frame?.parentElement;
    if (!frame || !container) return;
    const containerWidth = container.getBoundingClientRect().width;
    if (containerWidth <= 0) return;
    const move = (ev: PointerEvent): void => {
      const left = frame.getBoundingClientRect().left;
      const px = Math.max(40, ev.clientX - left);
      const pct = Math.max(15, Math.min(100, Math.round((px / containerWidth) * 100)));
      set('width', `${pct}%`);
    };
    const up = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // The picture URL for <img>: the resolved object URL (assetId path) or a legacy
  // inline data-URL / direct URL (rendered directly for back-compat).
  const displaySrc = assetId ? objectUrl : legacyDataUrl || directSrc;
  const hasImage = Boolean(displaySrc) && !broken;
  // An assetId still resolving (bytes not yet fetched) — a loading state distinct
  // from the empty/broken placeholder.
  const loading = Boolean(assetId) && resolving && !objectUrl && !broken;

  // Open the full-viewport lightbox (LBX-1) on whatever the block is currently
  // showing. `trigger` is the element that opened it, so focus returns there on
  // close. Guarded on a resolved src so a still-loading / broken block is inert.
  const openView = (trigger: HTMLElement | null): void => {
    if (!displaySrc) return;
    openLightbox({src: displaySrc, alt, trigger});
  };

  // The size cap is a soft, temporary limit → muted info tone; a bad file is a
  // hard error → destructive tone. Both announce via role="alert".
  const noticeEl = notice && (
    <div className={notice.soft ? 'obe-image-notice' : 'obe-image-error'} role="alert">
      {notice.message}
    </div>
  );

  // ── Loading state (resolving an assetId) ───────────────────────────────────
  if (loading) {
    return (
      <figure className="obe-image obe-image-empty" contentEditable={false} data-block-image={id}>
        <div className="obe-image-placeholder obe-image-placeholder-static" aria-label={alt || 'Loading image'} aria-busy>
          <Loader2 className="obe-image-placeholder-icon animate-spin" aria-hidden />
          <span>Loading image…</span>
        </div>
        {caption && <figcaption className="obe-image-caption">{caption}</figcaption>}
      </figure>
    );
  }

  // ── Placeholder / broken state ─────────────────────────────────────────────
  if (!hasImage) {
    // A viewer never sees an upload affordance — just a quiet marker.
    if (readOnly) {
      return (
        <figure className="obe-image obe-image-empty" contentEditable={false} data-block-image={id}>
          <div className="obe-image-placeholder obe-image-placeholder-static" aria-label={alt || 'Image'}>
            <ImageOff className="obe-image-placeholder-icon" aria-hidden />
            <span>{broken ? 'Image unavailable' : 'Image'}</span>
          </div>
          {caption && <figcaption className="obe-image-caption">{caption}</figcaption>}
        </figure>
      );
    }
    return (
      <figure className="obe-image obe-image-empty" contentEditable={false} data-block-image={id}>
        <button
          type="button"
          className="obe-image-placeholder"
          aria-label={broken ? 'Image failed to load — choose another' : 'Upload an image'}
          onClick={pickFile}
        >
          {broken ? <ImageOff className="obe-image-placeholder-icon" aria-hidden /> : <ImagePlus className="obe-image-placeholder-icon" aria-hidden />}
          <span className="obe-image-placeholder-title">{broken ? 'Image failed to load' : 'Add an image'}</span>
          <span className="obe-image-placeholder-hint">Click to upload, or paste / drop an image</span>
        </button>
        {noticeEl}
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="obe-sr-only"
          aria-label="Choose an image file"
          onChange={onFileInput}
        />
        {caption && <figcaption className="obe-image-caption">{caption}</figcaption>}
      </figure>
    );
  }

  // ── Image state ────────────────────────────────────────────────────────────
  return (
    <figure className="obe-image" contentEditable={false} data-block-image={id}>
      <div ref={frameRef} className="obe-image-frame" style={width ? {width} : undefined}>
        <img
          className={`obe-image-img${readOnly ? ' obe-image-img-zoom' : ''}`}
          src={displaySrc ?? ''}
          alt={alt}
          draggable={false}
          onError={() => setBroken(true)}
          onLoad={() => setBroken(false)}
          // Read-only / present mode: a plain click (or Enter/Space, since the
          // image is a focusable button here) opens the lightbox. In edit mode
          // the image stays inert so selection + drag-resize are unaffected —
          // there the Expand button in the hover toolbar is the trigger.
          {...(readOnly
            ? {
              role: 'button',
              tabIndex: 0,
              // Fold the alt text into the accessible name when the author wrote
              // one, so the trigger announces *which* picture it opens.
              'aria-label': alt ? t('blocks.image.viewAlt', {alt}) : t('blocks.image.view'),
              onClick: (e: React.MouseEvent<HTMLImageElement>) => openView(e.currentTarget),
              onKeyDown: (e: React.KeyboardEvent<HTMLImageElement>) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  openView(e.currentTarget);
                }
              },
            }
            : {})}
        />
        {!readOnly && (
          <>
            <div className="obe-image-tools" contentEditable={false}>
              <div className="obe-image-sizes" role="group" aria-label="Image size">
                {SIZE_PRESETS.map((p) => {
                  const active = (p.width ?? undefined) === (width ?? undefined);
                  return (
                    <button
                      key={p.label}
                      type="button"
                      className={`obe-image-size${active ? ' obe-image-size-on' : ''}`}
                      aria-pressed={active}
                      aria-label={p.title}
                      title={p.title}
                      onClick={() => set('width', p.width)}
                    >
                      {p.label}
                    </button>
                  );
                })}
              </div>
              <button
                type="button"
                className="obe-image-tool"
                aria-label={t('blocks.image.expand')}
                title={t('blocks.image.expand')}
                onClick={(e) => openView(e.currentTarget)}
              >
                <Maximize2 className="h-3.5 w-3.5" />
              </button>
              <button type="button" className="obe-image-tool" aria-label={t('blocks.image.replace')} title={t('blocks.image.replace')} onClick={pickFile}>
                <Upload className="h-3.5 w-3.5" />
              </button>
            </div>
            <button
              type="button"
              className="obe-image-resize"
              aria-label="Resize image"
              title="Drag to resize"
              onPointerDown={onResizeDown}
            />
          </>
        )}
      </div>
      {!readOnly && (
        <input
          className="obe-image-alt"
          value={alt}
          placeholder="Alt text (describe the image for accessibility)"
          aria-label="Alt text"
          spellCheck
          onChange={(e) => set('alt', e.target.value || undefined)}
        />
      )}
      {readOnly ? (
        caption && <figcaption className="obe-image-caption">{caption}</figcaption>
      ) : (
        <input
          className="obe-image-caption obe-image-caption-input"
          value={caption}
          placeholder="Add a caption…"
          aria-label="Image caption"
          spellCheck
          onChange={(e) => set('caption', e.target.value || undefined)}
        />
      )}
      {!readOnly && (
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="obe-sr-only"
          aria-label="Choose an image file"
          onChange={onFileInput}
        />
      )}
      {noticeEl}
    </figure>
  );
};

export default ImageBlockView;
