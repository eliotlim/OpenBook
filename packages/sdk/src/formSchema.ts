import type {
  AutoExpiryConfig,
  DatabaseProperty,
  DatabasePropertyType,
  DatabaseSchema,
  DatabaseSelectOption,
  RowInput,
} from './database';

/** Form controls supported by the shared form runtime. */
export const FORM_FIELD_KINDS = [
  'text',
  'longtext',
  'number',
  'select',
  'multiselect',
  'checkbox',
  'date',
  'email',
  'phone',
  'url',
  'rating',
  'files',
] as const;

export type FormFieldKind = typeof FORM_FIELD_KINDS[number];

/**
 * Canonical form-kind to database-property mapping. `satisfies Record<...>` is
 * deliberate: adding a field kind without mapping it is a compile-time error.
 */
export const FORM_FIELD_PROPERTY_TYPES = {
  text: 'text',
  longtext: 'text',
  number: 'number',
  select: 'select',
  multiselect: 'multi_select',
  checkbox: 'checkbox',
  date: 'date',
  email: 'email',
  phone: 'phone',
  url: 'url',
  rating: 'rating',
  files: 'files',
} as const satisfies Record<FormFieldKind, DatabasePropertyType>;

export interface FormFieldValidation {
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
}

export interface FormField {
  id: string;
  kind: FormFieldKind;
  label: string;
  placeholder?: string;
  required: boolean;
  validation?: FormFieldValidation;
  /** Choices carried by `select` / `multiselect` fields, keyed by stable ids. */
  options?: DatabaseSelectOption[];
  columnId?: string;
  honeypot?: boolean;
}

export type FormConfirmation = {message: string} | {redirectUrl: string};

export interface FormSchema {
  formId: string;
  /** Display and validation order. */
  fields: FormField[];
  submitLabel?: string;
  confirmation: FormConfirmation;
  submissionKey: string;
  enabled: boolean;
  databaseId?: string;
  maxSubmissions?: number;
  /** Passed through to the database lifecycle layer; this engine does not apply it. */
  retention?: AutoExpiryConfig;
}

/** Machine-readable validation codes. User-facing text belongs in FORM-5. */
export const FORM_VALIDATION_ERROR_CODES = [
  'required',
  'type',
  'min',
  'max',
  'minLength',
  'maxLength',
  'pattern',
  'option',
  'unknown_field',
  'too_large',
  'date_format',
  'email_format',
  'url_format',
  'phone_format',
] as const;

export type FormValidationErrorCode = typeof FORM_VALIDATION_ERROR_CODES[number];

export interface FormValidationError {
  fieldId: string;
  code: FormValidationErrorCode;
}

export type FormSubmissionValue = string | number | boolean | string[];
export type CoercedSubmission = Record<string, FormSubmissionValue>;

export type SubmissionValidationResult =
  | {ok: true; coerced: CoercedSubmission}
  | {ok: false; errors: FormValidationError[]}
  | {honeypot: true};

/**
 * UTF-8 byte ceilings for every variable-size field representation. Numeric and
 * boolean kinds have fixed-size primitive representations and therefore need no
 * byte cap. Array caps cover the sum of their string payloads.
 */
export const FORM_FIELD_BYTE_CAPS = {
  text: 1_024,
  longtext: 65_536,
  select: 512,
  multiselect: 16_384,
  date: 64,
  email: 320,
  phone: 64,
  url: 2_048,
  files: 32_768,
} as const satisfies Partial<Record<FormFieldKind, number>>;

/** Independent count limits prevent adversarial arrays from forcing full walks. */
export const FORM_MULTISELECT_MAX_ITEMS = 100;
export const FORM_FILES_MAX_ITEMS = 20;

/**
 * JavaScript RegExp has no execution timeout. Patterns are therefore limited to
 * 256 code units, evaluated only against inputs of at most 1,024 code units,
 * and screened conservatively. The screen rejects backreferences, lookarounds
 * and other special groups except `(?:...)`, quantified groups containing
 * alternation or another quantifier, more than eight quantifier markers, and
 * quantified atoms with overlapping character sets separated only by optional
 * atoms. Only literals and simple positive character-class sets/ranges can prove
 * disjoint; dots, shorthands, negated/complex classes, and groups are assumed to
 * overlap. This intentionally over-rejects author-supplied patterns. Accepted
 * patterns are still not guaranteed to execute in linear time in the host engine.
 */
