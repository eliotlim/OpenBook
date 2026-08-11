import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  FORM_FIELD_KINDS,
  FORM_FIELD_PROPERTY_TYPES,
  FORM_PATTERN_MAX_LENGTH,
  planColumnCreation,
  type DataClient,
  type FormField,
  type FormFieldKind,
  type FormFieldValidation,
  type FormSchema,
  type StoredDatabase,
} from '@book.dev/sdk';
import {ChevronDown, GripVertical, MoreHorizontal, Settings2, Trash2} from 'lucide-react';
import {useOptionalData} from '@/data';
import {Select} from '@/components/ui/select';
import {Popover, PopoverContent, PopoverTrigger} from '@/components/ui/popover';
import {useConfirm, useOptionalNavigation} from '@/providers';
import {pageLinks} from '@/lib/pageLinks';
import {t, type TKey} from '@/i18n';
import {blockProp, setBlockProp, type BlockMap} from './model';
import type {BlockEditorController} from './useBlockEditor';
import {
  insertFormField,
  makeFormField,
  moveFormField,
  randomFormFieldId,
  randomSubmissionKey,
  reorderFormFields,
} from './formBlock';
import {ConfigField, ConfigInput, ConfigTextarea, ConfigToggle} from './kit/KitFrame';
import {OptionsListEditor, type EditableOptionRow} from './kit/OptionsEditor';

const FIELD_KIND_KEYS = Object.fromEntries(
  FORM_FIELD_KINDS.map((kind) => [kind, `formBlock.builder.fieldKind.${kind}`]),
) as Record<FormFieldKind, TKey>;

const LENGTH_KINDS = new Set<FormFieldKind>([
  'text', 'longtext', 'select', 'multiselect', 'email', 'phone', 'url', 'files',
]);
const PATTERN_KINDS = new Set<FormFieldKind>([
  'text', 'longtext', 'select', 'date', 'email', 'phone', 'url',
]);
const NUMBER_KINDS = new Set<FormFieldKind>(['number', 'rating']);

type BuilderDrag = {kind: 'palette'; fieldKind: FormFieldKind} | {kind: 'field'; fieldId: string};
type DropTarget = {fieldId: string; region: 'above' | 'below'} | null;
type PatternIssue = 'invalid' | 'unsafe' | 'too_long' | null;

/** Mirrors the SDK validator's conservative regular-expression authoring
 * screen so an unsafe pattern is caught before a reader ever submits it. */
export function formPatternIssue(pattern: string): PatternIssue {
  if (pattern.length > FORM_PATTERN_MAX_LENGTH) return 'too_long';
  try {
    new RegExp(pattern);
  } catch {
    return 'invalid';
  }
  if (/\\(?:[1-9]|k<)/.test(pattern)) return 'unsafe';
  const frames: Array<{alternation: boolean; quantifier: boolean}> = [{alternation: false, quantifier: false}];
  let inClass = false;
  let quantifiers = 0;
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === '\\') {
      i += 1;
      continue;
    }
    if (inClass) {
      if (char === ']') inClass = false;
      continue;
    }
    if (char === '[') {
      inClass = true;
      continue;
    }
    if (char === '(') {
      if (pattern[i + 1] === '?' && pattern[i + 2] !== ':') return 'unsafe';
      if (pattern[i + 1] === '?' && pattern[i + 2] === ':') i += 2;
      frames.push({alternation: false, quantifier: false});
      continue;
    }
    if (char === '|') {
      frames[frames.length - 1].alternation = true;
      continue;
    }
    if (char === ')') {
      if (frames.length === 1) continue;
      const frame = frames.pop()!;
      const next = pattern[i + 1];
      const quantified = next === '*' || next === '+' || next === '?' || next === '{';
      if (quantified && (frame.alternation || frame.quantifier)) return 'unsafe';
      const parent = frames[frames.length - 1];
      parent.alternation ||= frame.alternation;
      parent.quantifier ||= frame.quantifier || quantified;
      continue;
    }
    if (char === '*' || char === '+' || char === '?' || char === '{') {
      frames[frames.length - 1].quantifier = true;
      quantifiers += 1;
      if (quantifiers > 8) return 'unsafe';
    }
  }
  return inClass ? 'invalid' : null;
}

