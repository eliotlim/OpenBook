import React, {useRef, useState} from 'react';
import {ImageOff, ImagePlus, Upload} from 'lucide-react';
import {blockId, blockProp, setBlockProp, type BlockMap} from './model';
import {imageBlockFromFile, isImageFile, type ImageBlockProps} from './imageBlock';
import type {BlockEditorController} from './useBlockEditor';
import type {EditorUI} from './BlockEditor';

/**
 * The native image block (Assets A0, data-URL phase-1).
 *
 * Renders the picture with an editable **alt** (accessibility) and **caption**,
 * a **resize** handle plus preset sizes (persisted to props), and a
 * placeholder / broken-image state. All edit affordances are gated on
 * `editor.readOnly`, so a viewer / present-mode / locked-group reader sees a
 * clean figure with no chrome. The picture lives in the `src` prop as a `data:`
 * URL for now; Assets A2 swaps that for an `assetId` — this view only ever reads
 * `src`, so that migration stays local.
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
  const src = blockProp<string>(block, 'src') ?? '';
  const alt = blockProp<string>(block, 'alt') ?? '';
  const caption = blockProp<string>(block, 'caption') ?? '';
  const width = blockProp<string>(block, 'width');
  const readOnly = editor.readOnly;
  const [broken, setBroken] = useState(false);
  // A failed/limited ingest: `soft` (the size cap) reads as a muted info note,
  // a hard error as destructive red — both are announced (role="alert").
  const [notice, setNotice] = useState<{message: string; soft: boolean} | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);

  const set = (key: string, value: unknown): void =>
    editor.doc.transact(() => setBlockProp(block, key, value), 'local');

  const pickFile = (): void => fileRef.current?.click();

  const ingestFile = async (file: File | null | undefined): Promise<void> => {
    if (!isImageFile(file)) {
      setNotice({message: 'That file isn’t an image.', soft: false});
      return;
    }
    const res = await imageBlockFromFile(file);
    if ('error' in res) {
      setNotice({message: res.error, soft: Boolean(res.soft)});
      return;
    }
    setNotice(null);
    setBroken(false);
    const props = res.block.props as unknown as ImageBlockProps;
    editor.doc.transact(() => {
      setBlockProp(block, 'src', props.src);
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

  const hasImage = Boolean(src) && !broken;

  // The size cap is a soft, temporary phase-1 limit → muted info tone; a bad
  // file is a hard error → destructive tone. Both announce via role="alert".
  const noticeEl = notice && (
    <div className={notice.soft ? 'obe-image-notice' : 'obe-image-error'} role="alert">
      {notice.message}
    </div>
  );

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
          className="obe-image-img"
          src={src}
          alt={alt}
          draggable={false}
          onError={() => setBroken(true)}
          onLoad={() => setBroken(false)}
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
              <button type="button" className="obe-image-tool" aria-label="Replace image" title="Replace image" onClick={pickFile}>
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
