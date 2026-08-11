import React, {useId, useRef, useState} from 'react';
import {
  FORM_UPLOAD_MAX_FILE_BYTES,
  FORM_UPLOAD_MAX_FILES,
  FormSubmissionError,
  FormUploadError,
  isSafeHref,
  validateSubmission,
  type DataClient,
  type FormField,
  type FormSchema,
  type FormValidationError,
  type FormValidationErrorCode,
} from '@book.dev/sdk';
import {showToast} from '@/components/ui/toast';
import {t, type TKey} from '@/i18n';

type FormValues = Record<string, unknown>;
type FormErrors = Record<string, FormValidationErrorCode>;
type SubmitState = 'idle' | 'pending' | 'success' | 'unavailable' | 'too-large';
type FileUploadState =
  | {status: 'uploading'}
  | {status: 'ready'}
  | {status: 'error'; message: string};

const ERROR_KEYS: Record<FormValidationErrorCode, TKey> = {
  required: 'formBlock.errors.required',
  type: 'formBlock.errors.type',
  min: 'formBlock.errors.min',
  max: 'formBlock.errors.max',
  minLength: 'formBlock.errors.minLength',
  maxLength: 'formBlock.errors.maxLength',
  pattern: 'formBlock.errors.pattern',
  option: 'formBlock.errors.option',
  unknown_field: 'formBlock.errors.unknownField',
  too_large: 'formBlock.errors.tooLarge',
  date_format: 'formBlock.errors.dateFormat',
  email_format: 'formBlock.errors.emailFormat',
  url_format: 'formBlock.errors.urlFormat',
  phone_format: 'formBlock.errors.phoneFormat',
};

export function formValidationMessage(code: FormValidationErrorCode): string {
  return t(ERROR_KEYS[code]);
}

/** Reserved page properties are never sent, even if hostile block JSON declares them as fields. */
export function stripReservedFormValues(values: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [propertyId, value] of Object.entries(values)) {
    if (!propertyId.startsWith('sys_')) safe[propertyId] = value;
  }
  return safe;
}

