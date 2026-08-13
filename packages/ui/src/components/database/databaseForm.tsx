import React, {useState} from 'react';
import {AlertTriangle, GripVertical, Plus, Trash2} from 'lucide-react';
import {
  isFormWritablePropertyType,
  type DatabaseFormField,
  type DatabaseProperty,
  type DatabaseView,
  type FormWritablePropertyType,
} from '@book.dev/sdk';
import {Button} from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {Select} from '@/components/ui/select';
import {Switch} from '@/components/ui/switch';
import type {TKey} from '@/i18n';
import {cn} from '@/lib/utils';
import {useTranslation} from '@/providers';
import type {AddPropertyForViewListOptions, NewPropertyInput} from './useDatabase';

const FORM_TYPE_KEY: Record<FormWritablePropertyType, TKey> = {
  text: 'database.formView.types.text',
  number: 'database.formView.types.number',
  rating: 'database.formView.types.rating',
  select: 'database.formView.types.select',
  multi_select: 'database.formView.types.multiSelect',
  status: 'database.formView.types.status',
  checkbox: 'database.formView.types.checkbox',
  date: 'database.formView.types.date',
  url: 'database.formView.types.url',
  email: 'database.formView.types.email',
  phone: 'database.formView.types.phone',
  location: 'database.formView.types.location',
  files: 'database.formView.types.files',
};

export const FORM_PROPERTY_TYPES = Object.keys(FORM_TYPE_KEY) as FormWritablePropertyType[];

export interface ProjectedDatabaseFormField {
  property: DatabaseProperty;
  metadata: DatabaseFormField;
  writable: boolean;
  label: string;
}

/** Resolve form mappings against the current property schema. Names and types
 *  are intentionally read now, never copied into form metadata. */
export function projectDatabaseFormFields(
  properties: readonly DatabaseProperty[],
  view: DatabaseView,
): ProjectedDatabaseFormField[] {
  const byId = new Map(properties.map((property) => [property.id, property]));
  return (view.visiblePropertyIds ?? []).flatMap((propertyId) => {
    const property = byId.get(propertyId);
    if (!property) return [];
    const metadata = view.formFields?.[propertyId] ?? {};
    return [{
      property,
      metadata,
      writable: !property.id.startsWith('sys_') && isFormWritablePropertyType(property.type),
      label: metadata.label?.trim() || property.name,
    }];
  });
}

