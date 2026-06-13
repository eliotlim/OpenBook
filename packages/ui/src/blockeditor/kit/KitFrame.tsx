import React, {useEffect, useState} from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import {Settings2, PanelRight, X} from 'lucide-react';
import {blockId, blockProp, setBlockProp, type BlockMap} from '../model';
import type {BlockEditorController} from '../useBlockEditor';
import {Popover, PopoverContent, PopoverTrigger} from '@/components/ui/popover';
import {registerKitConfig} from './kitConfig';

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

/** The common name / label / description / compact fields, shared by every input. */
const CommonFields: React.FC<{block: BlockMap; editor: BlockEditorController; defaultName: string; supportsWide: boolean}> = ({
  block,
  editor,
  defaultName,
  supportsWide,
}) => (
  <>
    <ConfigField label="Variable name" hint="The symbol formulas and charts reference.">
      <ConfigInput
        mono
        value={blockProp<string>(block, 'name') ?? ''}
        placeholder={defaultName}
        readOnly={editor.readOnly}
        spellCheck={false}
        aria-label="Variable name"
        onChange={(e) => kitSet(editor, block, 'name', e.target.value.trim())}
      />
    </ConfigField>
    <ConfigField label="Display name" hint="Shown to readers; leave blank to use the variable name.">
      <ConfigInput
        value={blockProp<string>(block, 'label') ?? ''}
        readOnly={editor.readOnly}
        aria-label="Display name"
        onChange={(e) => kitSet(editor, block, 'label', e.target.value)}
      />
    </ConfigField>
    <ConfigField label="Description">
      <ConfigTextarea
        value={blockProp<string>(block, 'description') ?? ''}
        readOnly={editor.readOnly}
        aria-label="Description"
        onChange={(e) => kitSet(editor, block, 'description', e.target.value)}
      />
    </ConfigField>
    {supportsWide && (
      <label className="flex cursor-pointer items-center justify-between gap-3">
        <span className="flex flex-col">
          <span className="text-xs font-medium text-foreground/80">Compact</span>
          <span className="text-[0.7rem] text-muted-foreground">Lay the control out on one row.</span>
        </span>
        <input
          type="checkbox"
          checked={Boolean(blockProp<boolean>(block, 'compact'))}
          disabled={editor.readOnly}
          aria-label="Compact layout"
          onChange={(e) => kitSet(editor, block, 'compact', e.target.checked || undefined)}
        />
      </label>
    )}
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
  const [panel, setPanel] = useState(false);
  const [open, setOpen] = useState(false);

  // Let the block context menu's "Configure" item open this popover (deferred a
  // tick so the closing context menu doesn't immediately steal it back).
  const id = blockId(block);
  useEffect(() => registerKitConfig(id, () => setTimeout(() => setOpen(true), 0)), [id]);

  const name = blockProp<string>(block, 'name') || defaultName;
  const label = blockProp<string>(block, 'label') || name;
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
          <span className="obe-kit-label">{label}</span>
          {description && <span className="obe-kit-desc">{description}</span>}
        </span>
      )}
      {control}
      <span className="obe-kit-spacer" />

      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button type="button" className="obe-kit-gear" aria-label="Configure block" title="Configure">
            <Settings2 className="h-4 w-4" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-72">
          <div className="mb-3 flex items-center justify-between">
            <span className="text-sm font-semibold">Settings</span>
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              aria-label="Expand to side panel"
              onClick={() => setPanel(true)}
            >
              <PanelRight className="h-3.5 w-3.5" /> Expand
            </button>
          </div>
          {fields}
        </PopoverContent>
      </Popover>

      {/* Expanded: a right-docked side panel with the same fields, more room. */}
      <DialogPrimitive.Root open={panel} onOpenChange={setPanel}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-foreground/20 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
          <DialogPrimitive.Content className="fixed inset-y-0 right-0 z-50 flex w-[24rem] max-w-[92vw] flex-col gap-4 overflow-y-auto border-l border-border bg-popover p-5 text-popover-foreground shadow-2xl outline-hidden data-[state=open]:animate-in data-[state=open]:slide-in-from-right">
            <div className="flex items-center justify-between">
              <DialogPrimitive.Title className="text-base font-semibold">
                {label} settings
              </DialogPrimitive.Title>
              <DialogPrimitive.Close className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground" aria-label="Close">
                <X className="h-4 w-4" />
              </DialogPrimitive.Close>
            </div>
            <DialogPrimitive.Description className="sr-only">Configure this interactive block.</DialogPrimitive.Description>
            {fields}
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    </div>
  );
};
