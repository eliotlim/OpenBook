import type {FormField, FormSchema} from '@book.dev/sdk';
import type {NewBlock} from './model';

/** The durable props FORM-1/FORM-5 read from the stored block projection. */
export interface FormBlockWireProps {
  formId: string;
  submissionKey: string;
  enabled: boolean;
  databaseId?: string;
  schema: FormSchema;
}

/** Exactly 128 cryptographically-random bits, encoded without base64 padding. */
export function randomSubmissionKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

/** A fresh id for a newly inserted form. UUID is random when the host supports it. */
export function randomFormId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return randomSubmissionKey();
}

/** The minimal valid FORM-2 schema used by the slash command. */
export function emptyFormWireProps(): FormBlockWireProps {
  const formId = randomFormId();
  const submissionKey = randomSubmissionKey();
  const schema: FormSchema = {
    formId,
    fields: [],
    confirmation: {message: 'Thanks — your response has been recorded.'},
    submissionKey,
    enabled: true,
  };
  return {formId, submissionKey, enabled: true, schema};
}

/** Registry slash-item factory; values are minted for every insertion. */
export function makeFormBlock(): NewBlock {
  return {type: 'form', props: {...emptyFormWireProps()}};
}

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/**
 * Read a form schema defensively. Top-level gate props are authoritative while
 * the nested schema carries the ordered field definition and confirmation.
 */
export function formSchemaFromProps(props: Record<string, unknown> | undefined): FormSchema {
  const nested = record(props?.schema) ?? {};
  const formId = typeof props?.formId === 'string'
    ? props.formId
    : typeof nested.formId === 'string' ? nested.formId : '';
  const submissionKey = typeof props?.submissionKey === 'string'
    ? props.submissionKey
    : typeof nested.submissionKey === 'string' ? nested.submissionKey : '';
  const enabled = typeof props?.enabled === 'boolean'
    ? props.enabled
    : typeof nested.enabled === 'boolean' ? nested.enabled : false;
  const databaseId = typeof props?.databaseId === 'string'
    ? props.databaseId
    : typeof nested.databaseId === 'string' ? nested.databaseId : undefined;
  const fields = Array.isArray(nested.fields)
    ? nested.fields.filter((field): field is FormField => record(field) !== null)
    : [];
  const confirmation = record(nested.confirmation);
  const normalized: FormSchema = {
    ...(nested as unknown as Partial<FormSchema>),
    formId,
    fields,
    confirmation: confirmation && typeof confirmation.redirectUrl === 'string'
      ? {redirectUrl: confirmation.redirectUrl}
      : {message: confirmation && typeof confirmation.message === 'string' ? confirmation.message : ''},
    submissionKey,
    enabled,
    ...(databaseId ? {databaseId} : {}),
  };
  return normalized;
}