/** Write the nested schema and FORM-1 gate aliases atomically. */
export function writeFormSchema(editor: BlockEditorController, block: BlockMap, schema: FormSchema): void {
  editor.doc.transact(() => {
    setBlockProp(block, 'schema', schema);
    setBlockProp(block, 'formId', schema.formId);
    setBlockProp(block, 'submissionKey', schema.submissionKey);
    setBlockProp(block, 'enabled', schema.enabled);
    setBlockProp(block, 'databaseId', schema.databaseId || undefined);
  }, 'local');
}

export interface AppliedFormColumnPlan {
  schema: FormSchema;
  database: StoredDatabase;
}

/** Re-read the database, apply only explicitly selected SDK proposals, then
 * bind their deterministic ids into the form schema returned to the caller. */
export async function createPlannedFormColumns(
  client: Pick<DataClient, 'getDatabase' | 'updateDatabase'>,
  schema: FormSchema,
  database: StoredDatabase,
  selectedFieldIds: ReadonlySet<string>,
): Promise<AppliedFormColumnPlan> {
  const latest = await client.getDatabase(database.id) ?? database;
  const plan = planColumnCreation(schema, latest.schema)
    .filter(({field}) => selectedFieldIds.has(field.id));
  if (plan.length === 0) return {schema, database: latest};
  const updated = await client.updateDatabase(latest.id, {
    schema: {
      ...latest.schema,
      properties: [...latest.schema.properties, ...plan.map(({proposedProperty}) => proposedProperty)],
    },
  });
  const columnByField = new Map(plan.map(({field, proposedProperty}) => [field.id, proposedProperty.id]));
  return {
    database: updated,
    schema: {
      ...schema,
      fields: schema.fields.map((field) => {
        const columnId = columnByField.get(field.id);
        return columnId ? {...field, columnId} : field;
      }),
    },
  };
}

function useBoundDatabase(databaseId: string | undefined): {
  database: StoredDatabase | null;
  setDatabase: React.Dispatch<React.SetStateAction<StoredDatabase | null>>;
} {
  const client = useOptionalData();
  const [database, setDatabase] = useState<StoredDatabase | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (!client || !databaseId) {
      setDatabase(null);
      return;
    }
    void client.getDatabase(databaseId)
      .then((next) => {
        if (!cancelled) setDatabase(next);
      })
      .catch(() => {
        if (!cancelled) setDatabase(null);
      });
    return () => { cancelled = true; };
  }, [client, databaseId]);
  return {database, setDatabase};
}