export const FORM_PATTERN_MAX_LENGTH = 256;
export const FORM_PATTERN_INPUT_MAX_LENGTH = 1_024;

const UTF8 = new TextEncoder();
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const PHONE_CHARS_RE = /^\+?[0-9().\-\s]+$/;
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2})?)?$/;

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function setOwn(target: Record<string, FormSubmissionValue> | Record<string, unknown>, key: string, value: FormSubmissionValue): void {
  Object.defineProperty(target, key, {value, enumerable: true, configurable: true, writable: true});
}

function stringFits(value: string, cap: number): boolean {
  // UTF-8 is never shorter than the JS code-unit count, so reject huge strings
  // before TextEncoder allocates an equally huge byte array.
  return value.length <= cap && UTF8.encode(value).byteLength <= cap;
}

function stringArrayFits(values: string[], cap: number): boolean {
  let bytes = 0;
  for (const value of values) {
    const remaining = cap - bytes;
    if (!stringFits(value, remaining)) return false;
    bytes += UTF8.encode(value).byteLength;
  }
  return true;
}

function isStringKind(kind: FormFieldKind): boolean {
  switch (kind) {
  case 'text':
  case 'longtext':
  case 'select':
  case 'date':
  case 'email':
  case 'phone':
  case 'url':
    return true;
  case 'number':
  case 'multiselect':
  case 'checkbox':
  case 'rating':
  case 'files':
    return false;
  }
}

function isEmptyForField(field: FormField, value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (isStringKind(field.kind) && typeof value === 'string') return value.trim().length === 0;
  if ((field.kind === 'multiselect' || field.kind === 'files') && Array.isArray(value)) return value.length === 0;
  // Required checkboxes model an acknowledgement/consent gate.
  return field.kind === 'checkbox' && field.required && value === false;
}

function hasHoneypotValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function addLengthErrors(field: FormField, length: number, errors: FormValidationError[]): void {
  const {minLength, maxLength} = field.validation ?? {};
  if (minLength !== undefined && length < minLength) errors.push({fieldId: field.id, code: 'minLength'});
  if (maxLength !== undefined && length > maxLength) errors.push({fieldId: field.id, code: 'maxLength'});
}

function addNumberErrors(field: FormField, value: number, errors: FormValidationError[]): void {
  const {min, max} = field.validation ?? {};
  if (min !== undefined && value < min) errors.push({fieldId: field.id, code: 'min'});
  if (max !== undefined && value > max) errors.push({fieldId: field.id, code: 'max'});
}

interface PatternRange {
  start: number;
  end: number;
}

// `null` means the atom's character set cannot be proved narrow, so it is
// treated as overlapping every other set.
type PatternCharacterSet = PatternRange[] | null;
const PATTERN_LITERAL_ESCAPES = new Set('\\.-*+?()[]{}|^$/');

interface PatternAtom {
  characterSet: PatternCharacterSet;
  quantified: boolean;
  optional: boolean;
}

interface PatternFrame {
  hasAlternation: boolean;
  hasQuantifier: boolean;
  hasEmptyAlternative: boolean;
  atoms: PatternAtom[];
}

function literalCharacterSet(char: string): PatternCharacterSet {
  const code = char.charCodeAt(0);
  return [{start: code, end: code}];
}

