import React, {useMemo, useRef, useState} from 'react';
import {Check, Plus, X} from 'lucide-react';
import {Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList} from '@/components/ui/command';
import {Popover, PopoverContent, PopoverTrigger} from '@/components/ui/popover';
import {blockProp, type BlockMap, type TextRun} from '../model';
import {domToRuns, runsToHtml} from '../RichTextEditor';
import {isColorToken} from '../colors';
import type {CustomBlockProps} from '../registry';
import {computeScope, evalExpr} from './scope';
import {ConfigField, ConfigInput, ConfigToggle, KitFrame, kitSet} from './KitFrame';
import {labelOf, resolveOptions, type KitOption} from './options';
import {OptionsEditor} from './OptionsEditor';

/**
 * The June-2026 reactive inputs — full citizens of `inputScope` (wired in
 * kit/scope.ts): choice cards (image-cover radio/multi), long text (plain) and
 * rich text (markup + plain projection), a searchable single/multi select, and
 * a tag field. Each wears the shared {@link KitFrame} chrome (display name,
 * description, the quiet ⚙, var-name override, group namespacing) so they
 * behave exactly like the original inputs in charts/formulas/exports.
 */

// ── Choice cards ─────────────────────────────────────────────────────────────
// Radio cards with an image cover, multi-select capable. Single publishes a
// scalar, multi publishes string[] (mirrors radio vs checklist).

const ChoiceCardsBlock: React.FC<CustomBlockProps> = ({block, editor}) => {
  const name = blockProp<string>(block, 'name') ?? 'choice';
  const multi = Boolean(blockProp<boolean>(block, 'multi'));
  const options = resolveOptions(block);
  const value = blockProp<string>(block, 'value') ?? null;
  const selectedRaw = blockProp<string[]>(block, 'selected');
  const selected = new Set(Array.isArray(selectedRaw) ? selectedRaw : []);

  const pick = (val: string): void => {
    if (multi) {
      const next = new Set(selected);
      if (next.has(val)) next.delete(val);
      else next.add(val);
      kitSet(editor, block, 'selected', options.filter((o) => next.has(o.value)).map((o) => o.value));
    } else {
      kitSet(editor, block, 'value', value === val ? null : val);
    }
  };

  const isOn = (val: string): boolean => (multi ? selected.has(val) : value === val);

  const control = (
    <div className="obe-kit-cardgrid" role={multi ? 'group' : 'radiogroup'} aria-label={name}>
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          role={multi ? 'checkbox' : 'radio'}
          aria-checked={isOn(opt.value)}
          className={`obe-kit-card${isOn(opt.value) ? ' obe-kit-card-on' : ''}`}
          disabled={editor.readOnly}
          onClick={() => pick(opt.value)}
        >
          <CardCover opt={opt} />
          <span className="obe-kit-card-label">{opt.label}</span>
          {isOn(opt.value) && (
            <span className="obe-kit-card-tick" aria-hidden>
              <Check className="h-3 w-3" />
            </span>
          )}
        </button>
      ))}
      {options.length === 0 && <span className="obe-kit-empty">add options ⚙</span>}
    </div>
  );

  const config = (
    <>
      <ConfigToggle
        label="Multiple selection"
        hint="Readers can pick more than one card."
        checked={multi}
        disabled={editor.readOnly}
        onChange={(next) => kitSet(editor, block, 'multi', next || undefined)}
      />
      <OptionsEditor block={block} editor={editor} media />
    </>
  );

  return <KitFrame block={block} editor={editor} kind="cards" defaultName="choice" supportsWide control={control} config={config} />;
};

/** A card's cover: the option image, else its icon/emoji, else a colour block,
 *  else a quiet placeholder. */
