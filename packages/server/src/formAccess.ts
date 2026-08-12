/**
 * Capability gate for form submissions.
 *
 * This deliberately sits beside the ordinary page access gate instead of adding
 * a rung to SDK `authorize()`: the capability authorizes exactly one row-create
 * operation, while the existing page decision remains authoritative for whether
 * the caller may reach the host page at all.
 */

import {createHash, timingSafeEqual} from 'node:crypto';
import type {Context} from 'hono';
import {HTTPException} from 'hono/http-exception';
import {
  FORM_UPLOAD_MAX_FILE_BYTES,
  type FormSchema,
  type FormSubmissionRequest,
  type FormUploadRequest,
  type StoredPage,
} from '@book.dev/sdk';
import type {AppEnv} from './appEnv';
import type {PageStore} from './store';

type Ctx = Context<AppEnv>;

export const FORM_SUBMISSION_DENIED_MESSAGE = 'form not found';
export const FORM_SUBMISSION_MAX_BODY_BYTES = 160 * 1024;
export const FORM_SUBMISSION_MAX_VALUES_BYTES = 128 * 1024;
export const FORM_SUBMISSION_MAX_VALUE_BYTES = 16 * 1024;
export const FORM_SUBMISSION_MAX_VALUE_DEPTH = 8;
export const FORM_SUBMISSION_MAX_FIELDS = 100;
export const FORM_SUBMISSION_MAX_IDEMPOTENCY_KEY_BYTES = 200;
/** Interim FORM-1 abuse ceiling when the persisted form schema has no override. */
export const FORM_SUBMISSION_DEFAULT_MAX_SUBMISSIONS = 10_000;
/** Shared upload+submit budget per IP/form fixed window. */
export const FORM_REQUEST_RATE_LIMIT = 30;
/** Shared fallback floor for adapters that expose no trustworthy socket peer. */
export const FORM_SHARED_RATE_LIMIT = 600;
export const FORM_REQUEST_RATE_WINDOW_MS = 60_000;
/** Base64 JSON envelope for one 5 MiB decoded file plus bounded metadata. */
export const FORM_UPLOAD_MAX_BODY_BYTES = Math.ceil(FORM_UPLOAD_MAX_FILE_BYTES * 4 / 3) + 64 * 1024;
export const FORM_UPLOAD_MAX_NAME_BYTES = 512;
export const FORM_UPLOAD_MAX_FIELD_ID_BYTES = 200;

const DUMMY_SUBMISSION_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const textEncoder = new TextEncoder();

/** The validated subset of a persisted `form` block that the server consumes. */
export interface StoredFormDefinition {
  formId: string;
  submissionKey: string;
  enabled: boolean;
  databaseId: string;
  schema: FormSchema;
}