function simpleClassCharacterSet(source: string): PatternCharacterSet {
  if (source.startsWith('^')) return null;

  const characters: Array<{code: number; rangeMarker: boolean}> = [];
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (char !== '\\') {
      characters.push({code: char.charCodeAt(0), rangeMarker: char === '-'});
      continue;
    }

    const escaped = source[i + 1];
    // Only escaped regex punctuation is unambiguously a literal code unit.
    // Shorthands, Unicode properties, and character/control escapes stay broad.
    if (escaped === undefined || !PATTERN_LITERAL_ESCAPES.has(escaped)) return null;
    characters.push({code: escaped.charCodeAt(0), rangeMarker: false});
    i += 1;
  }

  const ranges: PatternRange[] = [];
  if (characters.some((char, index) => (
    char.rangeMarker
    && (characters[index - 1]?.rangeMarker || characters[index + 1]?.rangeMarker)
  ))) return null;
  for (let i = 0; i < characters.length;) {
    const start = characters[i];
    const marker = characters[i + 1];
    const end = characters[i + 2];
    if (!start.rangeMarker && marker?.rangeMarker && end && !end.rangeMarker) {
      if (start.code > end.code) return null;
      ranges.push({start: start.code, end: end.code});
      i += 3;
    } else {
      ranges.push({start: start.code, end: start.code});
      i += 1;
    }
  }
  return ranges;
}

function characterSetsOverlap(left: PatternCharacterSet, right: PatternCharacterSet): boolean {
  if (left === null || right === null) return true;
  return left.some((a) => right.some((b) => a.start <= b.end && b.start <= a.end));
}

function appendPatternAtom(frame: PatternFrame, characterSet: PatternCharacterSet, optional = false): void {
  frame.atoms.push({characterSet, quantified: false, optional});
}

function hasOverlappingQuantifiedAtom(frame: PatternFrame): boolean {
  const atomIndex = frame.atoms.length - 1;
  const atom = frame.atoms[atomIndex];
  if (!atom) return false;
  // Moving left, a required atom blocks earlier candidates, but is itself still
  // a candidate when quantified because no atom lies between it and this one.
  for (let i = atomIndex - 1; i >= 0; i -= 1) {
    const candidate = frame.atoms[i];
    if (candidate.quantified && characterSetsOverlap(candidate.characterSet, atom.characterSet)) return true;
    if (!candidate.optional) break;
  }
  return false;
}

function quantifyLastPatternAtom(frame: PatternFrame, optional: boolean): boolean {
  const atom = frame.atoms[frame.atoms.length - 1];
  if (!atom || atom.quantified) return false;
  atom.quantified = true;
  atom.optional ||= optional;
  return hasOverlappingQuantifiedAtom(frame);
}

function quantifierAt(pattern: string, index: number): {end: number; optional: boolean} {
  const char = pattern[index];
  if (char !== '{') return {end: index, optional: char === '*' || char === '?'};
  const match = /^\{(\d+)(?:,(\d*))?\}/.exec(pattern.slice(index));
  if (!match) return {end: index, optional: false};
  return {end: index + match[0].length - 1, optional: Number(match[1]) === 0};
}

function patternFrame(): PatternFrame {
  return {hasAlternation: false, hasQuantifier: false, hasEmptyAlternative: false, atoms: []};
}

/**
 * Conservative structural screen for common exponential and high-degree
 * backtracking forms. Flat atom sequences are tracked per concatenation branch.
 * Groups containing quantifiers are treated as quantified universal atoms for
 * overlap purposes.
 */
