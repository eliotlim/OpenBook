import React, {useRef} from 'react';
import {Select} from '@/components/ui/select';
import {ImagePlus, Plus, X} from 'lucide-react';
import {blockProp, setBlockProp, type BlockMap} from '../model';
import type {BlockEditorController} from '../useBlockEditor';
import {COLOR_TOKENS} from '../colors';
import {ConfigField, ConfigInput} from './KitFrame';
import {rawOptions, slugify} from './options';

/**
 * A WYSIWYG editor for choice options: one row per option with a **display
 * label** and the **value** it serialises to (placeholder shows the auto-slug,
 * so the simple case needs no value at all). Writes the structured `opts`
 * array and drops the legacy comma-separated `options` string so the two
 * representations never disagree.
 *
 * With `media`, each row also carries a per-option **image** (pasted URL or an
 * uploaded file, downscaled to an inline data URL — the same mechanism page
 * covers / avatars use), an **icon/emoji**, and a **colour** token shown when
 * there's no image. Choice cards use this; the plain radio/checklist/dropdown
 * don't pass `media`, so they stay a two-column editor.
 */

interface Row {
  label: string;
  value: string;
  image?: string;
  icon?: string;
  color?: string;
}

const readRows = (block: BlockMap): Row[] =>
  rawOptions({opts: blockProp<unknown>(block, 'opts'), options: blockProp<unknown>(block, 'options')}).map((o) => ({
    label: o.label,
    value: o.value ?? '',
    image: o.image,
    icon: o.icon,
    color: o.color,
  }));

/** Downscale an upload to a small inline data URL (fits the snapshot, no
 *  server round-trip). Mirrors the profile-avatar / page-cover approach. */
async function fileToImageDataUrl(file: File, max = 320): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  return canvas.toDataURL('image/webp', 0.82);
}

/** Strip empties so a row only stores the fields it actually uses. */
const cleanRow = (r: Row): Row => ({
  label: r.label,
  ...(r.value.trim() ? {value: r.value.trim()} : {}),
  ...(r.image ? {image: r.image} : {}),
  ...(r.icon ? {icon: r.icon} : {}),
  ...(r.color ? {color: r.color} : {}),
}) as Row;

export const OptionsEditor: React.FC<{block: BlockMap; editor: BlockEditorController; media?: boolean}> = ({block, editor, media}) => {
  const rows = readRows(block);

  const commit = (next: Row[]): void =>
    editor.doc.transact(() => {
      // Keep only the fields we store; an empty `value` means "use the slug".
      setBlockProp(block, 'opts', next.map(cleanRow));
      setBlockProp(block, 'options', undefined); // migrate off the legacy string
    }, 'local');

  const update = (i: number, patch: Partial<Row>): void => commit(rows.map((r, j) => (j === i ? {...r, ...patch} : r)));
  const remove = (i: number): void => commit(rows.filter((_, j) => j !== i));
  const add = (): void => commit([...rows, {label: '', value: ''}]);

  return (
    <ConfigField label="Options" hint="Label readers see, and the value it serialises to.">
      <div className="flex flex-col gap-1.5">
        {rows.map((row, i) => (
          <div key={i} className="flex flex-col gap-1">
            <div className="flex items-center gap-1.5">
              <ConfigInput
                value={row.label}
                readOnly={editor.readOnly}
                aria-label={`Option ${i + 1} label`}
                placeholder="Label"
                onChange={(e) => update(i, {label: e.target.value})}
              />
              <span className="text-muted-foreground/60" aria-hidden>
                →
              </span>
              <ConfigInput
                mono
                value={row.value}
                readOnly={editor.readOnly}
                aria-label={`Option ${i + 1} value`}
                placeholder={slugify(row.label) || 'value'}
                onChange={(e) => update(i, {value: e.target.value})}
              />
              {!editor.readOnly && (
                <button
                  type="button"
                  className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-hover hover:text-foreground"
                  aria-label={`Remove option ${i + 1}`}
                  onClick={() => remove(i)}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            {media && <MediaRow index={i} row={row} editor={editor} onChange={(patch) => update(i, patch)} />}
          </div>
        ))}
        {!editor.readOnly && (
          <button
            type="button"
            className="mt-0.5 inline-flex w-fit items-center gap-1 rounded-md px-1.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-hover hover:text-foreground"
            onClick={add}
          >
            <Plus className="h-3.5 w-3.5" /> Add option
          </button>
        )}
      </div>
    </ConfigField>
  );
};

/** Per-option media fields: image URL + upload, icon/emoji, and a colour. */
const MediaRow: React.FC<{
  index: number;
  row: Row;
  editor: BlockEditorController;
  onChange: (patch: Partial<Row>) => void;
}> = ({index, row, editor, onChange}) => {
  const fileRef = useRef<HTMLInputElement>(null);
  return (
    <div className="flex flex-wrap items-center gap-1.5 pl-1">
      <ConfigInput
        className="flex-1"
        value={row.image && !row.image.startsWith('data:') ? row.image : ''}
        readOnly={editor.readOnly}
        aria-label={`Option ${index + 1} image URL`}
        placeholder={row.image?.startsWith('data:') ? 'uploaded image' : 'Image URL…'}
        spellCheck={false}
        onChange={(e) => onChange({image: e.target.value.trim() || undefined})}
      />
      {!editor.readOnly && (
        <>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            aria-label={`Upload option ${index + 1} image`}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void fileToImageDataUrl(file).then((url) => onChange({image: url})).catch(() => undefined);
              e.target.value = '';
            }}
          />
          <button
            type="button"
            className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-hover hover:text-foreground"
            aria-label={`Upload option ${index + 1} image`}
            title="Upload image"
            onClick={() => fileRef.current?.click()}
          >
            <ImagePlus className="h-3.5 w-3.5" />
          </button>
        </>
      )}
      <ConfigInput
        className="w-12 text-center"
        value={row.icon ?? ''}
        readOnly={editor.readOnly}
        aria-label={`Option ${index + 1} icon`}
        placeholder="🙂"
        onChange={(e) => onChange({icon: e.target.value.trim() || undefined})}
      />
      <Select unstyled
        className="rounded-md border border-border bg-card px-1.5 py-1 text-sm"
        value={row.color ?? ''}
        disabled={editor.readOnly}
        aria-label={`Option ${index + 1} colour`}
        onChange={(e) => onChange({color: e.target.value || undefined})}
      >
        <option value="">no colour</option>
        {COLOR_TOKENS.map((c) => (
          <option key={c.id} value={c.id}>
            {c.label}
          </option>
        ))}
      </Select>
    </div>
  );
};
