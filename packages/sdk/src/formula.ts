/**
 * A small, dependency-free expression language for **formula properties** — the
 * database analogue of a spreadsheet's `=` column. Where an `expr` property
 * projects a *reactive cell* from the row page's document, a `formula` property
 * computes from the row's *other properties*: `prop("Price") * prop("Qty")`.
 *
 * The language is intentionally tiny but covers the everyday cases:
 *
 *  - literals: numbers (`12`, `3.14`), strings (`"hi"`, `'hi'`), `true`/`false`
 *  - property refs: `prop("Full Name")` (any name) or a bare `Price` (single word)
 *  - arithmetic `+ - * / %`, unary `-`, comparison `== != < > <= >=`,
 *    boolean `&& || !` (with `and`/`or`/`not` aliases), and a ternary `c ? a : b`
 *  - functions: `if`, `round`, `floor`, `ceil`, `abs`, `min`, `max`, `pow`,
 *    `sqrt`, `concat`, `length`, `lower`, `upper`, `contains`, `empty`, `number`,
 *    `format`, `sum`, `avg`
 *
 * Evaluation never throws to the caller: a parse or runtime error surfaces as a
 * {@link FormulaError} value (so a bad formula shows an inline error in its cell
 * instead of crashing the table). Property lookups go through a caller-supplied
 * `resolve` function, which lets the database layer resolve other formulas
 * lazily and guard against reference cycles.
 */

/** A formula that could not be parsed or evaluated. Rendered inline in the cell. */
export class FormulaError {
  constructor(public readonly message: string) {}
}

export type FormulaValue = number | string | boolean | null | FormulaError;

/** Resolve a property reference by name to its formula-facing value. */
export type FormulaResolver = (name: string) => unknown;

// ── Tokenizer ────────────────────────────────────────────────────────────────

type TokenType = 'num' | 'str' | 'ident' | 'op' | 'punc' | 'eof';
interface Token {
  type: TokenType;
  value: string;
}

const TWO_CHAR_OPS = new Set(['==', '!=', '<=', '>=', '&&', '||']);
const ONE_CHAR_OPS = new Set(['+', '-', '*', '/', '%', '<', '>', '!', '=']);

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i += 1;
      continue;
    }
    // String literal — single or double quoted, with backslash escapes.
    if (c === '"' || c === '\'') {
      const quote = c;
      let str = '';
      i += 1;
      while (i < n && src[i] !== quote) {
        if (src[i] === '\\' && i + 1 < n) {
          const next = src[i + 1];
          str += next === 'n' ? '\n' : next === 't' ? '\t' : next;
          i += 2;
        } else {
          str += src[i];
          i += 1;
        }
      }
      if (i >= n) throw new FormulaError('Unterminated string');
      i += 1; // closing quote
      tokens.push({type: 'str', value: str});
      continue;
    }
    // Number literal (integer or decimal).
    if (c >= '0' && c <= '9') {
      let num = '';
      while (i < n && ((src[i] >= '0' && src[i] <= '9') || src[i] === '.')) {
        num += src[i];
        i += 1;
      }
      tokens.push({type: 'num', value: num});
      continue;
    }
    // Identifier (function name, bare property ref, or keyword).
    if (/[A-Za-z_]/.test(c)) {
      let id = '';
      while (i < n && /[A-Za-z0-9_]/.test(src[i])) {
        id += src[i];
        i += 1;
      }
      tokens.push({type: 'ident', value: id});
      continue;
    }
    // Two-char then one-char operators.
    const two = src.slice(i, i + 2);
    if (TWO_CHAR_OPS.has(two)) {
      tokens.push({type: 'op', value: two});
      i += 2;
      continue;
    }
    if (ONE_CHAR_OPS.has(c)) {
      tokens.push({type: 'op', value: c});
      i += 1;
      continue;
    }
    if (c === '(' || c === ')' || c === ',' || c === '?' || c === ':') {
      tokens.push({type: 'punc', value: c});
      i += 1;
      continue;
    }
    throw new FormulaError(`Unexpected character "${c}"`);
  }
  tokens.push({type: 'eof', value: ''});
  return tokens;
}