function isUnsafePattern(pattern: string): boolean {
  if (/\\(?:[1-9]|k<)/.test(pattern)) return true;
  const frames: PatternFrame[] = [patternFrame()];
  let quantifiers = 0;

  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === '\\') {
      const escaped = pattern[i + 1];
      if (escaped !== undefined && escaped !== 'b' && escaped !== 'B') {
        const isLiteral = PATTERN_LITERAL_ESCAPES.has(escaped);
        appendPatternAtom(frames[frames.length - 1], isLiteral ? literalCharacterSet(escaped) : null);
      }
      i += 1;
      continue;
    }
    if (char === '[') {
      let end = i + 1;
      for (; end < pattern.length && pattern[end] !== ']'; end += 1) {
        if (pattern[end] === '\\') end += 1;
      }
      if (end >= pattern.length) return true;
      appendPatternAtom(frames[frames.length - 1], simpleClassCharacterSet(pattern.slice(i + 1, end)));
      i = end;
      continue;
    }
    if (char === '(') {
      if (pattern[i + 1] === '?' && pattern[i + 2] !== ':') return true;
      if (pattern[i + 1] === '?' && pattern[i + 2] === ':') i += 2;
      frames.push(patternFrame());
      continue;
    }
    if (char === '|') {
      const frame = frames[frames.length - 1];
      frame.hasAlternation = true;
      frame.hasEmptyAlternative ||= frame.atoms.every((atom) => atom.optional);
      frame.atoms = [];
      continue;
    }
    if (char === ')') {
      if (frames.length === 1) continue;
      const frame = frames.pop()!;
      const next = pattern[i + 1];
      const groupIsDirectlyQuantified = next === '*' || next === '+' || next === '?' || next === '{';
      if (groupIsDirectlyQuantified && (frame.hasAlternation || frame.hasQuantifier)) return true;
      const parent = frames[frames.length - 1];
      parent.hasAlternation ||= frame.hasAlternation;
      const groupIsQuantified = frame.hasQuantifier || groupIsDirectlyQuantified;
      parent.hasQuantifier ||= groupIsQuantified;
      const canMatchEmpty = frame.hasEmptyAlternative || frame.atoms.every((atom) => atom.optional);
      const groupAtom: PatternAtom = {
        characterSet: null,
        quantified: groupIsQuantified,
        optional: canMatchEmpty || (groupIsDirectlyQuantified && quantifierAt(pattern, i + 1).optional),
      };
      parent.atoms.push(groupAtom);
      if (groupIsQuantified && hasOverlappingQuantifiedAtom(parent)) return true;
      continue;
    }
    if (char === '*' || char === '+' || char === '?' || char === '{') {
      const frame = frames[frames.length - 1];
      const quantifier = quantifierAt(pattern, i);
      frame.hasQuantifier = true;
      quantifiers += 1;
      // A small complexity budget also bounds high-degree polynomial patterns.
      if (quantifiers > 8) return true;
      if (quantifyLastPatternAtom(frame, quantifier.optional)) return true;
      i = quantifier.end;
      continue;
    }
    if (char !== '^' && char !== '$') appendPatternAtom(frames[frames.length - 1], char === '.' ? null : literalCharacterSet(char));
  }
  return false;
}

function addPatternError(field: FormField, value: string, errors: FormValidationError[]): void {
  const pattern = field.validation?.pattern;
  if (pattern === undefined) return;
  if (
    typeof pattern !== 'string'
    || pattern.length > FORM_PATTERN_MAX_LENGTH
    || value.length > FORM_PATTERN_INPUT_MAX_LENGTH
    || isUnsafePattern(pattern)
  ) {
    errors.push({fieldId: field.id, code: 'pattern'});
    return;
  }
  try {
    if (!new RegExp(pattern).test(value)) errors.push({fieldId: field.id, code: 'pattern'});
  } catch {
    errors.push({fieldId: field.id, code: 'pattern'});
  }
}

function isIso8601(value: string): boolean {
  const match = ISO_DATE_RE.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day < 1 || day > monthDays[month - 1]) return false;
  if (match[4] === undefined) return true;
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = match[6] === undefined ? 0 : Number(match[6]);
  if (hour > 23 || minute > 59 || second > 59) return false;
  const zone = match[8];
  if (zone && zone !== 'Z') {
    const [zoneHour, zoneMinute] = zone.slice(1).split(':').map(Number);
    if (zoneHour > 23 || zoneMinute > 59) return false;
  }
  return !Number.isNaN(Date.parse(value));
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname.length > 0;
  } catch {
    return false;
  }
}

function isPhone(value: string): boolean {
  if (!PHONE_CHARS_RE.test(value)) return false;
  const digits = value.replace(/\D/g, '').length;
  return digits >= 7 && digits <= 15;
}

/**
 * Validate untrusted submitted values without I/O or mutation. Values retain
 * their runtime types; "coercion" is limited to trimming syntactic strings and
 * file refs. Numeric strings, boxed primitives, and scalar/array confusion are
 * rejected rather than converted.
 */