function numberValue(value: string): number | undefined {
  if (value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function validationPatch(
  field: FormField,
  key: keyof FormFieldValidation,
  value: number | string | undefined,
): FormField {
  const validation = {...field.validation, [key]: value};
  if (value === undefined) delete validation[key];
  return Object.keys(validation).length > 0
    ? {...field, validation}
    : {...field, validation: undefined};
}

const ValidationSettings: React.FC<{
  field: FormField;
  onChange: (field: FormField) => void;
}> = ({field, onChange}) => {
  const pattern = field.validation?.pattern ?? '';
  const issue = pattern ? formPatternIssue(pattern) : null;
  const issueText = issue === 'invalid'
    ? t('formBlock.builder.patternInvalid')
    : issue === 'unsafe'
      ? t('formBlock.builder.patternUnsafe')
      : issue === 'too_long'
        ? t('formBlock.builder.patternTooLong', {count: FORM_PATTERN_MAX_LENGTH})
        : null;
  const numeric = (key: keyof FormFieldValidation, label: TKey): React.ReactNode => (
    <ConfigField label={t(label)}>
      <ConfigInput
        type="number"
        value={field.validation?.[key] ?? ''}
        onChange={(event) => onChange(validationPatch(field, key, numberValue(event.target.value)))}
      />
    </ConfigField>
  );

  if (!NUMBER_KINDS.has(field.kind) && !LENGTH_KINDS.has(field.kind) && !PATTERN_KINDS.has(field.kind)) return null;
  return (
    <fieldset className="obe-form-settings-group">
      <legend>{t('formBlock.builder.validation')}</legend>
      {NUMBER_KINDS.has(field.kind) && (
        <div className="obe-form-settings-grid">
          {numeric('min', 'formBlock.builder.minimum')}
          {numeric('max', 'formBlock.builder.maximum')}
        </div>
      )}
      {LENGTH_KINDS.has(field.kind) && (
        <div className="obe-form-settings-grid">
          {numeric('minLength', 'formBlock.builder.minimumLength')}
          {numeric('maxLength', 'formBlock.builder.maximumLength')}
        </div>
      )}
      {PATTERN_KINDS.has(field.kind) && (
        <ConfigField label={t('formBlock.builder.pattern')} hint={t('formBlock.builder.patternHint')}>
          <ConfigInput
            mono
            value={pattern}
            aria-invalid={issueText ? true : undefined}
            aria-describedby={issueText ? `form-pattern-${field.id}` : undefined}
            onChange={(event) => onChange(validationPatch(field, 'pattern', event.target.value || undefined))}
          />
          {issueText && <span id={`form-pattern-${field.id}`} className="obe-form-authoring-error" role="alert">{issueText}</span>}
        </ConfigField>
      )}
    </fieldset>
  );
};

const FieldOptionsSettings: React.FC<{
  field: FormField;
  onChange: (field: FormField) => void;
}> = ({field, onChange}) => {
  if (field.kind !== 'select' && field.kind !== 'multiselect') return null;
  const rows: EditableOptionRow[] = (field.options ?? []).map((option) => ({label: option.label, value: option.id}));
  return (
    <OptionsListEditor
      rows={rows}
      copy={{
        fieldLabel: t('formBlock.builder.options'),
        hint: t('formBlock.builder.optionsHint'),
        labelPlaceholder: t('formBlock.builder.optionLabel'),
        valuePlaceholder: t('formBlock.builder.optionId'),
        add: t('formBlock.builder.addOption'),
        remove: (index) => t('formBlock.builder.removeOption', {count: index + 1}),
      }}
      onChange={(next) => onChange({
        ...field,
        options: next.map((option, index) => ({
          id: option.value.trim() || field.options?.[index]?.id || randomFormFieldId(),
          label: option.label,
        })),
      })}
    />
  );
};

const DatabaseColumnSettings: React.FC<{
  field: FormField;
  database: StoredDatabase | null;
  autoCreate: boolean;
  proposal: ReturnType<typeof planColumnCreation>[number] | undefined;
  onExisting: (columnId: string | undefined) => void;
  onAutoCreate: () => void;
}> = ({field, database, autoCreate, proposal, onExisting, onAutoCreate}) => {
  if (!database) return null;
  const compatible = database.schema.properties.filter(
    (property) => property.type === FORM_FIELD_PROPERTY_TYPES[field.kind],
  );
  return (
    <div className="obe-form-column-settings">
      <ConfigField label={t('formBlock.builder.databaseColumn')}>
        <Select
          value={autoCreate ? '__auto__' : field.columnId ?? ''}
          aria-label={t('formBlock.builder.databaseColumn')}
          onChange={(event) => {
            if (event.target.value === '__auto__') onAutoCreate();
            else onExisting(event.target.value || undefined);
          }}
        >
          <option value="">{t('formBlock.builder.unboundColumn')}</option>
          <option value="__auto__">{t('formBlock.builder.autoCreateColumn')}</option>
          {compatible.map((property) => <option key={property.id} value={property.id}>{property.name}</option>)}
        </Select>
      </ConfigField>
      {compatible.length === 0 && !autoCreate && (
        <span className="obe-form-settings-hint">{t('formBlock.builder.noCompatibleColumns')}</span>
      )}
      {autoCreate && proposal && (
        <span className="obe-form-settings-hint" data-form-column-proposal={proposal.proposedProperty.id}>
          {t('formBlock.builder.autoCreateProposal', {
            name: proposal.proposedProperty.name,
            type: proposal.proposedProperty.type,
          })}
        </span>
      )}
    </div>
  );
};

const FieldSettings: React.FC<{
  field: FormField;
  database: StoredDatabase | null;
  autoCreate: boolean;
  proposal: ReturnType<typeof planColumnCreation>[number] | undefined;
  onChange: (field: FormField) => void;
  onAutoCreate: (next: boolean) => void;
}> = ({field, database, autoCreate, proposal, onChange, onAutoCreate}) => {
  const label = field.label || t('formBlock.untitledField');
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="obe-form-row-button"
          aria-label={t('formBlock.builder.fieldSettings', {label})}
        >
          <Settings2 className="h-4 w-4" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80" onKeyDown={(event) => event.stopPropagation()}>
        <div className="obe-form-field-settings" data-form-field-settings={field.id}>
          <strong className="text-sm">{t('formBlock.builder.fieldSettings', {label})}</strong>
          <ConfigField label={t('formBlock.builder.label')}>
            <ConfigInput value={field.label} onChange={(event) => onChange({...field, label: event.target.value})} />
          </ConfigField>
          <ConfigField label={t('formBlock.builder.placeholder')}>
            <ConfigInput
              value={field.placeholder ?? ''}
              onChange={(event) => onChange({...field, placeholder: event.target.value || undefined})}
            />
          </ConfigField>
          <ConfigToggle
            label={t('formBlock.builder.required')}
            checked={field.required}
            onChange={(required) => onChange({...field, required})}
          />
          <ValidationSettings field={field} onChange={onChange} />
          <FieldOptionsSettings field={field} onChange={onChange} />
          <DatabaseColumnSettings
            field={field}
            database={database}
            autoCreate={autoCreate}
            proposal={proposal}
            onExisting={(columnId) => {
              onAutoCreate(false);
              onChange({...field, columnId});
            }}
            onAutoCreate={() => {
              onAutoCreate(true);
              onChange({...field, columnId: undefined});
            }}
          />
          <details className="obe-form-advanced">
            <summary className="cursor-pointer">
              <ChevronDown className="h-3.5 w-3.5" /> {t('formBlock.builder.advanced')}
            </summary>
            <ConfigToggle
              label={t('formBlock.builder.honeypot')}
              hint={t('formBlock.builder.honeypotHint')}
              checked={field.honeypot === true}
              onChange={(honeypot) => onChange({...field, honeypot: honeypot || undefined})}
            />
          </details>
        </div>
      </PopoverContent>
    </Popover>
  );
};

const FieldActions: React.FC<{
  field: FormField;
  first: boolean;
  last: boolean;
  onMove: (delta: -1 | 1) => void;
  onRemove: () => void;
}> = ({field, first, last, onMove, onRemove}) => {
  const label = field.label || t('formBlock.untitledField');
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" className="obe-form-row-button" aria-label={t('formBlock.builder.fieldActions', {label})}>
          <MoreHorizontal className="h-4 w-4" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-44 p-1">
        <button type="button" className="obe-form-menu-item" disabled={first} onClick={() => onMove(-1)}>
          {t('formBlock.builder.moveUp')}
        </button>
        <button type="button" className="obe-form-menu-item" disabled={last} onClick={() => onMove(1)}>
          {t('formBlock.builder.moveDown')}
        </button>
        <button type="button" className="obe-form-menu-item obe-form-menu-danger" onClick={onRemove}>
          <Trash2 className="h-3.5 w-3.5" /> {t('formBlock.builder.removeField')}
        </button>
      </PopoverContent>
    </Popover>
  );
};

