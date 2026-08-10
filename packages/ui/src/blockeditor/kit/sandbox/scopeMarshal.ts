import type {EvalRequest, EvalResult} from '../scope';

const IDENT_START = /[A-Za-z_$]/;
const IDENT_CONTINUE = /[A-Za-z0-9_$]/;
const MAX_SCOPE_DEPTH = 12;
const MAX_SCOPE_ENTRIES = 20_000;

export const UNSUPPORTED_SCOPE_ERROR = 'Sandbox scope contains an unsupported value';

/**
 * Extract free-looking identifier tokens without evaluating the source. This is
 * deliberately a conservative lexer rather than a JavaScript parser: false
 * positives only copy an additional already-safe scope value, while strings,
 * comments, and property names are skipped so ordinary formulas stay small.
 * `scope.foo` is also recognised as an explicit escape hatch for names that are
 * JavaScript keywords (for example an input named `class`).
 */
export function referencedIdentifiers(source: string): Set<string> {
  const identifiers = new Set<string>();
  let i = 0;
  let previousToken = '';
  let previousSignificant = '';

  const skipQuoted = (quote: string): void => {
    i += 1;
    while (i < source.length) {
      if (source[i] === '\\') {
        i += 2;
      } else if (source[i] === quote) {
        i += 1;
        return;
      } else {
        i += 1;
      }
    }
  };

  while (i < source.length) {
    const char = source[i];
    if (/\s/.test(char)) {
      i += 1;
      continue;
    }
    if (char === '/' && source[i + 1] === '/') {
      i += 2;
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (char === '/' && source[i + 1] === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i = Math.min(source.length, i + 2);
      continue;
    }
    if (char === '\'' || char === '"') {
      skipQuoted(char);
      previousSignificant = 'literal';
      continue;
    }
    if (IDENT_START.test(char)) {
      const start = i++;
      while (i < source.length && IDENT_CONTINUE.test(source[i])) i += 1;
      const token = source.slice(start, i);
      const isProperty = previousSignificant === '.';
      if (!isProperty) identifiers.add(token);
      if (isProperty && previousToken === 'scope') identifiers.add(token);
      previousToken = token;
      previousSignificant = token;
      continue;
    }
    previousSignificant = char;
    previousToken = char === '.' ? previousToken : '';
    i += 1;
  }
  return identifiers;
}

interface CloneState {
  entries: number;
  seen: Set<object>;
}

function cloneScopeValue(value: unknown, state: CloneState, depth: number): unknown {
  if (depth > MAX_SCOPE_DEPTH || ++state.entries > MAX_SCOPE_ENTRIES) {
    throw new Error(`${UNSUPPORTED_SCOPE_ERROR}: value is too large`);
  }
  if (value === null || value === undefined || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return value;
  if (typeof value !== 'object') throw new Error(`${UNSUPPORTED_SCOPE_ERROR}: ${typeof value}`);
  if (state.seen.has(value)) throw new Error(`${UNSUPPORTED_SCOPE_ERROR}: cyclic object`);
  state.seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => cloneScopeValue(item, state, depth + 1));
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`${UNSUPPORTED_SCOPE_ERROR}: non-plain object`);
    }
    const clone: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      Object.defineProperty(clone, key, {
        value: cloneScopeValue(item, state, depth + 1),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return clone;
  } finally {
    state.seen.delete(value);
  }
}

/** Select and deep-copy only referenced, supported values before postMessage. */
export function prepareEvalRequest(request: EvalRequest): EvalRequest | EvalResult {
  const referenced = referencedIdentifiers(request.source);
  const scope: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  try {
    for (const name of referenced) {
      if (!Object.prototype.hasOwnProperty.call(request.scope, name)) continue;
      Object.defineProperty(scope, name, {
        value: cloneScopeValue(request.scope[name], {entries: 0, seen: new Set()}, 0),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return {...request, scope};
  } catch (error) {
    return {error: error instanceof Error ? error.message : String(error)};
  }
}

export function isEvalResult(value: EvalRequest | EvalResult): value is EvalResult {
  return !('kind' in value);
}