interface JsonRecord {
  [key: string]: unknown;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function denyFormSubmission(): never {
  throw new HTTPException(404, {message: FORM_SUBMISSION_DENIED_MESSAGE});
}

/** Whether a validated-enough persisted schema exposes at least one files field. */
export function formHasFilesField(schema: unknown): boolean {
  return isRecord(schema)
    && Array.isArray(schema.fields)
    && schema.fields.some((field) => isRecord(field) && field.kind === 'files' && typeof field.id === 'string');
}

/** Whether `fieldId` names a files field in this persisted schema. */
export function isFormFilesField(schema: unknown, fieldId: string): boolean {
  return isRecord(schema)
    && Array.isArray(schema.fields)
    && schema.fields.some((field) =>
      isRecord(field) && field.kind === 'files' && field.id === fieldId,
    );
}

/**
 * Compare arbitrary strings without an early exit on length or character
 * mismatch. Hashing both inputs to the same fixed width lets `timingSafeEqual`
 * cover wrong-length probes as well as equal-length guesses.
 */
export function constantTimeSubmissionKeyEqual(provided: string, expected: string): boolean {
  const providedHash = createHash('sha256').update(provided, 'utf8').digest();
  const expectedHash = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(providedHash, expectedHash);
}

/**
 * Locate one form in the raw `PageSnapshot.blockdoc.blocks` JSON projection
 * written by the block editor's `encodeSnapshot`. The retained `editorjs` field
 * is an export projection and is not authoritative for block props or children.
 * Nested block children are scanned iteratively. A missing/malformed blockdoc,
 * duplicate matching ids, or malformed matching props fail closed.
 */
export function findFormInPage(page: Pick<StoredPage, 'data'>, formId: string): StoredFormDefinition | null {
  const blockdoc = isRecord(page.data.blockdoc) ? page.data.blockdoc : null;
  const roots = blockdoc && Array.isArray(blockdoc.blocks) ? blockdoc.blocks : [];
  const stack: unknown[] = [...roots].reverse();
  const seen = new Set<object>();
  let found: StoredFormDefinition | null = null;

  while (stack.length > 0) {
    const value = stack.pop();
    if (!isRecord(value) || seen.has(value)) continue;
    seen.add(value);

    if (Array.isArray(value.children)) {
      for (let i = value.children.length - 1; i >= 0; i -= 1) stack.push(value.children[i]);
    }
    if (value.type !== 'form' || !isRecord(value.props) || value.props.formId !== formId) continue;
    if (found) return null;

    const props = value.props;
    const schema = props.schema;
    if (
      typeof props.formId !== 'string' ||
      typeof props.submissionKey !== 'string' ||
      props.submissionKey.length === 0 ||
      typeof props.enabled !== 'boolean' ||
      typeof props.databaseId !== 'string' ||
      props.databaseId.length === 0 ||
      typeof schema !== 'object' ||
      schema === null ||
      Array.isArray(schema) ||
      !Array.isArray((schema as {fields?: unknown}).fields)
    ) {
      return null;
    }
    found = {
      formId: props.formId,
      submissionKey: props.submissionKey,
      enabled: props.enabled,
      databaseId: props.databaseId,
      schema: schema as FormSchema,
    };
  }

  return found;
}

/** Resolve a non-negative integer schema override, failing closed if malformed. */
function formSubmissionCap(schema: unknown): number | null {
  if (!isRecord(schema) || !Object.prototype.hasOwnProperty.call(schema, 'maxSubmissions')) {
    return FORM_SUBMISSION_DEFAULT_MAX_SUBMISSIONS;
  }
  return Number.isSafeInteger(schema.maxSubmissions) && (schema.maxSubmissions as number) >= 0
    ? schema.maxSubmissions as number
    : null;
}

/**
 * Resolve and authorize a form submission through one indistinguishable deny
 * door. The caller's existing page READ decision is reused verbatim; guests,
 * authenticated users, forwarding posture, visibility inheritance, ACLs and the
 * `guestAccess:'off'` floor therefore cannot drift from ordinary page reads.
 */
export async function requireFormSubmissionAccess(
  c: Ctx,
  store: PageStore,
  pageId: string,
  formId: string,
  providedKey: string,
): Promise<{page: StoredPage; form: StoredFormDefinition}> {
  const page = await store.getPage(pageId);
  const form = page ? findFormInPage(page, formId) : null;
  const keyMatches = constantTimeSubmissionKeyEqual(providedKey, form?.submissionKey ?? DUMMY_SUBMISSION_KEY);
  const {decision, exists} = await store.decidePageAccess(c.get('principal'), pageId);
  const database = form ? await store.getDatabase(form.databaseId) : null;
  const submissionCap = form ? formSubmissionCap(form.schema) : null;
  const managedDatabase = database ? await store.isManagedDatabase(database.id) : false;
  const submissionCount = database ? await store.countActiveRows(database.id) : 0;

  // Bind the capability to a database hosted by the SAME page. Without this,
  // editable form props would be a confused-deputy write primitive into an
  // unrelated database whose page the form author may not control.
  if (
    !page ||
    !form ||
    !form.enabled ||
    !keyMatches ||
    !exists ||
    !decision.canRead ||
    !database ||
    database.pageId !== pageId ||
    managedDatabase ||
    submissionCap === null ||
    submissionCount >= submissionCap
  ) {
    denyFormSubmission();
  }
  return {page, form};
}

/** Reuse the security-cleared submission gate, then apply the files-only carve-out. */
export async function requireFormUploadAccess(
  c: Ctx,
  store: PageStore,
  pageId: string,
  formId: string,
  providedKey: string,
): Promise<{page: StoredPage; form: StoredFormDefinition}> {
  const access = await requireFormSubmissionAccess(c, store, pageId, formId, providedKey);
  if (!formHasFilesField(access.form.schema)) denyFormSubmission();
  return access;
}

/** Extract only the candidate key so the oracle-safe gate runs before 400s. */
export function formSubmissionKey(body: unknown): string {
  return isRecord(body) && typeof body.key === 'string' ? body.key : '';
}

/** Validate upload metadata after the capability gate has passed. */
export function validateFormUploadRequest(body: unknown): FormUploadRequest {
  if (
    !isRecord(body)
    || typeof body.key !== 'string'
    || typeof body.fieldId !== 'string'
    || body.fieldId.length === 0
    || textEncoder.encode(body.fieldId).byteLength > FORM_UPLOAD_MAX_FIELD_ID_BYTES
    || typeof body.name !== 'string'
    || body.name.trim().length === 0
    || textEncoder.encode(body.name).byteLength > FORM_UPLOAD_MAX_NAME_BYTES
    || typeof body.mime !== 'string'
    || typeof body.data !== 'string'
    || body.data.length === 0
  ) {
    throw new HTTPException(400, {message: 'invalid form upload'});
  }
  return {
    key: body.key,
    fieldId: body.fieldId,
    name: body.name,
    mime: body.mime || 'application/octet-stream',
    data: body.data,
  };
}

function jsonDepthWithin(value: unknown, maxDepth: number): boolean {
  const stack: Array<{value: unknown; depth: number}> = [{value, depth: 0}];
  while (stack.length > 0) {
    const next = stack.pop()!;
    if (next.depth > maxDepth) return false;
    if (Array.isArray(next.value)) {
      for (const child of next.value) stack.push({value: child, depth: next.depth + 1});
    } else if (isRecord(next.value)) {
      for (const child of Object.values(next.value)) stack.push({value: child, depth: next.depth + 1});
    }
  }
  return true;
}

function jsonBytes(value: unknown): number | null {
  try {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? null : textEncoder.encode(encoded).byteLength;
  } catch {
    return null;
  }
}

/** Validate the v1 shape/size envelope; FORM-5 owns schema semantics. */
export function validateFormSubmissionRequest(body: unknown): FormSubmissionRequest {
  if (!isRecord(body) || !isRecord(body.values)) {
    throw new HTTPException(400, {message: 'invalid form submission'});
  }
  const idempotencyKey = typeof body.idempotencyKey === 'string' ? body.idempotencyKey.trim() : '';
  if (
    typeof body.idempotencyKey !== 'string' ||
    idempotencyKey.length === 0 ||
    textEncoder.encode(idempotencyKey).byteLength > FORM_SUBMISSION_MAX_IDEMPOTENCY_KEY_BYTES
  ) {
    throw new HTTPException(400, {message: 'invalid form submission'});
  }

  const entries = Object.entries(body.values);
  const totalBytes = jsonBytes(body.values);
  if (
    entries.length > FORM_SUBMISSION_MAX_FIELDS ||
    totalBytes === null ||
    totalBytes > FORM_SUBMISSION_MAX_VALUES_BYTES
  ) {
    throw new HTTPException(400, {message: 'form submission values are too large'});
  }
  for (const [, value] of entries) {
    const valueBytes = jsonBytes(value);
    if (
      valueBytes === null ||
      valueBytes > FORM_SUBMISSION_MAX_VALUE_BYTES ||
      !jsonDepthWithin(value, FORM_SUBMISSION_MAX_VALUE_DEPTH)
    ) {
      throw new HTTPException(400, {message: 'form submission value is too large or deeply nested'});
    }
  }

  return {
    key: formSubmissionKey(body),
    values: body.values,
    idempotencyKey,
  };
}