// ── AST ──────────────────────────────────────────────────────────────────────

type Node =
  | {kind: 'num'; value: number}
  | {kind: 'str'; value: string}
  | {kind: 'bool'; value: boolean}
  | {kind: 'prop'; name: string}
  | {kind: 'unary'; op: string; arg: Node}
  | {kind: 'binary'; op: string; left: Node; right: Node}
  | {kind: 'ternary'; cond: Node; then: Node; else: Node}
  | {kind: 'call'; name: string; args: Node[]};

// Binary operator precedence (higher binds tighter).
const PRECEDENCE: Record<string, number> = {
  '||': 1,
  '&&': 2,
  '==': 3,
  '!=': 3,
  '<': 4,
  '>': 4,
  '<=': 4,
  '>=': 4,
  '+': 5,
  '-': 5,
  '*': 6,
  '/': 6,
  '%': 6,
};

/** Recursive-descent / precedence-climbing parser producing the AST above. */
class Parser {
  private pos = 0;
  constructor(private readonly tokens: Token[]) {}

  private peek(): Token {
    return this.tokens[this.pos];
  }
  private next(): Token {
    return this.tokens[this.pos++];
  }
  private expect(value: string): void {
    const t = this.next();
    if (t.value !== value) throw new FormulaError(`Expected "${value}"`);
  }

  parse(): Node {
    const node = this.parseTernary();
    if (this.peek().type !== 'eof') throw new FormulaError('Unexpected trailing input');
    return node;
  }

  private parseTernary(): Node {
    const cond = this.parseBinary(0);
    if (this.peek().value === '?') {
      this.next();
      const then = this.parseTernary();
      this.expect(':');
      const els = this.parseTernary();
      return {kind: 'ternary', cond, then, else: els};
    }
    return cond;
  }

  private parseBinary(minPrec: number): Node {
    let left = this.parseUnary();
    for (;;) {
      const t = this.peek();
      const prec = t.type === 'op' ? PRECEDENCE[t.value] : undefined;
      if (prec === undefined || prec < minPrec) break;
      this.next();
      const right = this.parseBinary(prec + 1);
      left = {kind: 'binary', op: t.value, left, right};
    }
    return left;
  }

  private parseUnary(): Node {
    const t = this.peek();
    if (t.type === 'op' && (t.value === '-' || t.value === '!')) {
      this.next();
      return {kind: 'unary', op: t.value, arg: this.parseUnary()};
    }
    return this.parsePrimary();
  }

  private parsePrimary(): Node {
    const t = this.next();
    if (t.type === 'num') return {kind: 'num', value: Number(t.value)};
    if (t.type === 'str') return {kind: 'str', value: t.value};
    if (t.value === '(') {
      const node = this.parseTernary();
      this.expect(')');
      return node;
    }
    if (t.type === 'ident') {
      const lower = t.value.toLowerCase();
      if (lower === 'true') return {kind: 'bool', value: true};
      if (lower === 'false') return {kind: 'bool', value: false};
      if (lower === 'not') return {kind: 'unary', op: '!', arg: this.parseUnary()};
      // A function call or `prop("…")`, otherwise a bare property reference.
      if (this.peek().value === '(') {
        this.next();
        const args: Node[] = [];
        if (this.peek().value !== ')') {
          args.push(this.parseTernary());
          while (this.peek().value === ',') {
            this.next();
            args.push(this.parseTernary());
          }
        }
        this.expect(')');
        if (lower === 'prop') {
          const arg = args[0];
          if (!arg || arg.kind !== 'str') throw new FormulaError('prop() needs a property name string');
          return {kind: 'prop', name: arg.value};
        }
        return {kind: 'call', name: lower, args};
      }
      return {kind: 'prop', name: t.value};
    }
    throw new FormulaError(`Unexpected "${t.value || 'end of input'}"`);
  }
}

