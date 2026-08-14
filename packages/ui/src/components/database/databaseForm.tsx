import React, {useState} from 'react';
import {AlertTriangle, GripVertical, Plus, Trash2} from 'lucide-react';
import {
  isFormWritablePropertyType,
  TITLE_PROPERTY_ID,
  validateRowAgainstForm,
  type DatabaseFormField,
  type DatabaseFormFieldValidation,
  type DatabaseProperty,
  type DatabaseSelectOption,
  type DatabaseView,
  type FormRowValidationError,
  type FormRowValidationErrorCode,
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
import {PropertyValueCell} from './databaseCells';
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

const FORM_ERROR_KEY: Record<FormRowValidationErrorCode, TKey> = {
  view_type: 'database.formView.errors.viewType',
  unknown_field: 'database.formView.errors.unknownField',
  required: 'database.formView.errors.required',
  type: 'database.formView.errors.type',
  min: 'database.formView.errors.min',
  max: 'database.formView.errors.max',
  minLength: 'database.formView.errors.minLength',
  maxLength: 'database.formView.errors.maxLength',
  pattern: 'database.formView.errors.pattern',
  option: 'database.formView.errors.option',
  range: 'database.formView.errors.range',
  too_large: 'database.formView.errors.tooLarge',
  date_format: 'database.formView.errors.dateFormat',
  email_format: 'database.formView.errors.emailFormat',
  url_format: 'database.formView.errors.urlFormat',
  phone_format: 'database.formView.errors.phoneFormat',
};

export interface ProjectedDatabaseFormField {
  property: DatabaseProperty;
  metadata: DatabaseFormField;
  writable: boolean;
  label: string;
}

const titleProperty = (name: string): DatabaseProperty => ({
  id: TITLE_PROPERTY_ID,
  name,
  type: 'text',
});

/** Resolve form mappings against the current property schema. Names and types
 *  are intentionally read now, never copied into form metadata. */
export function projectDatabaseFormFields(
  properties: readonly DatabaseProperty[],
  view: DatabaseView,
  titleLabel = 'Title',
): ProjectedDatabaseFormField[] {
  const byId = new Map(properties.map((property) => [property.id, property]));
  return (view.visiblePropertyIds ?? []).flatMap((propertyId) => {
    const property = propertyId === TITLE_PROPERTY_ID ? titleProperty(titleLabel) : byId.get(propertyId);
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
  onAddOption: (propertyId: string, label: string) => Promise<DatabaseSelectOption | null>;
  onSubmit: (fields: Record<string, unknown>, name?: string) => Promise<string | undefined>;
}

const fieldClass = 'w-full rounded border border-border bg-background px-2 py-1.5 text-sm outline-hidden focus-visible:shadow-[var(--ring-field)]';

const MetadataInput: React.FC<{
  label: string;
  value: string | undefined;
  placeholder: string;
  onCommit: (value: string | undefined) => void;
  trim?: boolean;
}> = ({label, value, placeholder, onCommit, trim = true}) => (
  <label className="block min-w-0">
    <span className="mb-1 block text-xs font-medium text-muted-foreground">{label}</span>
    <input
      key={value ?? ''}
      defaultValue={value ?? ''}
      placeholder={placeholder}
      onBlur={(event) => {
        const raw = event.target.value;
        const next = (trim ? raw.trim() : raw) || undefined;
        if (next !== value) onCommit(next);
      }}
      className={fieldClass}
    />
  </label>
);

const NumberMetadataInput: React.FC<{
  label: string;
  value: number | undefined;
  placeholder?: string;
  min?: number;
  integer?: boolean;
  onCommit: (value: number | undefined) => void;
}> = ({label, value, placeholder, min, integer = false, onCommit}) => (
  <label className="block min-w-0">
    <span className="mb-1 block text-xs font-medium text-muted-foreground">{label}</span>
    <input
      key={value ?? ''}
      type="number"
      defaultValue={value ?? ''}
      placeholder={placeholder}
      min={min}
      step={integer ? 1 : 'any'}
      onBlur={(event) => {
        const raw = event.target.value.trim();
        const parsed = raw === '' ? undefined : Number(raw);
        const next = parsed === undefined || !Number.isFinite(parsed)
          ? undefined
          : integer
            ? Math.trunc(parsed)
            : parsed;
        if (next !== value) onCommit(next);
      }}
      className={fieldClass}
    />
  </label>
);

/** Accept only browser-safe HTTP(S) destinations, including relative URLs. */
export function safeFormRedirectUrl(raw: string | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  try {
    const currentOrigin = typeof window === 'undefined' ? '' : window.location.origin;
    const base = currentOrigin && currentOrigin !== 'null' ? currentOrigin : 'https://openbook.local';
    const parsed = new URL(value, base);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    if (/^[a-z][a-z\d+.-]*:/i.test(value) || value.startsWith('//')) return parsed.href;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return null;
  }
}

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
  const [createError, setCreateError] = useState(false);
  const changeOpen = (next: boolean): void => {
    if (!next) setCreateError(false);
    onOpenChange(next);
  };

  const create = async (): Promise<void> => {
    if (creating || name.trim() === '') return;
    setCreateError(false);
    setCreating(true);
    try {
      const id = await onCreate({name, type}, {pageHidden});
      if (!id) {
        setCreateError(true);
        return;
      }
      setName('');
      setType('text');
      setPageHidden(false);
      changeOpen(false);
    } finally {
      setCreating(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent size="sm" data-form-new-field-dialog>
        <DialogHeader>
          <DialogTitle>{t('database.formView.newFieldTitle')}</DialogTitle>
          <DialogDescription>{t('database.formView.newFieldDescription')}</DialogDescription>
        </DialogHeader>
        <label>
          <span className="mb-1 block text-sm font-medium">{t('database.formView.name')}</span>
          <input
            autoFocus
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              setCreateError(false);
            }}
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
        {createError && (
          <p className="text-sm text-destructive" role="alert">{t('database.formView.newFieldError')}</p>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={() => changeOpen(false)}>{t('common.cancel')}</Button>
          <Button onClick={() => void create()} disabled={creating || name.trim() === ''}>{t('database.formView.create')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

const DatabaseFormFill: React.FC<Pick<DatabaseFormProps, 'view' | 'properties' | 'onAddOption' | 'onSubmit'>> = ({
  view,
  properties,
  onAddOption,
  onSubmit,
}) => {
  const {t} = useTranslation();
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [errors, setErrors] = useState<FormRowValidationError[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [instance, setInstance] = useState(0);
  const fields = projectDatabaseFormFields(properties, view, t('database.formView.rowTitle')).filter((field) => field.writable);
  const errorsByProperty = new Map(errors.filter((error) => error.propertyId).map((error) => [error.propertyId, error]));
  const globalError = errors.find((error) => error.propertyId === '');

  const updateValue = (propertyId: string, value: unknown): void => {
    setValues((current) => ({...current, [propertyId]: value}));
    setErrors((current) => current.filter((error) => error.propertyId !== propertyId));
    setSubmitError(false);
  };
  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (submitting) return;
    const result = validateRowAgainstForm({properties, views: [view]}, view, values);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setErrors([]);
    setSubmitError(false);
    setSubmitting(true);
    try {
      const rowId = await onSubmit(result.fields, result.name);
      if (!rowId) {
        setSubmitError(true);
        return;
      }
      setConfirmed(true);
    } catch {
      setSubmitError(true);
    } finally {
      setSubmitting(false);
    }
  };
  const restart = (): void => {
    setValues({});
    setErrors([]);
    setSubmitError(false);
    setConfirmed(false);
    setInstance((current) => current + 1);
  };

  if (view.formConfig?.acceptingResponses !== true) {
    return (
      <div className="mx-auto max-w-2xl rounded-xl border border-border bg-card p-6 text-center shadow-sm" data-database-form-closed>
        <h2 className="text-xl font-semibold">{view.formConfig?.title?.trim() || view.name}</h2>
        <p className="mt-3 whitespace-pre-wrap text-sm text-muted-foreground">
          {view.formConfig?.closedMessage?.trim() || t('database.formView.closed')}
        </p>
      </div>
    );
  }

  if (confirmed) {
    const confirmation = view.formConfig?.confirmation;
    const redirectUrl = confirmation?.type === 'redirect'
      ? safeFormRedirectUrl(confirmation.redirectUrl)
      : null;
    return (
      <div className="mx-auto max-w-2xl rounded-xl border border-border bg-card p-6 text-center shadow-sm" data-database-form-confirmation role="status">
        {redirectUrl ? (
          <Button asChild data-form-confirmation-redirect>
            <a href={redirectUrl} rel="noopener noreferrer">{t('database.formView.continue')}</a>
          </Button>
        ) : (
          <>
            <p className="whitespace-pre-wrap text-base">
              {confirmation?.type === 'message' && confirmation.message.trim()
                ? confirmation.message.trim()
                : t('database.formView.defaultConfirmation')}
            </p>
            <Button className="mt-5" variant="outline" onClick={restart}>{t('database.formView.submitAnother')}</Button>
          </>
        )}
      </div>
    );
  }

  return (
    <form className="mx-auto max-w-2xl rounded-xl border border-border bg-card p-6 shadow-sm" data-database-form-fill onSubmit={(event) => void submit(event)} noValidate>
      <h2 className="text-xl font-semibold">{view.formConfig?.title?.trim() || view.name}</h2>
      {view.formConfig?.description && <p className="mt-2 whitespace-pre-wrap text-sm text-muted-foreground">{view.formConfig.description}</p>}
      <div className="mt-6 space-y-5">
        {fields.map(({property, metadata, label}) => {
          const error = errorsByProperty.get(property.id);
          const accessibleLabel = metadata.required
            ? `${label} (${t('database.formView.required').toLocaleLowerCase()})`
            : label;
          const inputProperty = accessibleLabel === property.name ? property : {...property, name: accessibleLabel};
          const describedBy = [
            metadata.help ? `${property.id}-help` : null,
            error ? `${property.id}-error` : null,
          ].filter(Boolean).join(' ') || undefined;
          const common = {
            'aria-label': accessibleLabel,
            'aria-invalid': Boolean(error) || undefined,
            'aria-describedby': describedBy,
            'aria-required': metadata.required || undefined,
          };
          return (
            <div key={`${instance}:${property.id}:${property.type}`} className="block" data-form-input={property.id}>
              <span className="text-sm font-medium">
                {label}
                {metadata.required && <span className="ml-1 text-destructive" aria-hidden>*</span>}
              </span>
              {metadata.help && <span id={`${property.id}-help`} className="mt-1 block text-xs text-muted-foreground">{metadata.help}</span>}
              <span className={cn('group mt-2 block min-h-9 overflow-visible rounded-md border bg-background', error ? 'border-destructive' : 'border-border')}>
                {property.type === 'text' && metadata.multiline ? (
                  <textarea
                    defaultValue={typeof values[property.id] === 'string' ? values[property.id] as string : ''}
                    placeholder={metadata.placeholder}
                    onBlur={(event) => updateValue(property.id, event.target.value)}
                    className="min-h-24 w-full resize-y bg-transparent px-2 py-1.5 text-sm outline-hidden"
                    {...common}
                  />
                ) : (
                  <PropertyValueCell
                    property={inputProperty}
                    value={values[property.id]}
                    placeholder={metadata.placeholder}
                    onChange={(value) => updateValue(property.id, value)}
                    onAddOption={(optionLabel) => onAddOption(property.id, optionLabel)}
                    controlProps={common}
                  />
                )}
              </span>
              {error && <span id={`${property.id}-error`} className="mt-1 block text-xs text-destructive" role="alert">{t(FORM_ERROR_KEY[error.code])}</span>}
            </div>
          );
        })}
      </div>
      {(errors.length > 0 || submitError) && (
        <div className="mt-5 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">
          {submitError
            ? t('database.formView.submitError')
            : globalError
              ? t(FORM_ERROR_KEY[globalError.code])
              : t('database.formView.validationSummary')}
        </div>
      )}
      <Button className="mt-6" type="submit" disabled={submitting}>
        {submitting
          ? t('database.formView.submitting')
          : view.formConfig?.submitLabel?.trim() || t('database.formView.submit')}
      </Button>
    </form>
  );
};

const DatabaseFormBuilder: React.FC<DatabaseFormProps> = ({view, properties, onUpdateView, onCreateProperty}) => {
  const {t} = useTranslation();
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [newFieldOpen, setNewFieldOpen] = useState(false);
  const rowTitle = titleProperty(t('database.formView.rowTitle'));
  const fields = projectDatabaseFormFields(properties, view, rowTitle.name);
  const mappedIds = new Set(view.visiblePropertyIds ?? []);
  const available = [
    ...(mappedIds.has(TITLE_PROPERTY_ID) ? [] : [rowTitle]),
    ...properties.filter((property) =>
      !mappedIds.has(property.id)
        && !property.id.startsWith('sys_')
        && isFormWritablePropertyType(property.type)),
  ];

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
  const updateValidation = (
    propertyId: string,
    key: keyof DatabaseFormFieldValidation,
    value: number | string | undefined,
  ): void => {
    const validation = {...(view.formFields?.[propertyId]?.validation ?? {})};
    if (value === undefined) delete validation[key];
    else Object.assign(validation, {[key]: value});
    updateField(propertyId, {validation: Object.keys(validation).length > 0 ? validation : undefined});
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
          {fields.map(({property, metadata, writable}) => {
            const hasNumericValidation = property.type === 'number' || property.type === 'rating';
            const hasLengthValidation = ['text', 'url', 'email', 'phone', 'multi_select', 'files'].includes(property.type);
            const hasPatternValidation = ['text', 'url', 'email', 'phone'].includes(property.type);
            return (
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
                  <div className="mb-3 flex gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-2 text-xs text-foreground" role="note">
                    <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
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
                  {property.type === 'text' && (
                    <label className="flex items-center justify-between gap-4 rounded-md border border-border px-2.5 py-2 text-sm">
                      {t('database.formView.multiline')}
                      <Switch
                        checked={metadata.multiline === true}
                        onCheckedChange={(multiline) => updateField(property.id, {multiline})}
                        aria-label={`${t('database.formView.multiline')}: ${property.name}`}
                      />
                    </label>
                  )}
                </div>
                {(hasNumericValidation || hasLengthValidation || hasPatternValidation) && (
                  <div className="mt-3 rounded-md border border-border p-3">
                    <div className="mb-2 text-xs font-medium text-muted-foreground">{t('database.formView.validation')}</div>
                    <div className="grid gap-3 sm:grid-cols-2">
                      {hasNumericValidation && (
                        <>
                          <NumberMetadataInput
                            label={t('database.formView.minimum')}
                            value={metadata.validation?.min}
                            onCommit={(value) => updateValidation(property.id, 'min', value)}
                          />
                          <NumberMetadataInput
                            label={t('database.formView.maximum')}
                            value={metadata.validation?.max}
                            onCommit={(value) => updateValidation(property.id, 'max', value)}
                          />
                        </>
                      )}
                      {hasLengthValidation && (
                        <>
                          <NumberMetadataInput
                            label={t('database.formView.minimumLength')}
                            value={metadata.validation?.minLength}
                            min={0}
                            integer
                            onCommit={(value) => updateValidation(property.id, 'minLength', value)}
                          />
                          <NumberMetadataInput
                            label={t('database.formView.maximumLength')}
                            value={metadata.validation?.maxLength}
                            min={0}
                            integer
                            onCommit={(value) => updateValidation(property.id, 'maxLength', value)}
                          />
                        </>
                      )}
                      {hasPatternValidation && (
                        <MetadataInput
                          label={t('database.formView.pattern')}
                          value={metadata.validation?.pattern}
                          placeholder={t('database.formView.patternPlaceholder')}
                          trim={false}
                          onCommit={(value) => updateValidation(property.id, 'pattern', value)}
                        />
                      )}
                    </div>
                  </div>
                )}
              </article>
            );
          })}
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
          <label className="block min-w-0">
            <span className="mb-1 block text-xs font-medium text-muted-foreground">{t('database.formView.confirmationType')}</span>
            <Select
              value={view.formConfig?.confirmation?.type ?? 'message'}
              onChange={(event) => updateConfig({confirmation: event.target.value === 'redirect'
                ? {type: 'redirect', redirectUrl: ''}
                : {type: 'message', message: ''}})}
              aria-label={t('database.formView.confirmationType')}
            >
              <option value="message">{t('database.formView.confirmationMessageOption')}</option>
              <option value="redirect">{t('database.formView.confirmationRedirectOption')}</option>
            </Select>
          </label>
          {view.formConfig?.confirmation?.type === 'redirect' ? (
            <MetadataInput
              label={t('database.formView.confirmationRedirectUrl')}
              value={view.formConfig.confirmation.redirectUrl}
              placeholder={t('database.formView.confirmationRedirectPlaceholder')}
              onCommit={(redirectUrl) => updateConfig({confirmation: {type: 'redirect', redirectUrl: redirectUrl ?? ''}})}
            />
          ) : (
            <MetadataInput
              label={t('database.formView.confirmationMessage')}
              value={view.formConfig?.confirmation?.type === 'message' ? view.formConfig.confirmation.message : undefined}
              placeholder={t('database.formView.confirmationPlaceholder')}
              onCommit={(message) => updateConfig({confirmation: {type: 'message', message: message ?? ''}})}
            />
          )}
          <MetadataInput
            label={t('database.formView.closedMessage')}
            value={view.formConfig?.closedMessage}
            placeholder={t('database.formView.closedMessagePlaceholder')}
            onCommit={(closedMessage) => updateConfig({closedMessage})}
          />
          <NumberMetadataInput
            label={t('database.formView.maxResponses')}
            value={view.formConfig?.maxResponses}
            placeholder={t('database.formView.maxResponsesPlaceholder')}
            min={1}
            integer
            onCommit={(maxResponses) => updateConfig({maxResponses})}
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
  if (!props.canEdit) {
    return (
      <div className="space-y-4" data-database-form>
        <div className="mx-auto max-w-2xl rounded-xl border border-border bg-card p-6 text-center shadow-sm" data-database-form-readonly role="note">
          <h2 className="text-xl font-semibold">{props.view.formConfig?.title?.trim() || props.view.name}</h2>
          <p className="mt-3 text-sm text-muted-foreground">{t('database.formView.noSubmitAccess')}</p>
        </div>
      </div>
    );
  }
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
      {mode === 'builder' && props.canEdit ? <DatabaseFormBuilder {...props} /> : <DatabaseFormFill {...props} />}
    </div>
  );
};

export default DatabaseForm;