export const FormEditView: React.FC<{
  schema: FormSchema;
  block: BlockMap;
  editor: BlockEditorController;
}> = ({schema, block, editor}) => {
  const client = useOptionalData();
  const [current, setCurrent] = useState(schema);
  const [drag, setDrag] = useState<BuilderDrag | null>(null);
  const dragRef = useRef<BuilderDrag | null>(null);
  const [over, setOver] = useState<DropTarget>(null);
  const [autoCreate, setAutoCreate] = useState<Set<string>>(() => new Set());
  const [columnSave, setColumnSave] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const {database, setDatabase} = useBoundDatabase(current.databaseId);

  useEffect(() => setCurrent(schema), [schema]);
  useEffect(() => {
    const ids = new Set(current.fields.map((field) => field.id));
    setAutoCreate((selected) => {
      const next = new Set([...selected].filter((id) => ids.has(id)));
      return next.size === selected.size ? selected : next;
    });
  }, [current.fields]);

  const commit = useCallback((next: FormSchema): void => {
    setCurrent(next);
    writeFormSchema(editor, block, next);
  }, [block, editor]);

  const commitFields = (fields: FormField[]): void => commit({...current, fields});
  const fieldLabel = (kind: FormFieldKind): string => t(FIELD_KIND_KEYS[kind]);
  const startDrag = (next: BuilderDrag): void => {
    dragRef.current = next;
    setDrag(next);
  };
  const clearDrag = (): void => {
    dragRef.current = null;
    setDrag(null);
    setOver(null);
  };
  const dropAt = (gap: number): void => {
    const active = dragRef.current;
    if (!active) return;
    if (active.kind === 'palette') {
      commitFields(insertFormField(current.fields, makeFormField(active.fieldKind, fieldLabel(active.fieldKind)), gap));
    } else {
      commitFields(reorderFormFields(current.fields, active.fieldId, gap));
    }
    clearDrag();
  };
  const dropGap = (index: number, region: 'above' | 'below'): number => index + (region === 'below' ? 1 : 0);
  const proposals = useMemo(
    () => database ? planColumnCreation(current, database.schema) : [],
    [current, database],
  );

  const saveColumns = async (): Promise<void> => {
    if (!client || !database || autoCreate.size === 0) return;
    setColumnSave('saving');
    try {
      const applied = await createPlannedFormColumns(client, current, database, autoCreate);
      setDatabase(applied.database);
      setAutoCreate(new Set());
      commit(applied.schema);
      setColumnSave('saved');
    } catch {
      setColumnSave('error');
    }
  };

  return (
    <div className="obe-form-edit" data-form-mode="edit" data-form-builder>
      <section className="obe-form-palette" aria-label={t('formBlock.builder.palette')}>
        <div className="obe-form-section-heading">
          <strong>{t('formBlock.builder.palette')}</strong>
          <span>{t('formBlock.builder.paletteHint')}</span>
        </div>
        <div className="obe-form-palette-grid">
          {FORM_FIELD_KINDS.map((kind) => (
            <button
              key={kind}
              type="button"
              draggable
              className="obe-form-palette-item"
              data-form-palette-kind={kind}
              aria-label={t('formBlock.builder.addField', {kind: fieldLabel(kind)})}
              onDragStart={(event) => {
                event.dataTransfer?.setData('text/plain', kind);
                if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copy';
                startDrag({kind: 'palette', fieldKind: kind});
              }}
              onDragEnd={clearDrag}
              onClick={() => commitFields([...current.fields, makeFormField(kind, fieldLabel(kind))])}
            >
              <span>{fieldLabel(kind)}</span>
              <code>{kind}</code>
            </button>
          ))}
        </div>
      </section>

      <section className="obe-form-canvas" aria-label={t('formBlock.builder.canvas')}>
        <div className="obe-form-section-heading">
          <strong>{t('formBlock.builder.canvas')}</strong>
          <span>{t('formBlock.builder.keyboardHint')}</span>
        </div>
        {current.fields.length === 0 ? (
          <div
            className={`obe-form-empty${drag ? ' obe-form-empty-active' : ''}`}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              dropAt(0);
            }}
          >
            {t('formBlock.builder.emptyCanvas')}
          </div>
        ) : (
          <ol className="obe-form-canvas-list">
            {current.fields.map((field, index) => {
              const label = field.label || t('formBlock.untitledField');
              const region = over?.fieldId === field.id ? over.region : null;
              const proposal = proposals.find(({field: planned}) => planned.id === field.id);
              const setField = (next: FormField): void =>
                commitFields(current.fields.map((item) => item.id === field.id ? next : item));
              const move = (delta: -1 | 1): void => commitFields(moveFormField(current.fields, field.id, delta));
              const setAuto = (next: boolean): void => setAutoCreate((selected) => {
                const changed = new Set(selected);
                if (next) changed.add(field.id);
                else changed.delete(field.id);
                return changed;
              });
              return (
                <li
                  key={field.id}
                  tabIndex={0}
                  data-form-field-row={field.id}
                  data-form-field-kind={field.kind}
                  className={`obe-form-canvas-row${region ? ` obe-form-drop-${region}` : ''}`}
                  onKeyDown={(event) => {
                    if (event.target !== event.currentTarget || (!event.altKey && !event.metaKey)) return;
                    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
                      event.preventDefault();
                      move(event.key === 'ArrowUp' ? -1 : 1);
                    }
                  }}
                  onDragOver={(event) => {
                    if (!dragRef.current || (dragRef.current.kind === 'field' && dragRef.current.fieldId === field.id)) return;
                    event.preventDefault();
                    const rect = event.currentTarget.getBoundingClientRect();
                    const next = event.clientY < rect.top + rect.height / 2 ? 'above' : 'below';
                    setOver({fieldId: field.id, region: next});
                  }}
                  onDragLeave={() => setOver((target) => target?.fieldId === field.id ? null : target)}
                  onDrop={(event) => {
                    event.preventDefault();
                    const rect = event.currentTarget.getBoundingClientRect();
                    const next = event.clientY < rect.top + rect.height / 2 ? 'above' : 'below';
                    dropAt(dropGap(index, next));
                  }}
                >
                  <button
                    type="button"
                    draggable
                    className="obe-form-field-grip"
                    aria-label={t('formBlock.builder.dragField', {label})}
                    onDragStart={(event) => {
                      event.dataTransfer?.setData('text/plain', field.id);
                      if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
                      startDrag({kind: 'field', fieldId: field.id});
                    }}
                    onDragEnd={clearDrag}
                    onPointerDown={(event) => {
                      if (event.pointerType !== 'touch') return;
                      event.preventDefault();
                      const startY = event.clientY;
                      let engaged = false;
                      let lastGap: number | null = null;
                      const moveTouch = (pointer: PointerEvent): void => {
                        if (!engaged && Math.abs(pointer.clientY - startY) < 6) return;
                        engaged = true;
                        pointer.preventDefault();
                        startDrag({kind: 'field', fieldId: field.id});
                        const under = document.elementsFromPoint(pointer.clientX, pointer.clientY)
                          .find((element) => element instanceof HTMLElement && element.dataset.formFieldRow && element.dataset.formFieldRow !== field.id) as HTMLElement | undefined;
                        if (!under) return;
                        const targetIndex = current.fields.findIndex((item) => item.id === under.dataset.formFieldRow);
                        const rect = under.getBoundingClientRect();
                        const next = pointer.clientY < rect.top + rect.height / 2 ? 'above' : 'below';
                        lastGap = dropGap(targetIndex, next);
                        setOver({fieldId: under.dataset.formFieldRow!, region: next});
                      };
                      const endTouch = (): void => {
                        window.removeEventListener('pointermove', moveTouch);
                        window.removeEventListener('pointerup', endTouch);
                        window.removeEventListener('pointercancel', endTouch);
                        if (engaged && lastGap !== null) dropAt(lastGap);
                        else clearDrag();
                      };
                      window.addEventListener('pointermove', moveTouch, {passive: false});
                      window.addEventListener('pointerup', endTouch);
                      window.addEventListener('pointercancel', endTouch);
                    }}
                  >
                    <GripVertical className="h-4 w-4" />
                  </button>
                  <div className="obe-form-row-copy">
                    <span>{label}</span>
                    <code>{field.kind}</code>
                  </div>
                  {field.required && <span className="obe-form-required">{t('formBlock.required')}</span>}
                  <FieldSettings
                    field={field}
                    database={database}
                    autoCreate={autoCreate.has(field.id)}
                    proposal={proposal}
                    onChange={setField}
                    onAutoCreate={setAuto}
                  />
                  <FieldActions
                    field={field}
                    first={index === 0}
                    last={index === current.fields.length - 1}
                    onMove={move}
                    onRemove={() => commitFields(current.fields.filter((item) => item.id !== field.id))}
                  />
                </li>
              );
            })}
          </ol>
        )}
        {autoCreate.size > 0 && database && (
          <div className="obe-form-column-save">
            <button
              type="button"
              className="obe-kit-action cursor-pointer"
              disabled={columnSave === 'saving'}
              onClick={() => void saveColumns()}
            >
              {columnSave === 'saving' ? t('formBlock.builder.savingColumns') : t('formBlock.builder.saveColumns')}
            </button>
            {columnSave === 'saved' && <span role="status">{t('formBlock.builder.columnsSaved')}</span>}
            {columnSave === 'error' && <span role="alert">{t('formBlock.builder.columnsSaveFailed')}</span>}
          </div>
        )}
      </section>
    </div>
  );
};

