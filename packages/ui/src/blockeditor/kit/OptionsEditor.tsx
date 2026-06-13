import React from 'react';
import {Plus, X} from 'lucide-react';
import {blockProp, setBlockProp, type BlockMap} from '../model';
import type {BlockEditorController} from '../useBlockEditor';
import {ConfigField, ConfigInput} from './KitFrame';
import {rawOptions, slugify} from './options';

/**
 * A WYSIWYG editor for choice options: one row per option with a **display
 * label** and the **value** it serialises to (placeholder shows the auto-slug,
 * so the simple case needs no value at all). Writes the structured `opts`
 * array and drops the legacy comma-separated `options` string so the two
 * representations never disagree.
 */

interface Row {
  label: string;
  value: string;
}

const readRows = (block: BlockMap): Row[] =>
  rawOptions({opts: blockProp<unknown>(block, 'opts'), options: blockProp<unknown>(block, 'options')}).map((o) => ({
    label: o.label,
    value: o.value ?? '',
  }));

export const OptionsEditor: React.FC<{block: BlockMap; editor: BlockEditorController}> = ({block, editor}) => {
  const rows = readRows(block);

  const commit = (next: Row[]): void =>
    editor.doc.transact(() => {
      // Keep only the fields we store; an empty `value` means "use the slug".
      setBlockProp(block, 'opts', next.map((r) => (r.value.trim() ? {label: r.label, value: r.value.trim()} : {label: r.label})));
      setBlockProp(block, 'options', undefined); // migrate off the legacy string
    }, 'local');

  const update = (i: number, patch: Partial<Row>): void => commit(rows.map((r, j) => (j === i ? {...r, ...patch} : r)));
  const remove = (i: number): void => commit(rows.filter((_, j) => j !== i));
  const add = (): void => commit([...rows, {label: '', value: ''}]);

  return (
    <ConfigField label="Options" hint="Label readers see, and the value it serialises to.">
      <div className="flex flex-col gap-1.5">
        {rows.map((row, i) => (
          <div key={i} className="flex items-center gap-1.5">
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
                className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                aria-label={`Remove option ${i + 1}`}
                onClick={() => remove(i)}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        ))}
        {!editor.readOnly && (
          <button
            type="button"
            className="mt-0.5 inline-flex w-fit items-center gap-1 rounded-md px-1.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            onClick={add}
          >
            <Plus className="h-3.5 w-3.5" /> Add option
          </button>
        )}
      </div>
    </ConfigField>
  );
};