/** Move one mapped field to the drop target without changing the property schema. */
export function reorderFormFieldIds(ids: readonly string[], fromId: string, toId: string): string[] {
  if (fromId === toId) return [...ids];
  const next = [...ids];
  const from = next.indexOf(fromId);
  const to = next.indexOf(toId);
  if (from < 0 || to < 0) return next;
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

export interface DatabaseFormProps {
  view: DatabaseView;
  properties: DatabaseProperty[];
  canEdit: boolean;
  onUpdateView: (patch: Partial<DatabaseView>) => Promise<void>;
  onCreateProperty: (
    input: NewPropertyInput,
    opts?: AddPropertyForViewListOptions,
  ) => Promise<string | undefined>;
}

const fieldClass = 'w-full rounded border border-border bg-background px-2 py-1.5 text-sm outline-hidden focus-visible:shadow-[var(--ring-control)]';

const MetadataInput: React.FC<{
  label: string;
  value: string | undefined;
  placeholder: string;
  onCommit: (value: string | undefined) => void;
}> = ({label, value, placeholder, onCommit}) => (
  <label className="block min-w-0">
    <span className="mb-1 block text-xs font-medium text-muted-foreground">{label}</span>
    <input
      key={value ?? ''}
      defaultValue={value ?? ''}
      placeholder={placeholder}
      onBlur={(event) => {
        const next = event.target.value.trim() || undefined;
        if (next !== value) onCommit(next);
      }}
      className={fieldClass}
    />
  </label>
);

const NewFieldDialog: React.FC<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: DatabaseFormProps['onCreateProperty'];
}> = ({open, onOpenChange, onCreate}) => {
  const {t} = useTranslation();
  const [name, setName] = useState('');
  const [type, setType] = useState<FormWritablePropertyType>('text');
  const [pageHidden, setPageHidden] = useState(false);
  const [creating, setCreating] = useState(false);

  const create = async (): Promise<void> => {
    if (creating || name.trim() === '') return;
    setCreating(true);
    try {
      const id = await onCreate({name, type}, {pageHidden});
      if (!id) return;
      setName('');
      setType('text');
      setPageHidden(false);
      onOpenChange(false);
    } finally {
      setCreating(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm" data-form-new-field-dialog>
        <DialogHeader>
          <DialogTitle>{t('database.formView.newFieldTitle')}</DialogTitle>
          <DialogDescription>{t('database.formView.builderIntro')}</DialogDescription>
        </DialogHeader>
        <label>
          <span className="mb-1 block text-sm font-medium">{t('database.formView.name')}</span>
          <input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => event.key === 'Enter' && void create()}
            placeholder={t('database.formView.namePlaceholder')}
            className={fieldClass}
          />
        </label>
        <label>
          <span className="mb-1 block text-sm font-medium">{t('database.formView.type')}</span>
          <Select value={type} onChange={(event) => setType(event.target.value as FormWritablePropertyType)} aria-label={t('database.formView.type')}>
            {FORM_PROPERTY_TYPES.map((propertyType) => (
              <option key={propertyType} value={propertyType}>{t(FORM_TYPE_KEY[propertyType])}</option>
            ))}
          </Select>
        </label>
        <div className="flex items-start justify-between gap-4 rounded-md border border-border bg-muted/20 p-3">
          <div>
            <div className="text-sm font-medium">{t('database.formView.formOnly')}</div>
            <div className="mt-0.5 text-xs text-muted-foreground">{t('database.formView.formOnlyHint')}</div>
          </div>
          <Switch checked={pageHidden} onCheckedChange={setPageHidden} aria-label={t('database.formView.formOnly')} />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
          <Button onClick={() => void create()} disabled={creating || name.trim() === ''}>{t('database.formView.create')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

const StaticFormProjection: React.FC<Pick<DatabaseFormProps, 'view' | 'properties'>> = ({view, properties}) => {
  const fields = projectDatabaseFormFields(properties, view).filter((field) => field.writable);
  return (
    <div className="mx-auto max-w-2xl rounded-xl border border-border bg-card p-6 shadow-sm" data-database-form-fill>
      <h2 className="text-xl font-semibold">{view.formConfig?.title?.trim() || view.name}</h2>
      {view.formConfig?.description && <p className="mt-2 whitespace-pre-wrap text-sm text-muted-foreground">{view.formConfig.description}</p>}
      <div className="mt-6 space-y-4">
        {fields.map((field) => (
          <div key={field.property.id} className="rounded-md border border-border bg-background px-3 py-2">
            <div className="text-sm font-medium">{field.label}{field.metadata.required && <span className="ml-1 text-destructive">*</span>}</div>
            {field.metadata.help && <div className="mt-1 text-xs text-muted-foreground">{field.metadata.help}</div>}
          </div>
        ))}
      </div>
    </div>
  );
};

const DatabaseFormBuilder: React.FC<DatabaseFormProps> = ({view, properties, onUpdateView, onCreateProperty}) => {
  const {t} = useTranslation();
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [newFieldOpen, setNewFieldOpen] = useState(false);
  const fields = projectDatabaseFormFields(properties, view);
  const mappedIds = new Set(view.visiblePropertyIds ?? []);
  const available = properties.filter((property) =>
    !mappedIds.has(property.id)
      && !property.id.startsWith('sys_')
      && isFormWritablePropertyType(property.type));

  const updateField = (propertyId: string, patch: Partial<DatabaseFormField>): void => {
    void onUpdateView({
      formFields: {
        ...(view.formFields ?? {}),
        [propertyId]: {...(view.formFields?.[propertyId] ?? {}), ...patch},
      },
    });
  };
  const addExisting = (propertyId: string): void => {
    void onUpdateView({
      visiblePropertyIds: [...(view.visiblePropertyIds ?? []), propertyId],
      formFields: {...(view.formFields ?? {}), [propertyId]: view.formFields?.[propertyId] ?? {}},
    });
  };
  const remove = (propertyId: string): void => {
    const formFields = {...(view.formFields ?? {})};
    delete formFields[propertyId];
    void onUpdateView({
      visiblePropertyIds: (view.visiblePropertyIds ?? []).filter((id) => id !== propertyId),
      formFields,
    });
  };
  const updateConfig = (patch: NonNullable<DatabaseView['formConfig']>): void => {
    void onUpdateView({formConfig: {...(view.formConfig ?? {}), ...patch}});
  };

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(16rem,22rem)]" data-database-form-builder>
      <section className="min-w-0 rounded-xl border border-border bg-card p-4 shadow-sm">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">{t('database.formView.fields')}</h2>
            <p className="mt-1 max-w-2xl text-xs text-muted-foreground">{t('database.formView.builderIntro')}</p>
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm"><Plus className="mr-1.5 h-4 w-4" />{t('database.formView.addField')}</Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
              <DropdownMenuLabel>{t('database.formView.existingFields')}</DropdownMenuLabel>
              {available.length === 0 ? (
                <DropdownMenuItem disabled>{t('database.formView.noAvailableColumns')}</DropdownMenuItem>
              ) : available.map((property) => (
                <DropdownMenuItem key={property.id} onSelect={() => addExisting(property.id)}>
                  <span className="min-w-0 flex-1 truncate">{property.name}</span>
                  <span className="ml-3 text-xs text-muted-foreground">{t(FORM_TYPE_KEY[property.type as FormWritablePropertyType])}</span>
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setNewFieldOpen(true)}>
                <Plus className="mr-2 h-4 w-4" />{t('database.formView.newField')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {fields.length === 0 && (
          <div className="rounded-md border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
            {t('database.formView.emptyFields')}
          </div>
        )}
        <div className="space-y-3">
          {fields.map(({property, metadata, writable}) => (
            <article
              key={property.id}
              draggable
              data-form-field-id={property.id}
              onDragStart={() => setDragId(property.id)}
              onDragEnd={() => {
                setDragId(null);
                setOverId(null);
              }}
              onDragOver={(event) => {
                if (dragId && dragId !== property.id) {
                  event.preventDefault();
                  setOverId(property.id);
                }
              }}
              onDrop={() => {
                if (dragId) void onUpdateView({visiblePropertyIds: reorderFormFieldIds(view.visiblePropertyIds ?? [], dragId, property.id)});
                setDragId(null);
                setOverId(null);
              }}
              className={cn(
                'rounded-lg border border-border bg-background p-3 transition-[opacity,box-shadow]',
                dragId === property.id && 'opacity-40',
                overId === property.id && dragId !== property.id && 'shadow-[var(--ring-control)]',
              )}
            >
              <div className="mb-3 flex items-start gap-2">
                <GripVertical className="mt-0.5 h-4 w-4 shrink-0 cursor-grab text-muted-foreground" aria-hidden />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{property.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {t('database.formView.fieldType', {type: FORM_TYPE_KEY[property.type as FormWritablePropertyType]
                      ? t(FORM_TYPE_KEY[property.type as FormWritablePropertyType])
                      : property.type})}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => remove(property.id)}
                  className="rounded p-1 text-muted-foreground transition-colors hover:bg-hover hover:text-destructive"
                  aria-label={`${t('database.formView.remove')}: ${property.name}`}
                  title={t('database.formView.removeHint')}
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
              {!writable && (
                <div className="mb-3 flex gap-2 rounded-md bg-amber-500/10 px-2.5 py-2 text-xs text-amber-800 dark:text-amber-200" role="status">
                  <AlertTriangle className="h-4 w-4 shrink-0" />
                  {t('database.formView.unsupported')}
                </div>
              )}
              <div className="grid gap-3 sm:grid-cols-2">
                <MetadataInput
                  label={t('database.formView.label')}
                  value={metadata.label}
                  placeholder={t('database.formView.labelPlaceholder', {name: property.name})}
                  onCommit={(label) => updateField(property.id, {label})}
                />
                <MetadataInput
                  label={t('database.formView.help')}
                  value={metadata.help}
                  placeholder={t('database.formView.helpPlaceholder')}
                  onCommit={(help) => updateField(property.id, {help})}
                />
                <MetadataInput
                  label={t('database.formView.placeholder')}
                  value={metadata.placeholder}
                  placeholder={t('database.formView.placeholderHint')}
                  onCommit={(placeholder) => updateField(property.id, {placeholder})}
                />
                <label className="flex items-center justify-between gap-4 rounded-md border border-border px-2.5 py-2 text-sm">
                  {t('database.formView.required')}
                  <Switch
                    checked={metadata.required === true}
                    onCheckedChange={(required) => updateField(property.id, {required})}
                    aria-label={`${t('database.formView.required')}: ${property.name}`}
                  />
                </label>
              </div>
              <div className="mt-2 text-xs text-muted-foreground">{t('database.formView.removeHint')}</div>
            </article>
          ))}
        </div>
      </section>

      <aside className="h-fit rounded-xl border border-border bg-card p-4 shadow-sm">
        <h2 className="text-base font-semibold">{t('database.formView.settings')}</h2>
        <div className="mt-4 space-y-3">
          <MetadataInput
            label={t('database.formView.title')}
            value={view.formConfig?.title}
            placeholder={t('database.formView.titlePlaceholder', {name: view.name})}
            onCommit={(title) => updateConfig({title})}
          />
          <MetadataInput
            label={t('database.formView.description')}
            value={view.formConfig?.description}
            placeholder={t('database.formView.descriptionPlaceholder')}
            onCommit={(description) => updateConfig({description})}
          />
          <MetadataInput
            label={t('database.formView.submitLabel')}
            value={view.formConfig?.submitLabel}
            placeholder={t('database.formView.submitLabelPlaceholder')}
            onCommit={(submitLabel) => updateConfig({submitLabel})}
          />
          <MetadataInput
            label={t('database.formView.confirmationMessage')}
            value={view.formConfig?.confirmationMessage}
            placeholder={t('database.formView.confirmationPlaceholder')}
            onCommit={(confirmationMessage) => updateConfig({confirmationMessage})}
          />
          <label className="flex items-center justify-between gap-4 rounded-md border border-border px-2.5 py-2 text-sm">
            {t('database.formView.acceptingResponses')}
            <Switch
              checked={view.formConfig?.acceptingResponses === true}
              onCheckedChange={(acceptingResponses) => updateConfig({acceptingResponses})}
              aria-label={t('database.formView.acceptingResponses')}
            />
          </label>
        </div>
      </aside>
      <NewFieldDialog open={newFieldOpen} onOpenChange={setNewFieldOpen} onCreate={onCreateProperty} />
    </div>
  );
};

export const DatabaseForm: React.FC<DatabaseFormProps> = (props) => {
  const {t} = useTranslation();
  const [mode, setMode] = useState<'builder' | 'fill'>(props.canEdit ? 'builder' : 'fill');
  return (
    <div className="space-y-4" data-database-form>
      {props.canEdit && (
        <div className="flex justify-center">
          <div className="inline-flex rounded-md bg-muted p-0.5" role="group">
            {(['builder', 'fill'] as const).map((next) => (
              <button
                key={next}
                type="button"
                onClick={() => setMode(next)}
                aria-pressed={mode === next}
                className={cn('rounded px-3 py-1 text-xs font-medium transition-colors', mode === next ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}
              >
                {t(next === 'builder' ? 'database.formView.builder' : 'database.formView.fill')}
              </button>
            ))}
          </div>
        </div>
      )}
      {mode === 'builder' && props.canEdit ? <DatabaseFormBuilder {...props} /> : <StaticFormProjection {...props} />}
    </div>
  );
};

export default DatabaseForm;
