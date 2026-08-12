import {FORM_FIELD_KINDS, generateSubmissionKey, type FormField, type FormSchema, type PageSnapshot} from '@book.dev/sdk';
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

/** The SDK's 256-bit form capability generator, kept behind the established UI helper. */
export function randomSubmissionKey(): string {
  return generateSubmissionKey();
}

/** A fresh id for a newly inserted form. UUID is random when the host supports it. */
export function randomFormId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return randomSubmissionKey();
}

/** Stable identity for one field. Kept separate from the form id helper so
 * callers do not accidentally reuse a form's identity for one of its rows. */
export function randomFormFieldId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `field_${randomSubmissionKey()}`;
}

/** Minimal valid field inserted by FORM-4's palette. */
export function makeFormField(kind: FormField['kind'], label = ''): FormField {
  return {
    id: randomFormFieldId(),
    kind,
    label,
    required: false,
    ...((kind === 'select' || kind === 'multiselect') ? {options: []} : {}),
  };
}

/** Insert a field at a canvas gap (0..length), without mutating the schema. */
export function insertFormField(fields: FormField[], field: FormField, at = fields.length): FormField[] {
  const index = Math.max(0, Math.min(fields.length, at));
  return [...fields.slice(0, index), field, ...fields.slice(index)];
}

/** Reorder one field into a canvas gap (0..length), without mutation. */
export function reorderFormFields(fields: FormField[], fieldId: string, targetGap: number): FormField[] {
  const from = fields.findIndex((field) => field.id === fieldId);
  if (from < 0) return fields;
  const gap = Math.max(0, Math.min(fields.length, targetGap));
  const remaining = fields.filter((field) => field.id !== fieldId);
  const to = Math.max(0, Math.min(remaining.length, gap > from ? gap - 1 : gap));
  if (to === from) return fields;
  return [...remaining.slice(0, to), fields[from], ...remaining.slice(to)];
}

/** Keyboard/menu alternative to pointer reordering. */
export function moveFormField(fields: FormField[], fieldId: string, delta: -1 | 1): FormField[] {
  const from = fields.findIndex((field) => field.id === fieldId);
  if (from < 0) return fields;
  const to = Math.max(0, Math.min(fields.length - 1, from + delta));
  if (to === from) return fields;
  const next = [...fields];
  const [field] = next.splice(from, 1);
  next.splice(to, 0, field);
  return next;
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

/**
 * Find the first form whose durable capability aliases say it accepts
 * submissions. This reads the same authoritative `blockdoc.blocks` projection
 * as the server's `findFormInPage` and deliberately returns only the block id:
 * the submission key is a write capability and never belongs in sharing UI.
 */
export function enabledFormBlockId(snapshot: Pick<PageSnapshot, 'blockdoc'>): string | null {
  const blockdoc = jsonRecord(snapshot.blockdoc);
  const roots = blockdoc && Array.isArray(blockdoc.blocks) ? blockdoc.blocks : [];
  const stack: unknown[] = [...roots].reverse();
  const seen = new Set<object>();

  while (stack.length > 0) {
    const value = stack.pop();
    const block = jsonRecord(value);
    if (!block || seen.has(block)) continue;
    seen.add(block);
    if (Array.isArray(block.children)) {
      for (let i = block.children.length - 1; i >= 0; i -= 1) stack.push(block.children[i]);
    }
    const props = jsonRecord(block.props);
    if (
      block.type === 'form'
      && typeof block.id === 'string'
      && block.id.length > 0
      && props?.enabled === true
      && typeof props.submissionKey === 'string'
      && props.submissionKey.length > 0
    ) {
      return block.id;
    }
  }
  return null;
}

/**
 * Whether an enabled form disclosure may honestly say it can accept responses.
 * The block id comes from {@link enabledFormBlockId}; this companion selector
 * inspects only the database/column bindings and never returns the submission
 * capability to sharing UI.
 */
export function formBlockReadyForSubmissions(
  snapshot: Pick<PageSnapshot, 'blockdoc'>,
  blockId: string | null,
): boolean {
  if (!blockId) return false;
  const blockdoc = jsonRecord(snapshot.blockdoc);
  const roots = blockdoc && Array.isArray(blockdoc.blocks) ? blockdoc.blocks : [];
  const stack: unknown[] = [...roots].reverse();
  const seen = new Set<object>();

  while (stack.length > 0) {
    const value = stack.pop();
    const block = jsonRecord(value);
    if (!block || seen.has(block)) continue;
    seen.add(block);
    if (Array.isArray(block.children)) {
      for (let i = block.children.length - 1; i >= 0; i -= 1) stack.push(block.children[i]);
    }
    if (block.type !== 'form' || block.id !== blockId) continue;
    const props = jsonRecord(block.props);
    const schema = jsonRecord(props?.schema);
    const databaseId = typeof props?.databaseId === 'string' && props.databaseId.length > 0
      ? props.databaseId
      : typeof schema?.databaseId === 'string' ? schema.databaseId : '';
    const fields = Array.isArray(schema?.fields) ? schema.fields : [];
    return databaseId.length > 0 && fields.some((field) => {
      const record = jsonRecord(field);
      return typeof record?.columnId === 'string' && record.columnId.length > 0;
    });
  }
  return false;
}

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

function mintAliasValueSubmissionKeys(
  value: unknown,
  keyByForm: Map<string, string>,
): {value: unknown; changed: boolean} {
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((entry) => {
      const result = mintAliasValueSubmissionKeys(entry, keyByForm);
      changed ||= result.changed;
      return result.value;
    });
    return changed ? {value: next, changed} : {value, changed};
  }
  const source = jsonRecord(value);
  if (!source) return {value, changed: false};
  let changed = false;
  let current = source;
  const data = jsonRecord(source.data);
  if (source.type === 'form' && data) {
    const props = jsonRecord(data.props) ?? {};
    const identity = formIdOf(data) || formIdOf(props) || (typeof source.id === 'string' ? source.id : '');
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
    if (needsKey) {
      const nextData = withSubmissionKey(data, submissionKey);
      nextData.props = withSubmissionKey(props, submissionKey);
      current = {...source, data: nextData};
      changed = true;
    }
  }
  let next = current;
  for (const [key, entry] of Object.entries(current)) {
    const result = mintAliasValueSubmissionKeys(entry, keyByForm);
    if (!result.changed) continue;
    if (next === current) next = {...current};
    next[key] = result.value;
    changed = true;
  }
  return changed ? {value: next, changed} : {value, changed};
}

function mintAliasSubmissionKeys(
  editorjs: unknown,
  keyByForm: Map<string, string>,
): {editorjs: unknown; changed: boolean} {
  const source = jsonRecord(editorjs);
  if (!source || !Array.isArray(source.blocks)) return {editorjs, changed: false};
  const result = mintAliasValueSubmissionKeys(source.blocks, keyByForm);
  return result.changed
    ? {editorjs: {...source, blocks: result.value}, changed: true}
    : {editorjs, changed: false};
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