const CardCover: React.FC<{opt: KitOption}> = ({opt}) => {
  if (opt.image) return <span className="obe-kit-card-cover" style={{backgroundImage: `url("${opt.image}")`}} aria-hidden />;
  if (opt.icon) return <span className="obe-kit-card-cover obe-kit-card-icon" aria-hidden>{opt.icon}</span>;
  if (isColorToken(opt.color)) return <span className={`obe-kit-card-cover obe-bg-${opt.color}`} aria-hidden />;
  return <span className="obe-kit-card-cover obe-kit-card-cover-empty" aria-hidden />;
};

// ── Long text (plain auto-growing textarea) ──────────────────────────────────

const LongTextBlock: React.FC<CustomBlockProps> = ({block, editor}) => {
  const name = blockProp<string>(block, 'name') ?? 'text';
  const value = blockProp<string>(block, 'value') ?? '';

  const control = (
    <textarea
      className="obe-kit-longtext"
      value={value}
      placeholder={blockProp<string>(block, 'placeholder') ?? 'Type here…'}
      aria-label={`${name} value`}
      readOnly={editor.readOnly}
      rows={Math.max(3, value.split('\n').length)}
      onChange={(e) => kitSet(editor, block, 'value', e.target.value)}
      onKeyDown={(e) => e.stopPropagation()}
    />
  );

  const config = (
    <ConfigField label="Placeholder">
      <ConfigInput
        value={blockProp<string>(block, 'placeholder') ?? ''}
        readOnly={editor.readOnly}
        aria-label="Placeholder"
        onChange={(e) => kitSet(editor, block, 'placeholder', e.target.value)}
      />
    </ConfigField>
  );

  return <KitFrame block={block} editor={editor} kind="longtext" defaultName="text" control={control} config={config} />;
};

// ── Rich text (inline formatting; publishes plain projection + markup) ───────
// Self-contained (no app providers): a contentEditable surface whose markup is
// stored as TextRun[] in `runs`. We read the DOM on input and project it back
// to runs via the editor's own htmlToRuns. Bold/italic/underline use
// execCommand, which is enough for an inline-formatting field without pulling
// in the full block-editor text pipeline.

const FORMATS: Array<{cmd: string; label: string; mark: string}> = [
  {cmd: 'bold', label: 'B', mark: 'b'},
  {cmd: 'italic', label: 'I', mark: 'i'},
  {cmd: 'underline', label: 'U', mark: 'u'},
];

const RichTextBlock: React.FC<CustomBlockProps> = ({block, editor}) => {
  const name = blockProp<string>(block, 'name') ?? 'text';
  const runs = blockProp<TextRun[]>(block, 'runs');
  const ref = useRef<HTMLDivElement>(null);
  // Render the stored runs ONCE per identity change; thereafter the DOM is the
  // source of truth while editing (re-rendering on every keystroke would fight
  // the caret). `key` resets it when the block identity (doc version) changes.
  const initialHtml = useMemo(() => runsToHtml(Array.isArray(runs) ? runs : []), [block, editor]);

  const sync = (): void => {
    const el = ref.current;
    if (!el) return;
    kitSet(editor, block, 'runs', domToRuns(el));
  };

  const control = (
    <div className="obe-kit-richtext">
      {!editor.readOnly && (
        <div className="obe-kit-richtext-bar" contentEditable={false}>
          {FORMATS.map((f) => (
            <button
              key={f.cmd}
              type="button"
              className={`obe-kit-richtext-btn obe-kit-richtext-${f.mark}`}
              aria-label={f.cmd}
              title={f.cmd}
              onMouseDown={(e) => {
                e.preventDefault(); // keep the selection in the editable surface
                document.execCommand(f.cmd);
                sync();
              }}
            >
              {f.label}
            </button>
          ))}
        </div>
      )}
      <div
        ref={ref}
        className="obe-kit-richtext-body"
        contentEditable={!editor.readOnly}
        suppressContentEditableWarning
        role="textbox"
        aria-multiline
        aria-label={`${name} value`}
        data-placeholder={blockProp<string>(block, 'placeholder') ?? 'Type here…'}
        dangerouslySetInnerHTML={{__html: initialHtml}}
        onInput={sync}
        onBlur={sync}
        onKeyDown={(e) => e.stopPropagation()}
      />
    </div>
  );

  const config = (
    <ConfigField label="Placeholder">
      <ConfigInput
        value={blockProp<string>(block, 'placeholder') ?? ''}
        readOnly={editor.readOnly}
        aria-label="Placeholder"
        onChange={(e) => kitSet(editor, block, 'placeholder', e.target.value)}
      />
    </ConfigField>
  );

  return <KitFrame block={block} editor={editor} kind="richtext" defaultName="text" control={control} config={config} />;
};

