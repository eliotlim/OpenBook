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
  isFormWritablePropertyType,
  type DatabaseFormDescriptorRequest,
  type DatabaseFormSubmissionRequest,
  type DatabaseView,
  type FormSchema,
  type FormSubmissionRequest,
  type FormUploadRequest,
  type StoredDatabase,
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
const DUMMY_DATABASE_FORM_CAPABILITY_HASH = '0'.repeat(64);
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

/** SHA-256 hex stored in place of a database form's plaintext capability. */
export function hashDatabaseFormCapability(capability: string): string {
  return createHash('sha256').update(capability, 'utf8').digest('hex');
}

/** Namespace a database form-view in the shared staged-upload table. */
export function databaseFormUploadId(viewId: string): string {
  return `database-view:${viewId}`;
}

/** Resolve one uniquely-id'd current form view, failing closed on duplicate ids. */
export function currentDatabaseFormView(database: StoredDatabase, viewId: string): DatabaseView | null {
  if (!Array.isArray(database.schema?.views) || !Array.isArray(database.schema?.properties)) return null;
  const matching = database.schema.views.filter((view) =>
    view && typeof view === 'object' && view.id === viewId && view.type === 'form',
  );
  if (matching.length !== 1) return null;
  const view = matching[0];
  if (
    view.visiblePropertyIds !== undefined
    && (!Array.isArray(view.visiblePropertyIds)
      || !view.visiblePropertyIds.every((propertyId) => typeof propertyId === 'string'))
  ) {
    return null;
  }

  // Database JSON crosses version and hand-authored boundaries. Validate the
  // mapped subset that the public descriptor/validator will dereference so a
  // malformed option or property fails closed instead of becoming a public 500.
  const mappedIds = new Set(view.visiblePropertyIds ?? []);
  for (const candidate of database.schema.properties as unknown[]) {
    if (!isRecord(candidate)) return null;
    if (typeof candidate.id !== 'string' || !mappedIds.has(candidate.id)) continue;
    if (typeof candidate.name !== 'string' || typeof candidate.type !== 'string') return null;
    if (candidate.options !== undefined) {
      if (!Array.isArray(candidate.options)) return null;
      if (candidate.options.some((option) =>
        !isRecord(option)
        || typeof option.id !== 'string'
        || typeof option.label !== 'string'
        || (option.color !== undefined && typeof option.color !== 'string')
        || (option.group !== undefined && typeof option.group !== 'string')
      )) {
        return null;
      }
    }
  }
  return view;
}

/**
 * Resolve a valid database-form capability without inspecting response state.
 * Descriptor reads and submissions share this exact existence-hiding door; only
 * a caller that passes it may learn that a form is closed.
 */
export async function requireDatabaseFormSubmissionAccess(
  store: PageStore,
  databaseId: string,
  viewId: string,
  providedCapability: string,
): Promise<{database: StoredDatabase; view: DatabaseView; capabilityHash: string}> {
  const database = await store.getDatabase(databaseId);
  const view = database ? currentDatabaseFormView(database, viewId) : null;
  const capabilityHash = view
    ? await store.getDatabaseFormCapabilityHash(databaseId, viewId)
    : null;
  const managed = database ? await store.isManagedDatabase(databaseId) : false;
  const providedHash = hashDatabaseFormCapability(providedCapability);
  const expectedHash = capabilityHash ?? DUMMY_DATABASE_FORM_CAPABILITY_HASH;
  const matches = constantTimeSubmissionKeyEqual(providedHash, expectedHash);
  if (
    !database
    || !view
    || !capabilityHash
    || managed
    || !matches
  ) {
    denyFormSubmission();
  }
  return {database, view, capabilityHash};
}

/** Resolve the frozen per-view response ceiling, failing closed when malformed. */
export function databaseFormResponseCap(view: DatabaseView): number | null {
  const config = view.formConfig;
  if (!config || !Object.prototype.hasOwnProperty.call(config, 'maxResponses')) {
    return FORM_SUBMISSION_DEFAULT_MAX_SUBMISSIONS;
  }
  return Number.isSafeInteger(config.maxResponses) && (config.maxResponses as number) >= 0
    ? config.maxResponses as number
    : null;
}

/** Whether `fieldId` is a current, mapped files property on this form view. */
export function isDatabaseFormFilesField(
  database: StoredDatabase,
  view: DatabaseView,
  fieldId: string,
): boolean {
  if (!(view.visiblePropertyIds ?? []).includes(fieldId) || fieldId.startsWith('sys_')) return false;
  const property = database.schema.properties.find((candidate) => candidate.id === fieldId);
  return property?.type === 'files' && isFormWritablePropertyType(property.type);
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

/** Extract only the candidate database-form capability for the oracle-safe gate. */
export function databaseFormCapability(body: unknown): string {
  return isRecord(body) && typeof body.capability === 'string' ? body.capability : '';
}

/** Validate the frozen capability-only descriptor POST body after the deny door. */
export function validateDatabaseFormDescriptorRequest(body: unknown): DatabaseFormDescriptorRequest {
  if (
    !isRecord(body)
    || typeof body.capability !== 'string'
    || Object.keys(body).some((key) => key !== 'capability')
  ) {
    throw new HTTPException(400, {message: 'invalid form descriptor request'});
  }
  return {capability: body.capability};
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

export interface DatabaseFormUploadRequest {
  capability: string;
  fieldId: string;
  name: string;
  mime: string;
  data: string;
}

/** Validate database form upload metadata after its capability gate has passed. */
export function validateDatabaseFormUploadRequest(body: unknown): DatabaseFormUploadRequest {
  if (
    !isRecord(body)
    || Object.keys(body).some((key) => !['capability', 'fieldId', 'name', 'mime', 'data'].includes(key))
    || typeof body.capability !== 'string'
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
    capability: body.capability,
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

/** Validate the frozen F-4 submission envelope after the capability gate. */
export function validateDatabaseFormSubmissionRequest(body: unknown): DatabaseFormSubmissionRequest {
  if (
    !isRecord(body)
    || !isRecord(body.fields)
    || typeof body.capability !== 'string'
    || Object.keys(body).some((key) => !['capability', 'fields', 'idempotencyKey'].includes(key))
  ) {
    throw new HTTPException(400, {message: 'invalid form submission'});
  }
  const idempotencyKey = typeof body.idempotencyKey === 'string' ? body.idempotencyKey.trim() : '';
  if (
    typeof body.idempotencyKey !== 'string'
    || idempotencyKey.length === 0
    || textEncoder.encode(idempotencyKey).byteLength > FORM_SUBMISSION_MAX_IDEMPOTENCY_KEY_BYTES
  ) {
    throw new HTTPException(400, {message: 'invalid form submission'});
  }

  const entries = Object.entries(body.fields);
  const totalBytes = jsonBytes(body.fields);
  if (
    entries.length > FORM_SUBMISSION_MAX_FIELDS
    || totalBytes === null
    || totalBytes > FORM_SUBMISSION_MAX_VALUES_BYTES
  ) {
    throw new HTTPException(400, {message: 'form submission values are too large'});
  }
  for (const [, value] of entries) {
    const valueBytes = jsonBytes(value);
    if (
      valueBytes === null
      || valueBytes > FORM_SUBMISSION_MAX_VALUE_BYTES
      || !jsonDepthWithin(value, FORM_SUBMISSION_MAX_VALUE_DEPTH)
    ) {
      throw new HTTPException(400, {message: 'form submission value is too large or deeply nested'});
    }
  }

  return {capability: body.capability, fields: body.fields, idempotencyKey};
}