// ── Evaluator ────────────────────────────────────────────────────────────────

const isErr = (v: unknown): v is FormulaError => v instanceof FormulaError;

const toNumber = (v: unknown): number => {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string' && v.trim() !== '') return Number(v);
  return NaN;
};

const toBool = (v: unknown): boolean => {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (v === null || v === undefined) return false;
  if (typeof v === 'string') return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  return !!v;
};

const toStr = (v: unknown): string => {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return v.map(toStr).join(', ');
  return String(v);
};

const isEmptyValue = (v: unknown): boolean =>
  v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);

/** Coerce a resolved property value into a formula-facing primitive. */
function normalizeRef(v: unknown): FormulaValue {
  if (v === undefined || v === null) return null;
  if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') return v;
  if (Array.isArray(v)) return v.map(toStr).join(', ');
  return toStr(v);
}

type Fn = (args: unknown[]) => FormulaValue;

const FUNCTIONS: Record<string, Fn> = {
  if: (a) => (toBool(a[0]) ? (a[1] as FormulaValue) : (a[2] as FormulaValue) ?? null),
  and: (a) => a.every(toBool),
  or: (a) => a.some(toBool),
  not: (a) => !toBool(a[0]),
  abs: (a) => Math.abs(toNumber(a[0])),
  round: (a) => {
    const f = a.length > 1 ? Math.pow(10, toNumber(a[1])) : 1;
    return Math.round(toNumber(a[0]) * f) / f;
  },
  floor: (a) => Math.floor(toNumber(a[0])),
  ceil: (a) => Math.ceil(toNumber(a[0])),
  sqrt: (a) => Math.sqrt(toNumber(a[0])),
  pow: (a) => Math.pow(toNumber(a[0]), toNumber(a[1])),
  min: (a) => Math.min(...a.map(toNumber)),
  max: (a) => Math.max(...a.map(toNumber)),
  sum: (a) => a.reduce<number>((acc, x) => acc + toNumber(x), 0),
  avg: (a) => (a.length ? a.reduce<number>((acc, x) => acc + toNumber(x), 0) / a.length : 0),
  number: (a) => toNumber(a[0]),
  length: (a) => toStr(a[0]).length,
  concat: (a) => a.map(toStr).join(''),
  lower: (a) => toStr(a[0]).toLowerCase(),
  upper: (a) => toStr(a[0]).toUpperCase(),
  contains: (a) => toStr(a[0]).toLowerCase().includes(toStr(a[1]).toLowerCase()),
  empty: (a) => isEmptyValue(a[0]),
  format: (a) => toStr(a[0]),
};

function evalNode(node: Node, resolve: FormulaResolver): FormulaValue {
  switch (node.kind) {
  case 'num':
    return node.value;
  case 'str':
    return node.value;
  case 'bool':
    return node.value;
  case 'prop': {
    const ref = resolve(node.name);
    // A resolver may return a FormulaError (e.g. a circular formula ref); let it
    // propagate instead of being stringified into the surrounding expression.
    return isErr(ref) ? ref : normalizeRef(ref);
  }
  case 'unary': {
    const arg = evalNode(node.arg, resolve);
    if (isErr(arg)) return arg;
    return node.op === '-' ? -toNumber(arg) : !toBool(arg);
  }
  case 'ternary': {
    const cond = evalNode(node.cond, resolve);
    if (isErr(cond)) return cond;
    return toBool(cond) ? evalNode(node.then, resolve) : evalNode(node.else, resolve);
  }
  case 'binary':
    return evalBinary(node, resolve);
  case 'call': {
    const fn = FUNCTIONS[node.name];
    if (!fn) return new FormulaError(`Unknown function "${node.name}"`);
    const args: unknown[] = [];
    for (const a of node.args) {
      const v = evalNode(a, resolve);
      if (isErr(v)) return v;
      args.push(v);
    }
    try {
      return fn(args);
    } catch {
      return new FormulaError(`Error in ${node.name}()`);
    }
  }
  }
}