// (runsToHtml / domToRuns now live in ../RichTextEditor and are shared with the
//  comment composer.)

// ── Searchable select / multi-select ─────────────────────────────────────────
// Search box over options (static OR dynamic), single or multi. Built on the
// Radix Command surface. Multi publishes string[]; single publishes a scalar.

/** Options for a search/tag block: the static `opts` list, OR — when a
 *  `dynamic` expression is set — a comma-expression evaluated over the page's
 *  input scope (a string list, an array, or another input's value). */
function dynamicOptions(block: BlockMap, editor: CustomBlockProps['editor']): KitOption[] {
  const source = (blockProp<string>(block, 'dynamic') ?? '').trim();
  if (!source) return resolveOptions(block);
  const {value} = evalExpr(source, computeScope(editor.doc).scope);
  const list = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',').map((s) => s.trim()).filter(Boolean)
      : [];
  return list.map((v) => ({label: String(v), value: String(v)}));
}

const SearchSelectBlock: React.FC<CustomBlockProps> = ({block, editor}) => {
  const name = blockProp<string>(block, 'name') ?? 'pick';
  const multi = Boolean(blockProp<boolean>(block, 'multi'));
  const options = dynamicOptions(block, editor);
  const value = blockProp<string>(block, 'value') ?? '';
  const selectedRaw = blockProp<string[]>(block, 'selected');
  const selected = multi ? (Array.isArray(selectedRaw) ? selectedRaw : []) : value ? [value] : [];

  const summary = multi
    ? selected.length === 0
      ? 'Select…'
      : selected.map((v) => labelOf(options, v)).join(', ')
    : value
      ? labelOf(options, value)
      : 'Select…';

  const config = (
    <>
      <ConfigToggle
        label="Multiple selection"
        hint="Publish an array; readers can pick several."
        checked={multi}
        disabled={editor.readOnly}
        onChange={(next) => kitSet(editor, block, 'multi', next || undefined)}
      />
      <ConfigField label="Dynamic options" hint="Optional — an expression over inputs (a list, an array, or a comma string). Overrides the static list.">
        <ConfigInput
          mono
          value={blockProp<string>(block, 'dynamic') ?? ''}
          readOnly={editor.readOnly}
          spellCheck={false}
          aria-label="Dynamic options expression"
          placeholder="tags  ·  regions.split(',')"
          onChange={(e) => kitSet(editor, block, 'dynamic', e.target.value)}
        />
      </ConfigField>
      {!(blockProp<string>(block, 'dynamic') ?? '').trim() && <OptionsEditor block={block} editor={editor} />}
    </>
  );

  const control = (
    <SearchPicker
      ariaLabel={name}
      summary={summary}
      options={options}
      selected={new Set(selected)}
      multi={multi}
      disabled={editor.readOnly}
      onToggle={(val) => toggleSelection(editor, block, multi, selected, val)}
    />
  );

  return <KitFrame block={block} editor={editor} kind="searchselect" defaultName="pick" supportsWide control={control} config={config} />;
};

// ── Tag field ─────────────────────────────────────────────────────────────────
// Free entry + suggestions; a setting toggles whether free entry is allowed.
// When free entry is off it degrades to a searchable multi-select over a fixed
// list (shares SearchPicker with the search-select). Always publishes string[].