export function validateSubmission(schema: FormSchema, values: Record<string, unknown>): SubmissionValidationResult {
  if (!values || typeof values !== 'object' || Array.isArray(values)) {
    return {ok: false, errors: [{fieldId: '', code: 'type'}]};
  }

  for (const field of schema.fields) {
    if (field.honeypot && hasOwn(values, field.id) && hasHoneypotValue(values[field.id])) {
      return {honeypot: true};
    }
  }

  const errors: FormValidationError[] = [];
  const knownIds = new Set(schema.fields.map((field) => field.id));
  for (const fieldId of Object.keys(values)) {
    if (!knownIds.has(fieldId)) errors.push({fieldId, code: 'unknown_field'});
  }

  const coerced: CoercedSubmission = {};
  for (const field of schema.fields) {
    if (field.honeypot) continue;
    const present = hasOwn(values, field.id);
    const raw = present ? values[field.id] : undefined;
    if (!present || isEmptyForField(field, raw)) {
      if (field.required) errors.push({fieldId: field.id, code: 'required'});
      continue;
    }

    const before = errors.length;
    let value: FormSubmissionValue | undefined;
    switch (field.kind) {
    case 'text':
    case 'longtext': {
      if (typeof raw !== 'string') {
        errors.push({fieldId: field.id, code: 'type'});
        break;
      }
      if (!stringFits(raw, FORM_FIELD_BYTE_CAPS[field.kind])) {
        errors.push({fieldId: field.id, code: 'too_large'});
        break;
      }
      addLengthErrors(field, raw.length, errors);
      addPatternError(field, raw, errors);
      value = raw;
      break;
    }
    case 'number': {
      if (typeof raw !== 'number' || !Number.isFinite(raw)) {
        errors.push({fieldId: field.id, code: 'type'});
        break;
      }
      addNumberErrors(field, raw, errors);
      value = raw;
      break;
    }
    case 'rating': {
      if (typeof raw !== 'number' || !Number.isFinite(raw) || !Number.isInteger(raw)) {
        errors.push({fieldId: field.id, code: 'type'});
        break;
      }
      if (raw < 1) errors.push({fieldId: field.id, code: 'min'});
      if (raw > 5) errors.push({fieldId: field.id, code: 'max'});
      addNumberErrors(field, raw, errors);
      value = raw;
      break;
    }
    case 'checkbox':
      if (typeof raw !== 'boolean') errors.push({fieldId: field.id, code: 'type'});
      else value = raw;
      break;
    case 'select': {
      if (typeof raw !== 'string') {
        errors.push({fieldId: field.id, code: 'type'});
        break;
      }
      if (!stringFits(raw, FORM_FIELD_BYTE_CAPS.select)) {
        errors.push({fieldId: field.id, code: 'too_large'});
        break;
      }
      addLengthErrors(field, raw.length, errors);
      if (field.options && !field.options.some((option) => option.id === raw)) {
        errors.push({fieldId: field.id, code: 'option'});
      }
      addPatternError(field, raw, errors);
      value = raw;
      break;
    }
    case 'multiselect':
    case 'files': {
      if (!Array.isArray(raw)) {
        errors.push({fieldId: field.id, code: 'type'});
        break;
      }
      const itemCap = field.kind === 'multiselect' ? FORM_MULTISELECT_MAX_ITEMS : FORM_FILES_MAX_ITEMS;
      if (raw.length > itemCap) {
        errors.push({fieldId: field.id, code: 'too_large'});
        break;
      }
      if (!raw.every((item) => typeof item === 'string' && item.trim().length > 0)) {
        errors.push({fieldId: field.id, code: 'type'});
        break;
      }
      const strings = raw as string[];
      if (!stringArrayFits(strings, FORM_FIELD_BYTE_CAPS[field.kind])) {
        errors.push({fieldId: field.id, code: 'too_large'});
        break;
      }
      addLengthErrors(field, strings.length, errors);
      if (field.kind === 'multiselect' && field.options) {
        const optionIds = new Set(field.options.map((option) => option.id));
        if (strings.some((item) => !optionIds.has(item))) errors.push({fieldId: field.id, code: 'option'});
      }
      value = field.kind === 'files' ? strings.map((item) => item.trim()) : [...strings];
      break;
    }
    case 'date':
    case 'email':
    case 'phone':
    case 'url': {
      if (typeof raw !== 'string') {
        errors.push({fieldId: field.id, code: 'type'});
        break;
      }
      if (!stringFits(raw, FORM_FIELD_BYTE_CAPS[field.kind])) {
        errors.push({fieldId: field.id, code: 'too_large'});
        break;
      }
      const normalized = raw.trim();
      addLengthErrors(field, normalized.length, errors);
      if (field.kind === 'date' && !isIso8601(normalized)) errors.push({fieldId: field.id, code: 'date_format'});
      if (field.kind === 'email' && !EMAIL_RE.test(normalized)) errors.push({fieldId: field.id, code: 'email_format'});
      if (field.kind === 'phone' && !isPhone(normalized)) errors.push({fieldId: field.id, code: 'phone_format'});
      if (field.kind === 'url' && !isHttpUrl(normalized)) errors.push({fieldId: field.id, code: 'url_format'});
      addPatternError(field, normalized, errors);
      value = normalized;
      break;
    }
    default: {
      const _exhaustive: never = field.kind;
      void _exhaustive;
    }
    }
    if (errors.length === before && value !== undefined) setOwn(coerced, field.id, value);
  }

  return errors.length > 0 ? {ok: false, errors} : {ok: true, coerced};
}

