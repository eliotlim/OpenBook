import React, {useState} from 'react';
import {blockId, blockProp, setBlockProp, type BlockMap} from '../model';
import type {BlockEditorController} from '../useBlockEditor';
import {KitSettings} from './KitSettings';
import {varNameFromLabel} from './options';

/**
 * The shared chrome for every artifact-kit input: a quiet header (display name
 * + optional description, decoupled from the reactive symbol), the control
 * surface, and a ⚙ that opens a settings **popover** which expands into a
 * docked **side panel** for roomier configuration.
 *
 * Inputs are full-width by default; a "Compact" toggle opts back into the
 * inline single-row layout. The reactive symbol (`name`) is edited apart from
 * the human-facing label, so renaming the variable never disturbs the caption.
 */

export const kitSet = (editor: BlockEditorController, block: BlockMap, key: string, value: unknown): void =>
  editor.doc.transact(() => setBlockProp(block, key, value), 'local');

/** Inputs read full-width unless explicitly set compact. */
export const kitWide = (block: BlockMap): boolean => !blockProp<boolean>(block, 'compact');

/** A labelled config row used throughout the settings popover/panel. */
export const ConfigField: React.FC<{label: string; hint?: string; children: React.ReactNode}> = ({label, hint, children}) => (
  <label className="flex flex-col gap-1">
    <span className="text-xs font-medium text-foreground/80">{label}</span>
    {hint && <span className="-mt-0.5 text-[0.7rem] text-muted-foreground">{hint}</span>}
    {children}
  </label>
);

const INPUT_CLS =
  'w-full rounded-md border border-border bg-card px-2 py-1 text-sm text-foreground outline-hidden focus:border-ring';

export const ConfigInput: React.FC<React.InputHTMLAttributes<HTMLInputElement> & {mono?: boolean}> = ({
  mono,
  className,
  ...props
}) => <input {...props} className={[INPUT_CLS, mono ? 'font-mono' : '', className].filter(Boolean).join(' ')} />;

export const ConfigTextarea: React.FC<React.TextareaHTMLAttributes<HTMLTextAreaElement>> = ({className, ...props}) => (
  <textarea {...props} rows={props.rows ?? 2} className={[INPUT_CLS, 'resize-y', className].filter(Boolean).join(' ')} />
);

/**
 * A labelled on/off row for the settings panel — the same layout the built-in
 * "Compact" / "Stays interactive when locked" toggles use, lifted out so the
 * new blocks (multi-select, free-entry, gating…) can reuse it instead of
 * re-laying-out a checkbox each time.
 */
export const ConfigToggle: React.FC<{
  label: string;
  hint?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}> = ({label, hint, checked, disabled, onChange}) => (
  <label className="flex cursor-pointer items-center justify-between gap-3">
    <span className="flex flex-col">
      <span className="text-xs font-medium text-foreground/80">{label}</span>
      {hint && <span className="text-[0.7rem] text-muted-foreground">{hint}</span>}
    </span>
    <input
      type="checkbox"
      checked={checked}
      disabled={disabled}
      aria-label={label}
      onChange={(e) => onChange(e.target.checked)}
    />
  </label>
);

/**
 * A label that reads as plain text but is editable in place — the WYSIWYG way
 * to set a block's display name (and titles) right on the canvas, without
 * opening the settings popover. A borderless auto-sizing input (`field-sizing`)
 * so it looks like the text it replaces; falls back to a static span when the
 * editor is read-only (or the block's group is locked). `stopPropagation` keeps
 * keystrokes out of the surrounding block editor's shortcuts.
 */
export const KitInlineText: React.FC<{
  value: string;
  placeholder?: string;
  ariaLabel: string;
  readOnly?: boolean;
  className?: string;
  onCommit: (value: string) => void;
}> = ({value, placeholder, ariaLabel, readOnly, className, onCommit}) => {
  if (readOnly) {
    return <span className={className}>{value || placeholder}</span>;
  }
  return (
    <input
      type="text"
      className={['obe-kit-inline', className].filter(Boolean).join(' ')}
      value={value}
      placeholder={placeholder}
      aria-label={ariaLabel}
      spellCheck={false}
      onChange={(e) => onCommit(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        e.stopPropagation();
      }}
    />
  );
};

/**
 * The reactive symbol, kept deliberately quiet. It auto-derives from the
 * display name (`varNameFromLabel`), so most authors never need it; it shows as
 * a muted "Variable `darkMode` · override" line that only expands into an input
 * when they choose to pin a custom symbol.
 */
const VariableNameField: React.FC<{block: BlockMap; editor: BlockEditorController; defaultName: string}> = ({
  block,
  editor,
  defaultName,
}) => {
  const explicit = (blockProp<string>(block, 'name') ?? '').trim();
  const derived = varNameFromLabel(blockProp<string>(block, 'label') ?? '');
  const [editing, setEditing] = useState(explicit.length > 0);
  const shown = explicit || derived || defaultName || 'value';

  if (!editing) {
    return (
      <button
        type="button"
        className="obe-kit-symbol-hint"
        onClick={() => !editor.readOnly && setEditing(true)}
        disabled={editor.readOnly}
        title="The symbol formulas and charts reference"
      >
        <span>Variable</span>
        <code className="obe-kit-symbol-code">{shown}</code>
        {!editor.readOnly && <span className="obe-kit-symbol-edit">override</span>}
      </button>
    );
  }
  return (
    <ConfigField label="Variable name" hint="The symbol formulas and charts reference.">
      <ConfigInput
        mono
        autoFocus
        value={explicit}
        placeholder={derived || defaultName}
        readOnly={editor.readOnly}
        spellCheck={false}
        aria-label="Variable name"
        onChange={(e) => kitSet(editor, block, 'name', e.target.value.trim())}
      />
    </ConfigField>
  );
};