const TagFieldBlock: React.FC<CustomBlockProps> = ({block, editor}) => {
  const name = blockProp<string>(block, 'name') ?? 'tags';
  const freeEntry = blockProp<boolean>(block, 'freeEntry') !== false; // default ON
  const options = dynamicOptions(block, editor);
  const selectedRaw = blockProp<string[]>(block, 'selected');
  const selected = Array.isArray(selectedRaw) ? selectedRaw : [];
  const [draft, setDraft] = useState('');

  const setSelected = (next: string[]): void => kitSet(editor, block, 'selected', next);
  const add = (raw: string): void => {
    const tag = raw.trim();
    if (tag && !selected.includes(tag)) setSelected([...selected, tag]);
    setDraft('');
  };
  const remove = (tag: string): void => setSelected(selected.filter((t) => t !== tag));

  // Suggestions: option labels not already chosen, filtered by the draft.
  const suggestions = options
    .filter((o) => !selected.includes(o.value) && (!draft || o.label.toLowerCase().includes(draft.toLowerCase())))
    .slice(0, 6);

  const config = (
    <>
      <ConfigToggle
        label="Allow free entry"
        hint="Off → a searchable multi-select over the fixed list below."
        checked={freeEntry}
        disabled={editor.readOnly}
        onChange={(next) => kitSet(editor, block, 'freeEntry', next)}
      />
      <ConfigField label="Suggestions" hint={freeEntry ? 'Offered as you type; readers can also enter their own.' : 'The fixed list readers choose from.'}>
        <ConfigInput
          value={(options.map((o) => o.value)).join(', ')}
          readOnly
          aria-label="Suggestions (edit in Options)"
          placeholder="add suggestions in Options ↓"
        />
      </ConfigField>
      <ConfigField label="Dynamic suggestions" hint="Optional — an expression over inputs. Overrides the static list.">
        <ConfigInput
          mono
          value={blockProp<string>(block, 'dynamic') ?? ''}
          readOnly={editor.readOnly}
          spellCheck={false}
          aria-label="Dynamic suggestions expression"
          placeholder="allTags"
          onChange={(e) => kitSet(editor, block, 'dynamic', e.target.value)}
        />
      </ConfigField>
      {!(blockProp<string>(block, 'dynamic') ?? '').trim() && <OptionsEditor block={block} editor={editor} />}
    </>
  );

  // Free entry OFF → reuse the searchable multi-select surface.
  const control = !freeEntry ? (
    <SearchPicker
      ariaLabel={name}
      summary={selected.length === 0 ? 'Select…' : selected.map((v) => labelOf(options, v)).join(', ')}
      options={options}
      selected={new Set(selected)}
      multi
      disabled={editor.readOnly}
      onToggle={(val) => setSelected(selected.includes(val) ? selected.filter((t) => t !== val) : [...selected, val])}
    />
  ) : (
    <div className="obe-kit-tags" role="group" aria-label={name}>
      {selected.map((tag) => (
        <span key={tag} className="obe-kit-tag">
          {labelOf(options, tag)}
          {!editor.readOnly && (
            <button type="button" className="obe-kit-tag-x" aria-label={`Remove ${tag}`} onClick={() => remove(tag)}>
              <X className="h-3 w-3" />
            </button>
          )}
        </span>
      ))}
      {!editor.readOnly && (
        <span className="obe-kit-tag-entry">
          <input
            className="obe-kit-tag-input"
            value={draft}
            placeholder={selected.length === 0 ? 'Add a tag…' : '+'}
            aria-label="Add a tag"
            list={`obe-tags-${name}`}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter' || e.key === ',') {
                e.preventDefault();
                add(draft);
              } else if (e.key === 'Backspace' && !draft && selected.length > 0) {
                remove(selected[selected.length - 1]);
              }
            }}
          />
          <datalist id={`obe-tags-${name}`}>
            {suggestions.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </datalist>
        </span>
      )}
    </div>
  );

  return <KitFrame block={block} editor={editor} kind="tagfield" defaultName="tags" supportsWide control={control} config={config} />;
};