export const FormSettings: React.FC<{
  schema: FormSchema;
  block: BlockMap;
  editor: BlockEditorController;
}> = ({schema, block, editor}) => {
  const client = useOptionalData();
  const nav = useOptionalNavigation();
  const confirm = useConfirm();
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState(false);
  const databases = nav?.pages.filter((page) => page.hostedDatabaseId) ?? [];
  const patch = (next: FormSchema): void => writeFormSchema(editor, block, next);
  const bindDatabase = (databaseId: string | undefined): void => patch({
    ...schema,
    databaseId,
    fields: schema.fields.map((field) => {
      const next = {...field};
      delete next.columnId;
      return next;
    }),
  });
  const createDatabase = async (): Promise<void> => {
    const parentId = nav?.currentPageId ?? nav?.primaryPageId;
    if (!client || !parentId) {
      setCreateError(true);
      return;
    }
    setCreating(true);
    setCreateError(false);
    try {
      const pageId = await pageLinks.createSubpage(parentId, 'database');
      const database = await client.getPageDatabase(pageId);
      if (!database) throw new Error('database was not created');
      bindDatabase(database.id);
    } catch {
      setCreateError(true);
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="obe-form-global-settings" data-form-settings>
      <ConfigField label={t('formBlock.settings.databasePicker')}>
        <Select
          value={schema.databaseId ?? ''}
          aria-label={t('formBlock.settings.databasePicker')}
          onChange={(event) => bindDatabase(event.target.value || undefined)}
        >
          <option value="">{t('formBlock.settings.chooseDatabase')}</option>
          {databases.map((page) => (
            <option key={page.hostedDatabaseId!} value={page.hostedDatabaseId!}>
              {page.name?.trim() || nav?.pageLabel(page.id)}
            </option>
          ))}
          {schema.databaseId && !databases.some((page) => page.hostedDatabaseId === schema.databaseId) && (
            <option value={schema.databaseId}>{t('formBlock.databaseId', {id: schema.databaseId})}</option>
          )}
        </Select>
      </ConfigField>
      {databases.length === 0 && <span className="obe-form-settings-hint">{t('formBlock.settings.noDatabases')}</span>}
      <button
        type="button"
        className="obe-form-settings-action"
        disabled={creating || !client || !nav}
        onClick={() => void createDatabase()}
      >
        {creating ? t('formBlock.settings.creatingDatabase') : t('formBlock.settings.createDatabase')}
      </button>
      {createError && <span className="obe-form-authoring-error" role="alert">{t('formBlock.settings.databaseCreateFailed')}</span>}
      <ConfigField label={t('formBlock.settings.submitLabel')}>
        <ConfigInput
          value={schema.submitLabel ?? ''}
          onChange={(event) => patch({...schema, submitLabel: event.target.value || undefined})}
        />
      </ConfigField>
      <ConfigField label={t('formBlock.settings.confirmation')}>
        <Select
          value={'redirectUrl' in schema.confirmation ? 'redirect' : 'message'}
          onChange={(event) => patch({
            ...schema,
            confirmation: event.target.value === 'redirect' ? {redirectUrl: ''} : {message: ''},
          })}
        >
          <option value="message">{t('formBlock.settings.confirmationMessage')}</option>
          <option value="redirect">{t('formBlock.settings.confirmationRedirect')}</option>
        </Select>
      </ConfigField>
      {'redirectUrl' in schema.confirmation ? (
        <ConfigField label={t('formBlock.settings.redirectUrl')}>
          <ConfigInput
            type="url"
            value={schema.confirmation.redirectUrl}
            onChange={(event) => patch({...schema, confirmation: {redirectUrl: event.target.value}})}
          />
        </ConfigField>
      ) : (
        <ConfigField label={t('formBlock.settings.message')}>
          <ConfigTextarea
            value={schema.confirmation.message}
            onChange={(event) => patch({...schema, confirmation: {message: event.target.value}})}
          />
        </ConfigField>
      )}
      <ConfigToggle
        label={t('formBlock.settings.enabled')}
        hint={t('formBlock.settings.enabledHint')}
        checked={schema.enabled}
        onChange={(enabled) => patch({...schema, enabled})}
      />
      <ConfigField label={t('formBlock.settings.submissionKey')}>
        <code className="obe-form-id">{schema.submissionKey || '—'}</code>
      </ConfigField>
      <button
        type="button"
        className="obe-form-settings-action obe-form-key-regenerate"
        onClick={() => void confirm({
          title: t('formBlock.settings.regenerateTitle'),
          description: t('formBlock.settings.regenerateWarning'),
          confirmText: t('formBlock.settings.regenerateConfirm'),
          destructive: true,
        }).then((accepted) => {
          if (accepted) patch({...schema, submissionKey: randomSubmissionKey()});
        })}
      >
        {t('formBlock.settings.regenerateKey')}
      </button>
    </div>
  );
};

/** Test/debug helper for reading the schema value currently stored on a block. */
export const storedFormSchema = (block: BlockMap): FormSchema | undefined => blockProp<FormSchema>(block, 'schema');