/**
 * The building block that pairs a **display name** with a **description** —
 * shared by every configuration card (inputs, charts, cards) so the two always
 * travel together. For input blocks (`symbol`) it also tucks in the
 * de-emphasized {@link VariableNameField}.
 */
export const NameDescriptionFields: React.FC<{
  block: BlockMap;
  editor: BlockEditorController;
  /** Prop holding the human display name (default `label`). */
  nameKey?: string;
  /** Placeholder for the display-name input. */
  namePlaceholder?: string;
  /** Prop holding the description (default `description`). */
  descKey?: string;
  /** Show the de-emphasized auto-derived variable name (input blocks only). */
  symbol?: boolean;
  /** Fallback symbol when the label is empty. */
  defaultName?: string;
}> = ({block, editor, nameKey = 'label', namePlaceholder, descKey = 'description', symbol = false, defaultName = ''}) => (
  <div className="flex flex-col gap-2">
    <ConfigField label="Display name">
      <ConfigInput
        value={blockProp<string>(block, nameKey) ?? ''}
        placeholder={namePlaceholder}
        readOnly={editor.readOnly}
        aria-label="Display name"
        onChange={(e) => kitSet(editor, block, nameKey, e.target.value)}
      />
    </ConfigField>
    <ConfigField label="Description">
      <ConfigTextarea
        value={blockProp<string>(block, descKey) ?? ''}
        placeholder="Add a description…"
        readOnly={editor.readOnly}
        aria-label="Description"
        onChange={(e) => kitSet(editor, block, descKey, e.target.value)}
      />
    </ConfigField>
    {symbol && <VariableNameField block={block} editor={editor} defaultName={defaultName} />}
  </div>
);

/** The common name / description / symbol / layout fields, shared by every input. */
const CommonFields: React.FC<{block: BlockMap; editor: BlockEditorController; defaultName: string; supportsWide: boolean}> = ({
  block,
  editor,
  defaultName,
  supportsWide,
}) => (
  <>
    <NameDescriptionFields block={block} editor={editor} symbol defaultName={defaultName} namePlaceholder={defaultName} />
    {supportsWide && (
      <ConfigToggle
        label="Compact"
        hint="Lay the control out on one row."
        checked={Boolean(blockProp<boolean>(block, 'compact'))}
        disabled={editor.readOnly}
        onChange={(next) => kitSet(editor, block, 'compact', next || undefined)}
      />
    )}
    <ConfigToggle
      label="Stays interactive when locked"
      hint="Readers can still change it inside a locked group."
      checked={Boolean(blockProp<boolean>(block, 'interactive'))}
      disabled={editor.readOnly}
      onChange={(next) => kitSet(editor, block, 'interactive', next || undefined)}
    />
  </>
);

export interface KitFrameProps {
  block: BlockMap;
  editor: BlockEditorController;
  /** Adds the `obe-kit-{kind}` class and is the block's value type. */
  kind: string;
  /** Fallback symbol shown in the header when no name is set. */
  defaultName: string;
  /** The control surface (pills, select, stepper…). */
  control: React.ReactNode;
  /** Extra, block-specific settings rendered below the common fields. */
  config?: React.ReactNode;
  /** Offer the full-width/compact toggle and apply the wide layout class. */
  supportsWide?: boolean;
  /** Hide the header label group (e.g. the action button labels itself). */
  hideHeader?: boolean;
  /** Whether this block publishes a named value (shows name/label/description).
   *  False for blocks like the action button that have no symbol of their own. */
  symbol?: boolean;
}

export const KitFrame: React.FC<KitFrameProps> = ({
  block,
  editor,
  kind,
  defaultName,
  control,
  config,
  supportsWide = false,
  hideHeader = false,
  symbol = true,
}) => {
  const id = blockId(block);
  const explicitName = (blockProp<string>(block, 'name') ?? '').trim();
  const displayLabel = (blockProp<string>(block, 'label') ?? '').trim();
  // The symbol the block publishes under: explicit name, else derived from the
  // display label, else the type's fallback. Mirrors scope.ts `publishedName`.
  const name = explicitName || varNameFromLabel(displayLabel) || defaultName;
  const label = displayLabel || name;
  const description = blockProp<string>(block, 'description');
  const wide = supportsWide && kitWide(block);

  const fields = (
    <div className="flex flex-col gap-3">
      {symbol && <CommonFields block={block} editor={editor} defaultName={defaultName} supportsWide={supportsWide} />}
      {config}
    </div>
  );

  return (
    <div
      className={`obe-kit obe-kit-${kind}${wide ? ' obe-kit-wide' : ''}`}
      contentEditable={false}
      data-kit-name={name}
    >
      {!hideHeader && (
        <span className="obe-kit-head">
          <KitInlineText
            className="obe-kit-label"
            value={displayLabel}
            placeholder={name}
            readOnly={editor.readOnly}
            ariaLabel="Display name"
            onCommit={(v) => kitSet(editor, block, 'label', v)}
          />
          {/* Only render the inline description when it HAS content — an empty
              field that unfurled on hover shifted the layout. Add/edit a
              description from the settings gear (NameDescriptionFields). */}
          {description && (
            <KitInlineText
              className="obe-kit-desc obe-kit-desc-edit"
              value={description}
              readOnly={editor.readOnly}
              ariaLabel="Description"
              onCommit={(v) => kitSet(editor, block, 'description', v)}
            />
          )}
        </span>
      )}
      {control}
      <KitSettings blockId={id} title={label}>
        {fields}
      </KitSettings>
    </div>
  );
};