/** Single helper for single/multi selection writes from a search surface. */
function toggleSelection(
  editor: CustomBlockProps['editor'],
  block: BlockMap,
  multi: boolean,
  selected: string[],
  val: string,
): void {
  if (multi) {
    kitSet(editor, block, 'selected', selected.includes(val) ? selected.filter((v) => v !== val) : [...selected, val]);
  } else {
    kitSet(editor, block, 'value', selected[0] === val ? null : val);
  }
}

/** A reusable searchable picker (popover + Radix Command), single or multi. */
const SearchPicker: React.FC<{
  ariaLabel: string;
  summary: string;
  options: KitOption[];
  selected: Set<string>;
  multi: boolean;
  disabled?: boolean;
  onToggle: (value: string) => void;
}> = ({ariaLabel, summary, options, selected, multi, disabled, onToggle}) => {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className="obe-kit-searchtrigger" aria-label={ariaLabel} aria-haspopup="listbox" disabled={disabled}>
          <span className={selected.size === 0 ? 'obe-kit-search-placeholder' : undefined}>{summary}</span>
          <Plus className="h-3.5 w-3.5 opacity-50" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-0" onKeyDown={(e) => e.stopPropagation()}>
        <Command>
          <CommandInput placeholder="Search…" aria-label="Search options" />
          <CommandList>
            <CommandEmpty>No options</CommandEmpty>
            <CommandGroup>
              {options.map((opt) => (
                <CommandItem
                  key={opt.value}
                  value={opt.label}
                  onSelect={() => {
                    onToggle(opt.value);
                    if (!multi) setOpen(false);
                  }}
                >
                  <Check className={`mr-2 h-4 w-4 ${selected.has(opt.value) ? 'opacity-100' : 'opacity-0'}`} />
                  {opt.label}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
};

/** Definitions consumed by kit/index.ts (type + renderer + slash entry). */
export const INPUT2_BLOCKS = [
  {
    type: 'choicecards',
    render: ChoiceCardsBlock,
    slash: {
      label: 'Choice cards',
      hint: 'Pick from image cards — single or multi',
      keywords: 'choice cards image radio multi select picture option visual gallery pick',
      make: () => ({
        type: 'choicecards',
        props: {name: 'choice', opts: [{label: 'One'}, {label: 'Two'}, {label: 'Three'}], value: null},
      }),
    },
  },
  {
    type: 'longtext',
    render: LongTextBlock,
    slash: {
      label: 'Long text',
      hint: 'A named multi-line text area',
      keywords: 'long text textarea multiline paragraph notes comment input',
      make: () => ({type: 'longtext', props: {name: 'text', value: ''}}),
    },
  },
  {
    type: 'richtext',
    render: RichTextBlock,
    slash: {
      label: 'Rich text',
      hint: 'Formatted text — bold, italic, links',
      keywords: 'rich text formatted markup bold italic underline link wysiwyg input',
      make: () => ({type: 'richtext', props: {name: 'text', runs: []}}),
    },
  },
  {
    type: 'searchselect',
    render: SearchSelectBlock,
    slash: {
      label: 'Searchable select',
      hint: 'Search a list — single or multi',
      keywords: 'search select multiselect dropdown combobox autocomplete filter pick option',
      make: () => ({
        type: 'searchselect',
        props: {name: 'pick', opts: [{label: 'One'}, {label: 'Two'}, {label: 'Three'}], value: null},
      }),
    },
  },
  {
    type: 'tagfield',
    render: TagFieldBlock,
    slash: {
      label: 'Tag field',
      hint: 'Free-entry tags with suggestions',
      keywords: 'tag tags chips labels keywords free entry suggestions multi input',
      make: () => ({type: 'tagfield', props: {name: 'tags', selected: [], freeEntry: true}}),
    },
  },
] as const;