function evalBinary(node: Extract<Node, {kind: 'binary'}>, resolve: FormulaResolver): FormulaValue {
  // Short-circuit boolean operators.
  if (node.op === '&&' || node.op === '||') {
    const left = evalNode(node.left, resolve);
    if (isErr(left)) return left;
    if (node.op === '&&') return toBool(left) ? evalNode(node.right, resolve) : false;
    return toBool(left) ? true : evalNode(node.right, resolve);
  }
  const left = evalNode(node.left, resolve);
  if (isErr(left)) return left;
  const right = evalNode(node.right, resolve);
  if (isErr(right)) return right;

  switch (node.op) {
  case '+':
    // `+` adds numbers but concatenates when either side is a non-numeric string.
    if (typeof left === 'string' || typeof right === 'string') {
      const ln = toNumber(left);
      const rn = toNumber(right);
      if (!Number.isNaN(ln) && !Number.isNaN(rn) && typeof left !== 'string' && typeof right !== 'string') {
        return ln + rn;
      }
      return toStr(left) + toStr(right);
    }
    return toNumber(left) + toNumber(right);
  case '-':
    return toNumber(left) - toNumber(right);
  case '*':
    return toNumber(left) * toNumber(right);
  case '/': {
    const d = toNumber(right);
    return d === 0 ? new FormulaError('Division by zero') : toNumber(left) / d;
  }
  case '%':
    return toNumber(left) % toNumber(right);
  case '==':
    return looseEquals(left, right);
  case '!=':
    return !looseEquals(left, right);
  case '<':
    return compare(left, right) < 0;
  case '>':
    return compare(left, right) > 0;
  case '<=':
    return compare(left, right) <= 0;
  case '>=':
    return compare(left, right) >= 0;
  default:
    return new FormulaError(`Unknown operator "${node.op}"`);
  }
}

function looseEquals(a: FormulaValue, b: FormulaValue): boolean {
  if (typeof a === 'number' || typeof b === 'number') {
    const an = toNumber(a);
    const bn = toNumber(b);
    if (!Number.isNaN(an) && !Number.isNaN(bn)) return an === bn;
  }
  return toStr(a) === toStr(b);
}

function compare(a: FormulaValue, b: FormulaValue): number {
  const an = toNumber(a);
  const bn = toNumber(b);
  if (!Number.isNaN(an) && !Number.isNaN(bn)) return an - bn;
  return toStr(a).localeCompare(toStr(b));
}

/**
 * Parse and evaluate `source` against a property resolver. Returns the computed
 * value, or a {@link FormulaError} for any parse/eval failure (never throws).
 */
export function evaluateFormula(source: string, resolve: FormulaResolver): FormulaValue {
  if (!source || !source.trim()) return null;
  let ast: Node;
  try {
    ast = new Parser(tokenize(source)).parse();
  } catch (e) {
    return e instanceof FormulaError ? e : new FormulaError('Invalid formula');
  }
  try {
    return evalNode(ast, resolve);
  } catch (e) {
    return e instanceof FormulaError ? e : new FormulaError('Could not evaluate');
  }
}

/**
 * The property names referenced by a formula (via `prop("…")` or bare refs).
 * Used to detect dependency cycles and to know when a formula must recompute.
 * Returns an empty list for an unparseable formula.
 */
export function formulaReferences(source: string): string[] {
  let ast: Node;
  try {
    ast = new Parser(tokenize(source)).parse();
  } catch {
    return [];
  }
  const names = new Set<string>();
  const walk = (node: Node): void => {
    switch (node.kind) {
    case 'prop':
      names.add(node.name);
      break;
    case 'unary':
      walk(node.arg);
      break;
    case 'binary':
      walk(node.left);
      walk(node.right);
      break;
    case 'ternary':
      walk(node.cond);
      walk(node.then);
      walk(node.else);
      break;
    case 'call':
      node.args.forEach(walk);
      break;
    default:
      break;
    }
  };
  walk(ast);
  return [...names];
}
