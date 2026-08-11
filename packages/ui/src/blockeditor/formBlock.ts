import {FORM_FIELD_KINDS, type FormField, type FormSchema, type PageSnapshot} from '@book.dev/sdk';
import {pageLinkUrl} from '@/lib/pageActions';
import {
  createDoc,
  decodeSnapshot,
  docToJSON,
  encodeSnapshot,
  type BlockDocSnapshot,
  type BlockJSON,
  type NewBlock,
} from './model';

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

/** A shareable page URL, excluding local/file/desktop-only locations. */
export function formOriginUrl(pageId: string | null | undefined): string | null {
  if (!pageId || typeof window === 'undefined') return null;
  const url = pageLinkUrl(pageId);
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : null;
  } catch {
    return null;
  }
}

type JsonRecord = Record<string, unknown>;

const jsonRecord = (value: unknown): JsonRecord | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : null;

const submissionKeyOf = (props: JsonRecord): string => {
  if (typeof props.submissionKey === 'string' && props.submissionKey) return props.submissionKey;
  const schema = jsonRecord(props.schema);
  return typeof schema?.submissionKey === 'string' && schema.submissionKey ? schema.submissionKey : '';
};

const formIdOf = (props: JsonRecord): string => {
  if (typeof props.formId === 'string' && props.formId) return props.formId;
  const schema = jsonRecord(props.schema);
  return typeof schema?.formId === 'string' ? schema.formId : '';
};

const withSubmissionKey = (props: JsonRecord, submissionKey: string): JsonRecord => {
  const schema = jsonRecord(props.schema);
  return {
    ...props,
    submissionKey,
    ...(schema ? {schema: {...schema, submissionKey}} : {}),
  };
};

function mintBlockSubmissionKeys(
  blocks: BlockJSON[],
  keyByForm: Map<string, string>,
): {blocks: BlockJSON[]; changed: boolean} {
  let changed = false;
  const next = blocks.map((block) => {
    let result = block;
    if (block.type === 'form') {
      const props = jsonRecord(block.props) ?? {};
      const identity = formIdOf(props) || block.id;
      const existing = submissionKeyOf(props);
      const submissionKey = existing || keyByForm.get(identity) || randomSubmissionKey();
      keyByForm.set(identity, submissionKey);
      const schema = jsonRecord(props.schema);
      if (props.submissionKey !== submissionKey || (schema && schema.submissionKey !== submissionKey)) {
        changed = true;
        result = {...result, props: withSubmissionKey(props, submissionKey)};
      }
    }
    if (block.children) {
      const children = mintBlockSubmissionKeys(block.children, keyByForm);
      if (children.changed) {
        changed = true;
        result = {...result, children: children.blocks};
      }
    }
    return result;
  });
  return changed ? {blocks: next, changed} : {blocks, changed};
}

function mintAliasSubmissionKeys(
  editorjs: unknown,
  keyByForm: Map<string, string>,
): {editorjs: unknown; changed: boolean} {
  const source = jsonRecord(editorjs);
  if (!source || !Array.isArray(source.blocks)) return {editorjs, changed: false};
  let changed = false;
  const blocks = source.blocks.map((value) => {
    const block = jsonRecord(value);
    const data = jsonRecord(block?.data);
    if (!block || block.type !== 'form' || !data) return value;
    const props = jsonRecord(data.props) ?? {};
    const identity = formIdOf(data) || formIdOf(props) || (typeof block.id === 'string' ? block.id : '');
    const existing = submissionKeyOf(data) || submissionKeyOf(props);
    // The rebuilt blockdoc is authoritative when an old/partial artifact's two
    // aliases disagree; a sanitized export has neither key and lands here with
    // the freshly minted blockdoc key.
    const submissionKey = keyByForm.get(identity) || existing || randomSubmissionKey();
    keyByForm.set(identity, submissionKey);
    const dataSchema = jsonRecord(data.schema);
    const propsSchema = jsonRecord(props.schema);
    const needsKey = data.submissionKey !== submissionKey ||
      props.submissionKey !== submissionKey ||
      (dataSchema !== null && dataSchema.submissionKey !== submissionKey) ||
      (propsSchema !== null && propsSchema.submissionKey !== submissionKey);
    if (!needsKey) return value;
    const nextData = withSubmissionKey(data, submissionKey);
    nextData.props = withSubmissionKey(props, submissionKey);
    changed = true;
    return {...block, data: nextData};
  });
  return changed ? {editorjs: {...source, blocks}, changed} : {editorjs, changed};
}

/**
 * Give forms restored from a sanitized export their own write capability. The
 * export boundary removes the source key without touching the live page; this
 * import-only path follows the same local mint as a newly inserted form, so the
 * copied page receives a fresh key while retaining its exported formId/schema.
 */
export function mintMissingFormSubmissionKeys(snapshot: PageSnapshot): PageSnapshot {
  const keyByForm = new Map<string, string>();
  let blockdoc = snapshot.blockdoc;
  let blockdocChanged = false;
  if (jsonRecord(blockdoc)) {
    const json = docToJSON(decodeSnapshot(blockdoc as BlockDocSnapshot));
    const restored = mintBlockSubmissionKeys(json, keyByForm);
    if (restored.changed) {
      blockdoc = encodeSnapshot(createDoc(restored.blocks));
      blockdocChanged = true;
    }
  }
  const alias = mintAliasSubmissionKeys(snapshot.editorjs, keyByForm);
  if (!blockdocChanged && !alias.changed) return snapshot;
  return {
    ...snapshot,
    ...(blockdocChanged ? {blockdoc} : {}),
    ...(alias.changed ? {editorjs: alias.editorjs as PageSnapshot['editorjs']} : {}),
  };
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

const formFieldKinds = new Set<string>(FORM_FIELD_KINDS);

/** Defensive read of the user-authored schema carried in durable JSON. */
function normalizeField(value: unknown): FormField | null {
  const raw = record(value);
  if (!raw || typeof raw.kind !== 'string' || !formFieldKinds.has(raw.kind)) return null;
  const field = {
    ...raw,
    id: typeof raw.id === 'string' ? raw.id : '',
    kind: raw.kind,
    label: typeof raw.label === 'string' ? raw.label : '',
    required: raw.required === true,
  } as FormField;
  if (typeof raw.placeholder !== 'string') delete field.placeholder;
  if (Array.isArray(raw.options)) {
    field.options = raw.options.flatMap((value) => {
      const option = record(value);
      return option && typeof option.id === 'string' && typeof option.label === 'string'
        ? [{...option, id: option.id, label: option.label} as NonNullable<FormField['options']>[number]]
        : [];
    });
  } else {
    delete field.options;
  }
  return field;
}

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
    ? nested.fields.map(normalizeField).filter((field): field is FormField => field !== null)
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