export const FORM_PROJECTION_WARNING_CODES = [
  'unbound_field',
  'column_not_found',
  'column_type_mismatch',
] as const;

export type FormProjectionWarningCode = typeof FORM_PROJECTION_WARNING_CODES[number];

export interface FormProjectionWarning {
  fieldId: string;
  code: FormProjectionWarningCode;
}

export interface SubmissionRowProjection {
  rowInput: RowInput;
  warnings: FormProjectionWarning[];
}

/** Project a validated submission onto compatible, bound database properties. */
export function submissionToRowInput(
  schema: FormSchema,
  coerced: CoercedSubmission,
  dbSchema: DatabaseSchema,
): SubmissionRowProjection {
  const properties: Record<string, unknown> = {};
  const warnings: FormProjectionWarning[] = [];
  const dbProperties = new Map(dbSchema.properties.map((property) => [property.id, property]));

  for (const field of schema.fields) {
    if (field.honeypot || !hasOwn(coerced, field.id)) continue;
    if (!field.columnId) {
      warnings.push({fieldId: field.id, code: 'unbound_field'});
      continue;
    }
    const property = dbProperties.get(field.columnId);
    if (!property) {
      warnings.push({fieldId: field.id, code: 'column_not_found'});
      continue;
    }
    if (property.type !== FORM_FIELD_PROPERTY_TYPES[field.kind]) {
      warnings.push({fieldId: field.id, code: 'column_type_mismatch'});
      continue;
    }
    const value = coerced[field.id];
    setOwn(properties, property.id, Array.isArray(value) ? [...value] : value);
  }

  return {rowInput: {properties}, warnings};
}

export interface PlannedFormColumn {
  field: FormField;
  proposedProperty: DatabaseProperty;
}

/** Compute, but do not apply, deterministic database properties for unbound fields. */
export function planColumnCreation(schema: FormSchema, dbSchema: DatabaseSchema): PlannedFormColumn[] {
  const usedIds = new Set(dbSchema.properties.map((property) => property.id));
  const plan: PlannedFormColumn[] = [];

  for (const field of schema.fields) {
    // Honeypots are anti-automation controls, never stored user data.
    if (field.honeypot || field.columnId) continue;
    const baseId = `form_${field.id || 'field'}`;
    let id = baseId;
    let suffix = 2;
    while (usedIds.has(id)) {
      id = `${baseId}_${suffix}`;
      suffix += 1;
    }
    usedIds.add(id);

    const proposedProperty: DatabaseProperty = {
      id,
      name: field.label,
      type: FORM_FIELD_PROPERTY_TYPES[field.kind],
      ...(field.options && (field.kind === 'select' || field.kind === 'multiselect')
        ? {options: field.options.map((option) => ({...option}))}
        : {}),
      ...(field.kind === 'rating' ? {numberTarget: 5} : {}),
    };
    plan.push({field, proposedProperty});
  }
  return plan;
}