/** Resolve only redirects whose effective destination uses HTTP(S). */
export function safeFormRedirect(raw: string, base?: string): string | null {
  if (!isSafeHref(raw)) return null;
  try {
    const url = new URL(raw, base ?? (typeof window === 'undefined' ? undefined : window.location.href));
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

export function mintFormIdempotencyKey(): string {
  if (typeof globalThis.crypto.randomUUID === 'function') return globalThis.crypto.randomUUID();
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function initialValues(fields: FormField[]): FormValues {
  const values: FormValues = {};
  for (const field of fields) {
    switch (field.kind) {
    case 'checkbox':
      values[field.id] = false;
      break;
    case 'multiselect':
    case 'files':
      values[field.id] = [];
      break;
    case 'rating':
      values[field.id] = 1;
      break;
    case 'number':
      break;
    default:
      values[field.id] = '';
    }
  }
  return values;
}

function errorMap(errors: FormValidationError[]): FormErrors {
  const mapped: FormErrors = {};
  for (const error of errors) {
    if (error.fieldId && mapped[error.fieldId] === undefined) mapped[error.fieldId] = error.code;
  }
  return mapped;
}

interface LiveFieldProps {
  field: FormField;
  value: unknown;
  error?: FormValidationErrorCode;
  onChange: (value: unknown) => void;
  onBlur: () => void;
  uploadState?: FileUploadState;
  onFiles?: (files: File[]) => void;
}

const LiveField: React.FC<LiveFieldProps> = ({field, value, error, onChange, onBlur, uploadState, onFiles}) => {
  const reactId = useId();
  const inputId = `obe-form-${reactId}`;
  const errorId = `${inputId}-error`;
  const uploadStatusId = `${inputId}-upload-status`;
  const uploadMessage = uploadState?.status === 'uploading'
    ? t('formBlock.uploadingFiles')
    : uploadState?.status === 'ready'
      ? t('formBlock.filesReady')
      : uploadState?.status === 'error' ? uploadState.message : null;
  const errorMessage = uploadState?.status === 'error'
    ? uploadState.message
    : error ? formValidationMessage(error) : null;
  const common = {
    id: inputId,
    'aria-invalid': errorMessage !== null,
    'aria-describedby': errorMessage ? errorId : uploadMessage ? uploadStatusId : undefined,
    onBlur,
  };

  if (field.honeypot) {
    return (
      <label className="obe-sr-only" aria-hidden="true">
        <span>{field.label || t('formBlock.untitledField')}</span>
        <input
          type="text"
          tabIndex={-1}
          autoComplete="off"
          value={typeof value === 'string' ? value : ''}
          onChange={(event) => onChange(event.target.value)}
        />
      </label>
    );
  }

  let control: React.ReactNode;
  switch (field.kind) {
  case 'longtext':
    control = (
      <textarea
        {...common}
        rows={3}
        placeholder={field.placeholder}
        value={typeof value === 'string' ? value : ''}
        onChange={(event) => onChange(event.target.value)}
      />
    );
    break;
  case 'select':
    control = (
      <select
        {...common}
        value={typeof value === 'string' ? value : ''}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">—</option>
        {(field.options ?? []).map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
      </select>
    );
    break;
  case 'multiselect':
    control = (
      <select
        {...common}
        multiple
        value={Array.isArray(value) ? value as string[] : []}
        onChange={(event) => onChange(Array.from(event.target.selectedOptions, (option) => option.value))}
      >
        {(field.options ?? []).map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
      </select>
    );
    break;
  case 'checkbox':
    control = (
      <input
        {...common}
        type="checkbox"
        checked={value === true}
        onChange={(event) => onChange(event.target.checked)}
      />
    );
    break;
  case 'rating':
    control = (
      <input
        {...common}
        type="range"
        min={1}
        max={5}
        step={1}
        value={typeof value === 'number' ? value : 1}
        onChange={(event) => onChange(event.target.valueAsNumber)}
      />
    );
    break;
  case 'files':
    control = (
      <input
        {...common}
        type="file"
        multiple
        disabled={uploadState?.status === 'uploading'}
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.currentTarget.value = '';
          onFiles?.(files);
        }}
      />
    );
    break;
  case 'number':
    control = (
      <input
        {...common}
        type="number"
        placeholder={field.placeholder}
        value={typeof value === 'number' ? value : ''}
        min={field.validation?.min}
        max={field.validation?.max}
        onChange={(event) => onChange(event.target.value === '' ? undefined : event.target.valueAsNumber)}
      />
    );
    break;
  default: {
    const type = field.kind === 'email'
      ? 'email'
      : field.kind === 'phone'
        ? 'tel'
        : field.kind === 'url'
          ? 'url'
          : field.kind === 'date'
            ? 'date'
            : 'text';
    control = (
      <input
        {...common}
        type={type}
        placeholder={field.placeholder}
        value={typeof value === 'string' ? value : ''}
        onChange={(event) => onChange(event.target.value)}
      />
    );
    break;
  }
  }

  return (
    <div className="obe-form-field" data-form-field={field.id} data-form-field-kind={field.kind}>
      <label className="obe-form-field-label" htmlFor={inputId}>
        {field.label || t('formBlock.untitledField')}
        {field.required && <span aria-hidden> *</span>}
      </label>
      {control}
      <span id={errorId} className="obe-form-field-error" aria-live="polite">
        {errorMessage}
      </span>
      {uploadMessage && !errorMessage ? (
        <span id={uploadStatusId} className="obe-form-field-progress" role="status">{uploadMessage}</span>
      ) : null}
    </div>
  );
};

export const FormClosedView: React.FC = () => (
  <div className="obe-form-state" data-form-state="closed" role="status">
    {t('formBlock.closed')}
  </div>
);

export const FormSubmissionView: React.FC<{
  schema: FormSchema;
  pageId: string;
  client: DataClient & Required<Pick<DataClient, 'submitForm'>>;
}> = ({schema, pageId, client}) => {
  const [values, setValues] = useState<FormValues>(() => initialValues(schema.fields));
  const [errors, setErrors] = useState<FormErrors>({});
  const [fileUploads, setFileUploads] = useState<Record<string, FileUploadState>>({});
  const [state, setState] = useState<SubmitState>('idle');
  const idempotencyKey = useRef<string>(mintFormIdempotencyKey());
  const pending = useRef(false);
  const localSuccess = useRef(false);
  const formRef = useRef<HTMLFormElement>(null);
  const uploadVersions = useRef<Record<string, number>>({});

  const setFieldValue = (fieldId: string, value: unknown): void => {
    setValues((current) => ({...current, [fieldId]: value}));
    setErrors((current) => {
      if (current[fieldId] === undefined) return current;
      const next = {...current};
      delete next[fieldId];
      return next;
    });
  };

  const validateField = (fieldId: string): void => {
    const result = validateSubmission(schema, values);
    const error = 'ok' in result && !result.ok
      ? result.errors.find((candidate) => candidate.fieldId === fieldId)
      : undefined;
    setErrors((current) => {
      const next = {...current};
      if (error) next[fieldId] = error.code;
      else delete next[fieldId];
      return next;
    });
  };

  const uploadFiles = async (field: FormField, files: File[]): Promise<void> => {
    if (files.length === 0) {
      setFieldValue(field.id, []);
      setFileUploads((current) => {
        const next = {...current};
        delete next[field.id];
        return next;
      });
      return;
    }
    const otherFileCount = schema.fields.reduce((count, candidate) => {
      if (candidate.kind !== 'files' || candidate.id === field.id) return count;
      const selected = values[candidate.id];
      return count + (Array.isArray(selected) ? selected.length : 0);
    }, 0);
    if (otherFileCount + files.length > FORM_UPLOAD_MAX_FILES) {
      setFieldValue(field.id, []);
      setFileUploads((current) => ({
        ...current,
        [field.id]: {status: 'error', message: t('formBlock.tooManyFiles')},
      }));
      return;
    }
    if (files.some((file) => file.size > FORM_UPLOAD_MAX_FILE_BYTES)) {
      setFieldValue(field.id, []);
      setFileUploads((current) => ({
        ...current,
        [field.id]: {status: 'error', message: t('formBlock.fileTooLarge')},
      }));
      return;
    }
    if (!client.uploadFormFile) {
      setFieldValue(field.id, []);
      setFileUploads((current) => ({
        ...current,
        [field.id]: {status: 'error', message: t('formBlock.uploadFailed')},
      }));
      return;
    }

    const version = (uploadVersions.current[field.id] ?? 0) + 1;
    uploadVersions.current[field.id] = version;
    setFieldValue(field.id, []);
    setFileUploads((current) => ({...current, [field.id]: {status: 'uploading'}}));
    try {
      const staged = await Promise.all(files.map(async (file) => client.uploadFormFile!(pageId, schema.formId, {
        key: schema.submissionKey,
        fieldId: field.id,
        name: file.name,
        mime: file.type || 'application/octet-stream',
        bytes: new Uint8Array(await file.arrayBuffer()),
      })));
      if (uploadVersions.current[field.id] !== version) return;
      setFieldValue(field.id, staged.map((upload) => upload.token));
      setFileUploads((current) => ({...current, [field.id]: {status: 'ready'}}));
    } catch (error) {
      if (uploadVersions.current[field.id] !== version) return;
      const message = error instanceof FormUploadError && error.status === 413
        ? t('formBlock.fileTooLarge')
        : error instanceof FormUploadError && error.status === 507
          ? t('formBlock.storageFull')
          : error instanceof FormUploadError && error.status === 429
            ? t('formBlock.uploadRateLimited')
            : error instanceof FormUploadError && error.status === 404
              ? t('formBlock.unavailable')
              : t('formBlock.uploadFailed');
      setFileUploads((current) => ({...current, [field.id]: {status: 'error', message}}));
    }
  };

  const submit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const uploading = Object.values(fileUploads).some((upload) => upload.status === 'uploading');
    if (pending.current || uploading || state === 'success' || state === 'unavailable' || state === 'too-large') return;

    const validation = validateSubmission(schema, values);
    if ('ok' in validation && !validation.ok) {
      setErrors(errorMap(validation.errors));
      return;
    }

    const submittedValues = stripReservedFormValues(
      'honeypot' in validation ? values : validation.coerced,
    );
    pending.current = true;
    setState('pending');
    try {
      await client.submitForm(pageId, schema.formId, {
        key: schema.submissionKey,
        values: submittedValues,
        idempotencyKey: idempotencyKey.current,
      });
      localSuccess.current = true;
      setState('success');
      if ('redirectUrl' in schema.confirmation) {
        const redirect = safeFormRedirect(schema.confirmation.redirectUrl);
        if (redirect) window.location.assign(redirect);
      }
    } catch (error) {
      if (error instanceof FormSubmissionError) {
        if (error.status === 404 && localSuccess.current) {
          setState('success');
        } else if (error.status === 400 && error.errors.length > 0) {
          setErrors(errorMap(error.errors));
          setState('idle');
        } else if (error.status === 404) {
          setState('unavailable');
        } else if (error.status === 413) {
          setState('too-large');
        } else {
          setState('idle');
          showToast({
            message: t('formBlock.networkError'),
            actionLabel: t('formBlock.retry'),
            onAction: () => formRef.current?.requestSubmit(),
          });
        }
      } else {
        setState('idle');
        showToast({
          message: t('formBlock.networkError'),
          actionLabel: t('formBlock.retry'),
          onAction: () => formRef.current?.requestSubmit(),
        });
      }
    } finally {
      pending.current = false;
    }
  };

  if (state === 'success') {
    const message = 'message' in schema.confirmation && schema.confirmation.message.trim()
      ? schema.confirmation.message
      : t('formBlock.success');
    return <div className="obe-form-state" data-form-state="success" role="status">{message}</div>;
  }
  if (state === 'unavailable') {
    return <div className="obe-form-state" data-form-state="unavailable" role="status">{t('formBlock.unavailable')}</div>;
  }
  if (state === 'too-large') {
    return <div className="obe-form-state" data-form-state="too-large" role="status">{t('formBlock.tooLarge')}</div>;
  }

  return (
    <form ref={formRef} className="obe-form-preview obe-form-live" data-form-mode="live" data-ob-form onSubmit={submit} noValidate>
      {schema.fields.length === 0 ? (
        <div className="obe-form-empty">{t('formBlock.noFields')}</div>
      ) : schema.fields.map((field) => (
        <LiveField
          key={field.id || `${field.kind}-${field.label}`}
          field={field}
          value={values[field.id]}
          error={errors[field.id]}
          onChange={(value) => setFieldValue(field.id, value)}
          onBlur={() => validateField(field.id)}
          uploadState={fileUploads[field.id]}
          onFiles={field.kind === 'files' ? (files) => void uploadFiles(field, files) : undefined}
        />
      ))}
      <button
        type="submit"
        className="obe-kit-action"
        disabled={state === 'pending' || Object.values(fileUploads).some((upload) => upload.status === 'uploading')}
      >
        {state === 'pending' ? t('formBlock.pending') : schema.submitLabel || t('formBlock.submit')}
      </button>
    </form>
  );
};
