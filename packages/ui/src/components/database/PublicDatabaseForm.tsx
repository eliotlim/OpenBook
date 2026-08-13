import React, {useEffect, useMemo, useRef, useState} from 'react';
import {
  DatabaseFormRequestError,
  FORM_UPLOAD_MAX_FILES,
  generateSubmissionKey,
  safeFormRedirectUrl,
  type DataClient,
  type DatabaseFormDescriptor,
  type DatabaseFormDescriptorField,
  type FormSubmissionResult,
} from '@book.dev/sdk';
import {Button} from '@/components/ui/button';
import type {TKey} from '@/i18n';
import {cn} from '@/lib/utils';
import {useTranslation} from '@/providers';

type PublicFormClient = Pick<
  DataClient,
  'getPublicDatabaseForm' | 'submitDatabaseForm' | 'uploadDatabaseFormFile'
>;

export interface PublicDatabaseFormProps {
  client: PublicFormClient;
  databaseId: string;
  viewId: string;
  capability: string;
}

type SurfaceState = 'loading' | 'form' | 'success' | 'not-found' | 'exhausted' | 'error';
type PublicError = {propertyId: string; code: string};

const ERROR_KEYS: Record<string, TKey> = {
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

const inputClass = 'mt-2 w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-hidden focus-visible:shadow-[var(--ring-control)]';

function newIdempotencyKey(): string {
  return generateSubmissionKey();
}

function initialRequiredErrors(
  fields: readonly DatabaseFormDescriptorField[],
  values: Readonly<Record<string, unknown>>,
  files: Readonly<Record<string, File[]>>,
): PublicError[] {
  return fields.flatMap((field) => {
    if (!field.required) return [];
    const value = field.type === 'files' ? files[field.propertyId] : values[field.propertyId];
    const empty = value === undefined
      || value === null
      || (typeof value === 'string' && value.trim() === '')
      || (Array.isArray(value) && value.length === 0)
      || (field.type === 'date' && field.dateRange && typeof value === 'object'
        && value !== null && !('start' in value && Boolean((value as {start?: unknown}).start)));
    return empty ? [{propertyId: field.propertyId, code: 'required'}] : [];
  });
}

const PublicField: React.FC<{
  field: DatabaseFormDescriptorField;
  value: unknown;
  files: File[];
  error?: PublicError;
  onChange: (value: unknown) => void;
  onFiles: (files: File[]) => void;
}> = ({field, value, files, error, onChange, onFiles}) => {
  const {t} = useTranslation();
  const describedBy = [
    field.help ? `${field.propertyId}-help` : null,
    error ? `${field.propertyId}-error` : null,
  ].filter(Boolean).join(' ') || undefined;
  const common = {
    'aria-label': field.label,
    'aria-invalid': Boolean(error) || undefined,
    'aria-describedby': describedBy,
    'aria-required': field.required || undefined,
  };

  let control: React.ReactNode;
  switch (field.type) {
  case 'text':
    control = field.multiline ? (
      <textarea
        {...common}
        value={typeof value === 'string' ? value : ''}
        onChange={(event) => onChange(event.target.value)}
        placeholder={field.placeholder}
        minLength={field.validation?.minLength}
        maxLength={field.validation?.maxLength}
        className={cn(inputClass, 'min-h-28 resize-y', error && 'border-destructive')}
      />
    ) : (
      <input
        {...common}
        type="text"
        value={typeof value === 'string' ? value : ''}
        onChange={(event) => onChange(event.target.value)}
        placeholder={field.placeholder}
        minLength={field.validation?.minLength}
        maxLength={field.validation?.maxLength}
        className={cn(inputClass, error && 'border-destructive')}
      />
    );
    break;
  case 'number':
    control = (
      <input
        {...common}
        type="number"
        value={typeof value === 'number' ? value : ''}
        onChange={(event) => onChange(event.target.value === '' ? undefined : Number(event.target.value))}
        placeholder={field.placeholder}
        min={field.validation?.min}
        max={field.validation?.max}
        className={cn(inputClass, error && 'border-destructive')}
      />
    );
    break;
  case 'rating': {
    const max = field.numberTarget && field.numberTarget > 0 ? Math.min(10, Math.round(field.numberTarget)) : 5;
    const current = typeof value === 'number' ? value : 0;
    control = (
      <div {...common} className="mt-2 flex gap-1" role="group">
        {Array.from({length: max}, (_, index) => index + 1).map((rating) => (
          <button
            key={rating}
            type="button"
            onClick={() => onChange(current === rating ? undefined : rating)}
            aria-label={t('database.publicForm.rating', {rating})}
            aria-pressed={rating <= current}
            className={cn('text-2xl transition-colors', rating <= current ? 'text-amber-400' : 'text-muted-foreground/30')}
          >
            ★
          </button>
        ))}
      </div>
    );
    break;
  }
  case 'select':
  case 'status':
    control = (
      <select
        {...common}
        value={typeof value === 'string' ? value : ''}
        onChange={(event) => onChange(event.target.value || undefined)}
        className={cn(inputClass, error && 'border-destructive')}
      >
        <option value="">{field.placeholder || t('database.publicForm.choose')}</option>
        {(field.options ?? []).map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
      </select>
    );
    break;
  case 'multi_select': {
    const selected = Array.isArray(value) ? value as string[] : [];
    control = (
      <div {...common} className={cn('mt-2 space-y-1 rounded-md border border-border p-2', error && 'border-destructive')} role="group">
        {(field.options ?? []).map((option) => (
          <label key={option.id} className="flex items-center gap-2 rounded px-1 py-1.5 text-sm hover:bg-hover">
            <input
              type="checkbox"
              checked={selected.includes(option.id)}
              onChange={(event) => onChange(event.target.checked
                ? [...selected, option.id]
                : selected.filter((id) => id !== option.id))}
              className="h-4 w-4 accent-primary"
            />
            {option.label}
          </label>
        ))}
      </div>
    );
    break;
  }
  case 'checkbox':
    control = (
      <label className={cn('mt-2 flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm', error && 'border-destructive')}>
        <input
          {...common}
          type="checkbox"
          checked={value === true}
          onChange={(event) => onChange(event.target.checked)}
          className="h-4 w-4 accent-primary"
        />
        {t('database.publicForm.checkboxLabel')}
      </label>
    );
    break;
  case 'date': {
    const range = value && typeof value === 'object' ? value as {start?: string; end?: string} : {};
    const dateType = field.includeTime ? 'datetime-local' : 'date';
    control = field.dateRange ? (
      <div {...common} className="mt-2 grid gap-2 sm:grid-cols-2" role="group">
        <input
          {...common}
          type={dateType}
          value={range.start ?? ''}
          onChange={(event) => onChange({start: event.target.value, ...(range.end ? {end: range.end} : {})})}
          className={cn(inputClass, 'mt-0', error && 'border-destructive')}
        />
        <input
          aria-label={t('database.publicForm.endDate', {label: field.label})}
          type={dateType}
          value={range.end ?? ''}
          onChange={(event) => onChange({...(range.start ? {start: range.start} : {}), end: event.target.value})}
          className={cn(inputClass, 'mt-0', error && 'border-destructive')}
        />
      </div>
    ) : (
      <input
        {...common}
        type={dateType}
        value={typeof value === 'string' ? value : ''}
        onChange={(event) => onChange(event.target.value || undefined)}
        className={cn(inputClass, error && 'border-destructive')}
      />
    );
    break;
  }
  case 'url':
  case 'email':
  case 'phone':
    control = (
      <input
        {...common}
        type={field.type === 'url' ? 'url' : field.type === 'email' ? 'email' : 'tel'}
        value={typeof value === 'string' ? value : ''}
        onChange={(event) => onChange(event.target.value)}
        placeholder={field.placeholder}
        minLength={field.validation?.minLength}
        maxLength={field.validation?.maxLength}
        className={cn(inputClass, error && 'border-destructive')}
      />
    );
    break;
  case 'location': {
    const location = value && typeof value === 'object'
      ? value as {lat?: number; lng?: number; label?: string; address?: string}
      : {};
    const setLocation = (patch: Partial<typeof location>) => onChange({...location, ...patch});
    control = (
      <div {...common} className="mt-2 grid gap-2 sm:grid-cols-2" role="group">
        <input
          type="number"
          step="any"
          value={location.lat ?? ''}
          onChange={(event) => setLocation({lat: event.target.value === '' ? undefined : Number(event.target.value)})}
          placeholder={t('database.publicForm.latitude')}
          aria-label={`${field.label}: ${t('database.publicForm.latitude')}`}
          className={cn(inputClass, 'mt-0', error && 'border-destructive')}
        />
        <input
          type="number"
          step="any"
          value={location.lng ?? ''}
          onChange={(event) => setLocation({lng: event.target.value === '' ? undefined : Number(event.target.value)})}
          placeholder={t('database.publicForm.longitude')}
          aria-label={`${field.label}: ${t('database.publicForm.longitude')}`}
          className={cn(inputClass, 'mt-0', error && 'border-destructive')}
        />
        <input
          type="text"
          value={location.label ?? ''}
          onChange={(event) => setLocation({label: event.target.value})}
          placeholder={t('database.publicForm.locationLabel')}
          aria-label={`${field.label}: ${t('database.publicForm.locationLabel')}`}
          className={cn(inputClass, 'mt-0', error && 'border-destructive')}
        />
        <input
          type="text"
          value={location.address ?? ''}
          onChange={(event) => setLocation({address: event.target.value})}
          placeholder={t('database.publicForm.address')}
          aria-label={`${field.label}: ${t('database.publicForm.address')}`}
          className={cn(inputClass, 'mt-0', error && 'border-destructive')}
        />
      </div>
    );
    break;
  }
  case 'files':
    control = (
      <div className={cn('mt-2 rounded-md border border-border p-3', error && 'border-destructive')}>
        <input
          {...common}
          type="file"
          multiple
          onChange={(event) => onFiles(Array.from(event.target.files ?? []).slice(0, FORM_UPLOAD_MAX_FILES))}
          className="block w-full text-sm file:mr-3 file:rounded file:border-0 file:bg-muted file:px-3 file:py-1.5 file:text-sm"
        />
        {files.length > 0 && (
          <p className="mt-2 text-xs text-muted-foreground">
            {t('database.publicForm.filesSelected', {count: files.length})}
          </p>
        )}
      </div>
    );
    break;
  }

  return (
    <div data-public-form-field={field.propertyId}>
      <div className="text-sm font-medium">
        {field.label}{field.required && <span className="ml-1 text-destructive" aria-hidden>*</span>}
      </div>
      {field.help && <p id={`${field.propertyId}-help`} className="mt-1 text-xs text-muted-foreground">{field.help}</p>}
      {control}
      {error && (
        <p id={`${field.propertyId}-error`} className="mt-1 text-xs text-destructive" role="alert">
          {t(ERROR_KEYS[error.code] ?? 'database.formView.errors.type')}
        </p>
      )}
    </div>
  );
};

export const PublicDatabaseForm: React.FC<PublicDatabaseFormProps> = ({
  client,
  databaseId,
  viewId,
  capability,
}) => {
  const {t} = useTranslation();
  const [descriptor, setDescriptor] = useState<DatabaseFormDescriptor | null>(null);
  const [surface, setSurface] = useState<SurfaceState>('loading');
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [files, setFiles] = useState<Record<string, File[]>>({});
  const [uploadedTokens, setUploadedTokens] = useState<Record<string, string[]>>({});
  const [errors, setErrors] = useState<PublicError[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [serverMessage, setServerMessage] = useState<TKey | null>(null);
  const [confirmation, setConfirmation] = useState<FormSubmissionResult['confirmation']>();
  const idempotencyKey = useRef<string | null>(null);

  const load = async (): Promise<DatabaseFormDescriptor> => {
    if (!client.getPublicDatabaseForm) throw new DatabaseFormRequestError(404, 'form not found');
    return client.getPublicDatabaseForm(databaseId, viewId, {capability});
  };

  useEffect(() => {
    let cancelled = false;
    setSurface('loading');
    void load()
      .then((next) => {
        if (cancelled) return;
        setDescriptor(next);
        setSurface('form');
      })
      .catch((error) => {
        if (cancelled) return;
        setSurface(error instanceof DatabaseFormRequestError && error.status === 404 ? 'not-found' : 'error');
      });
    return () => {
      cancelled = true;
    };
  }, [client, databaseId, viewId, capability]);

  const errorsByField = useMemo(() => new Map(errors.map((error) => [error.propertyId, error])), [errors]);
  const update = (propertyId: string, value: unknown): void => {
    setValues((current) => ({...current, [propertyId]: value}));
    setErrors((current) => current.filter((error) => error.propertyId !== propertyId));
    setServerMessage(null);
  };
  const updateFiles = (propertyId: string, next: File[]): void => {
    setFiles((current) => ({...current, [propertyId]: next}));
    setUploadedTokens((current) => {
      const copy = {...current};
      delete copy[propertyId];
      return copy;
    });
    setErrors((current) => current.filter((error) => error.propertyId !== propertyId));
  };

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (!descriptor || submitting || !descriptor.acceptingResponses) return;
    const requiredErrors = initialRequiredErrors(descriptor.fields, values, files);
    if (requiredErrors.length > 0) {
      setErrors(requiredErrors);
      return;
    }
    if (!client.submitDatabaseForm) {
      setSurface('error');
      return;
    }
    setSubmitting(true);
    setServerMessage(null);
    setErrors([]);
    const key = idempotencyKey.current ?? newIdempotencyKey();
    idempotencyKey.current = key;
    try {
      const fields = {...values};
      for (const field of descriptor.fields) {
        if (field.type === 'checkbox') fields[field.propertyId] = values[field.propertyId] === true;
        if (field.type !== 'files') continue;
        let tokens = uploadedTokens[field.propertyId];
        if (!tokens && (files[field.propertyId]?.length ?? 0) > 0) {
          if (!client.uploadDatabaseFormFile) throw new DatabaseFormRequestError(500, 'uploads unavailable');
          tokens = [];
          for (const file of files[field.propertyId]) {
            const uploaded = await client.uploadDatabaseFormFile(databaseId, viewId, {
              capability,
              fieldId: field.propertyId,
              name: file.name,
              mime: file.type || 'application/octet-stream',
              bytes: new Uint8Array(await file.arrayBuffer()),
            });
            tokens.push(uploaded.token);
          }
          setUploadedTokens((current) => ({...current, [field.propertyId]: tokens!}));
        }
        if (tokens && tokens.length > 0) fields[field.propertyId] = tokens;
      }
      const result = await client.submitDatabaseForm(databaseId, viewId, {capability, fields, idempotencyKey: key});
      setConfirmation(result.confirmation);
      setSurface('success');
    } catch (error) {
      if (!(error instanceof DatabaseFormRequestError)) {
        setServerMessage('database.publicForm.submitError');
      } else if (error.status === 404) {
        setSurface('not-found');
      } else if (error.status === 403 && error.code === 'form_closed') {
        try {
          setDescriptor(await load());
          setSurface('form');
        } catch {
          setSurface('not-found');
        }
      } else if (error.status === 429 && error.code === 'response limit reached') {
        setSurface('exhausted');
      } else if (error.status === 429) {
        setServerMessage('database.publicForm.rateLimited');
      } else if (error.status === 413) {
        setServerMessage('database.publicForm.tooLarge');
      } else if (error.errors.length > 0) {
        setErrors(error.errors);
        if (error.errors.some((item) => item.code === 'unknown_field')) {
          try {
            setDescriptor(await load());
          } catch {
            setSurface('not-found');
          }
        }
      } else {
        setServerMessage('database.publicForm.submitError');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const restart = (): void => {
    setValues({});
    setFiles({});
    setUploadedTokens({});
    setErrors([]);
    setServerMessage(null);
    setConfirmation(undefined);
    idempotencyKey.current = null;
    setSurface('form');
  };

  const confirmationRedirect = confirmation?.type === 'redirect' && typeof confirmation.redirectUrl === 'string'
    ? safeFormRedirectUrl(confirmation.redirectUrl)
    : null;

  return (
    <main className="min-h-screen bg-background px-4 py-10 text-foreground sm:px-6" data-public-database-form-surface>
      {surface === 'loading' && (
        <div className="mx-auto max-w-2xl py-16 text-center text-sm text-muted-foreground" role="status">
          {t('database.publicForm.loading')}
        </div>
      )}
      {surface === 'not-found' && (
        <section className="mx-auto max-w-lg rounded-xl border border-border bg-card p-8 text-center shadow-sm" data-public-form-not-found>
          <h1 className="text-xl font-semibold">{t('database.publicForm.notFoundTitle')}</h1>
          <p className="mt-3 text-sm text-muted-foreground">{t('database.publicForm.notFoundDescription')}</p>
        </section>
      )}
      {surface === 'error' && (
        <section className="mx-auto max-w-lg rounded-xl border border-border bg-card p-8 text-center shadow-sm" role="alert">
          <h1 className="text-xl font-semibold">{t('database.publicForm.unavailableTitle')}</h1>
          <p className="mt-3 text-sm text-muted-foreground">{t('database.publicForm.unavailableDescription')}</p>
        </section>
      )}
      {surface === 'exhausted' && (
        <section className="mx-auto max-w-lg rounded-xl border border-border bg-card p-8 text-center shadow-sm" data-public-form-exhausted>
          <h1 className="text-xl font-semibold">{descriptor?.title || t('database.publicForm.responseLimitTitle')}</h1>
          <p className="mt-3 text-sm text-muted-foreground">{t('database.publicForm.responseLimitDescription')}</p>
        </section>
      )}
      {surface === 'success' && descriptor && (
        <section className="mx-auto max-w-2xl rounded-xl border border-border bg-card p-8 text-center shadow-sm" data-public-form-confirmation role="status">
          {confirmationRedirect ? (
            <Button asChild data-form-confirmation-redirect>
              <a href={confirmationRedirect} rel="noopener noreferrer">{t('database.formView.continue')}</a>
            </Button>
          ) : (
            <>
              <p className="whitespace-pre-wrap text-base">
                {confirmation?.type === 'message' && typeof confirmation.message === 'string' && confirmation.message.trim()
                  ? confirmation.message.trim()
                  : t('database.formView.defaultConfirmation')}
              </p>
              <Button className="mt-5" variant="outline" onClick={restart}>{t('database.formView.submitAnother')}</Button>
            </>
          )}
        </section>
      )}
      {surface === 'form' && descriptor && !descriptor.acceptingResponses && (
        <section className="mx-auto max-w-2xl rounded-xl border border-border bg-card p-8 text-center shadow-sm" data-public-form-closed>
          <h1 className="text-xl font-semibold">{descriptor.title}</h1>
          <p className="mt-3 whitespace-pre-wrap text-sm text-muted-foreground">
            {descriptor.closedMessage || t('database.formView.closed')}
          </p>
        </section>
      )}
      {surface === 'form' && descriptor?.acceptingResponses && (
        <form className="mx-auto max-w-2xl rounded-xl border border-border bg-card p-6 shadow-sm sm:p-8" onSubmit={(event) => void submit(event)} noValidate data-public-form>
          <h1 className="text-2xl font-semibold">{descriptor.title}</h1>
          {descriptor.description && <p className="mt-2 whitespace-pre-wrap text-sm text-muted-foreground">{descriptor.description}</p>}
          <div className="mt-7 space-y-6">
            {descriptor.fields.map((field) => (
              <PublicField
                key={`${field.propertyId}:${field.type}`}
                field={field}
                value={values[field.propertyId]}
                files={files[field.propertyId] ?? []}
                error={errorsByField.get(field.propertyId)}
                onChange={(value) => update(field.propertyId, value)}
                onFiles={(next) => updateFiles(field.propertyId, next)}
              />
            ))}
          </div>
          {(errors.length > 0 || serverMessage) && (
            <div className="mt-6 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">
              {serverMessage ? t(serverMessage) : t('database.formView.validationSummary')}
            </div>
          )}
          <Button className="mt-7" type="submit" disabled={submitting}>
            {submitting ? t('database.publicForm.submitting') : descriptor.submitLabel}
          </Button>
        </form>
      )}
    </main>
  );
};

export default PublicDatabaseForm;
