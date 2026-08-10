/**
 * A deliberately small expression interpreter for standalone exports.
 *
 * Grammar: literals, tokenized cells/get(), arrays and plain objects, safe
 * member reads, unary/binary/ternary operators, expression-bodied arrows,
 * allowlisted Math/Array/Object/Number helpers, and non-mutating array/string
 * helpers. A bounded statement shell covers the two real bundled programs:
 * local const/let declarations, local assignment, counted `for (let i…; i++)`,
 * local-array push, and return.
 * Unknown identifiers, assignments, constructors, prototype keys and every
 * non-allowlisted call fail closed.
 */

const SOURCE_LIMIT = 20_000;
const TOKEN_LIMIT = 4_096;
const STEP_LIMIT = 30_000;
const COLLECTION_LIMIT = 10_000;
const STRING_LIMIT = 100_000;
const BAD_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const BINARY_PRECEDENCE = new Map([
  ['??', 1], ['||', 2], ['&&', 3],
  ['==', 4], ['!=', 4], ['===', 4], ['!==', 4],
  ['<', 5], ['<=', 5], ['>', 5], ['>=', 5],
  ['+', 6], ['-', 6], ['*', 7], ['/', 7], ['%', 7], ['**', 8],
]);
const MATH_CALLS = new Set([
  'abs', 'acos', 'acosh', 'asin', 'asinh', 'atan', 'atanh', 'atan2', 'cbrt',
  'ceil', 'clz32', 'cos', 'cosh', 'exp', 'expm1', 'floor', 'fround', 'hypot',
  'imul', 'log', 'log10', 'log1p', 'log2', 'max', 'min', 'pow', 'round',
  'sign', 'sin', 'sinh', 'sqrt', 'tan', 'tanh', 'trunc',
]);
const MATH_VALUES = new Set(['E', 'LN2', 'LN10', 'LOG2E', 'LOG10E', 'PI', 'SQRT1_2', 'SQRT2']);
const GLOBALS = Object.freeze({
  Math: Object.freeze({kind: 'Math'}),
  Array: Object.freeze({kind: 'Array'}),
  Object: Object.freeze({kind: 'Object'}),
  Number: Object.freeze({kind: 'Number'}),
  String: Object.freeze({kind: 'String'}),
  Boolean: Object.freeze({kind: 'Boolean'}),
});

const stop = () => { throw new Error('unsupported expression'); };
const isIdentifierStart = (c) => /[A-Za-z_$]/.test(c);
const isIdentifierPart = (c) => /[A-Za-z0-9_$]/.test(c);

function tokenize(source) {
  if (typeof source !== 'string' || source.length > SOURCE_LIMIT) stop();
  const out = [];
  let at = 0;
  const push = (type, value) => {
    if (out.length >= TOKEN_LIMIT) stop();
    out.push({type, value});
  };
  while (at < source.length) {
    const c = source[at];
    if (/\s/.test(c)) { at += 1; continue; }
    if (source.startsWith('__C__{', at)) {
      const end = source.indexOf('}__', at + 6);
      if (end < 0 || end === at + 6) stop();
      push('cell', source.slice(at + 6, end));
      at = end + 3;
      continue;
    }
    if (c === '"' || c === "'") {
      const quote = c;
      let value = '';
      at += 1;
      let closed = false;
      while (at < source.length) {
        const ch = source[at++];
        if (ch === quote) { closed = true; break; }
        if (ch === '\n' || ch === '\r') stop();
        if (ch !== '\\') { value += ch; continue; }
        if (at >= source.length) stop();
        const esc = source[at++];
        const simple = {b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '0': '\0'}[esc];
        if (simple !== undefined) { value += simple; continue; }
        if (esc === 'u' || esc === 'x') {
          const size = esc === 'u' ? 4 : 2;
          const hex = source.slice(at, at + size);
          if (!new RegExp(`^[0-9a-fA-F]{${size}}$`).test(hex)) stop();
          value += String.fromCharCode(Number.parseInt(hex, 16));
          at += size;
          continue;
        }
        value += esc;
      }
      if (!closed || value.length > STRING_LIMIT) stop();
      push('literal', value);
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(source[at + 1] ?? ''))) {
      const match = source.slice(at).match(/^(?:0[xX][0-9a-fA-F]+|0[bB][01]+|0[oO][0-7]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/);
      if (!match) stop();
      const value = Number(match[0]);
      if (!Number.isFinite(value)) stop();
      push('literal', value);
      at += match[0].length;
      continue;
    }
    if (isIdentifierStart(c)) {
      let end = at + 1;
      while (end < source.length && isIdentifierPart(source[end])) end += 1;
      push('identifier', source.slice(at, end));
      at = end;
      continue;
    }
    const operator = ['===', '!==', '**', '++', '<=', '>=', '==', '!=', '&&', '||', '??', '=>'].find((op) => source.startsWith(op, at));
    if (operator) {
      push('punct', operator);
      at += operator.length;
      continue;
    }
    if ('=+-*/%!<>()[]{}?:,.'.includes(c) || c === ';') {
      push('punct', c);
      at += 1;
      continue;
    }
    stop();
  }
  out.push({type: 'eof', value: ''});
  return out;
}

function parse(source) {
  const tokens = tokenize(source);
  let at = 0;
  const peek = (offset = 0) => tokens[at + offset] ?? tokens[tokens.length - 1];
  const take = () => tokens[at++];
  const punct = (value) => peek().type === 'punct' && peek().value === value;
  const accept = (value) => punct(value) ? (take(), true) : false;
  const expect = (value) => { if (!accept(value)) stop(); };

  const arrowParams = () => {
    let scan = at + 1;
    if (tokens[scan]?.type === 'punct' && tokens[scan].value === ')') return tokens[scan + 1]?.value === '=>';
    while (tokens[scan]?.type === 'identifier') {
      scan += 1;
      if (tokens[scan]?.value === ')') return tokens[scan + 1]?.value === '=>';
      if (tokens[scan]?.value !== ',') return false;
      scan += 1;
    }
    return false;
  };

  const expression = (minimum = 0) => {
    let left = unary();
    while (true) {
      const op = peek().type === 'punct' ? peek().value : '';
      const precedence = BINARY_PRECEDENCE.get(op);
      if (precedence === undefined || precedence < minimum) break;
      take();
      const right = expression(precedence + (op === '**' ? 0 : 1));
      left = {type: 'binary', op, left, right};
    }
    if (minimum === 0 && accept('?')) {
      const yes = expression();
      expect(':');
      left = {type: 'conditional', test: left, yes, no: expression()};
    }
    return left;
  };

  const unary = () => {
    if (peek().type === 'punct' && ['!', '+', '-'].includes(peek().value)) {
      return {type: 'unary', op: take().value, value: unary()};
    }
    let value = primary();
    while (true) {
      if (accept('.')) {
        const key = take();
        if (key.type !== 'identifier') stop();
        value = {type: 'member', object: value, key: {type: 'literal', value: key.value}};
      } else if (accept('[')) {
        const key = expression();
        expect(']');
        value = {type: 'member', object: value, key};
      } else if (accept('(')) {
        const args = [];
        if (!accept(')')) {
          do { args.push(expression()); } while (accept(','));
          expect(')');
        }
        value = {type: 'call', callee: value, args};
      } else {
        break;
      }
    }
    return value;
  };

  const primary = () => {
    const token = peek();
    if (token.type === 'literal') { take(); return {type: 'literal', value: token.value}; }
    if (token.type === 'cell') { take(); return {type: 'cell', id: token.value}; }
    if (token.type === 'identifier') {
      take();
      if (accept('=>')) return {type: 'lambda', params: [token.value], body: expression()};
      if (token.value === 'true') return {type: 'literal', value: true};
      if (token.value === 'false') return {type: 'literal', value: false};
      if (token.value === 'null') return {type: 'literal', value: null};
      if (token.value === 'undefined') return {type: 'literal', value: undefined};
      if (token.value === 'NaN') return {type: 'literal', value: Number.NaN};
      if (token.value === 'Infinity') return {type: 'literal', value: Infinity};
      return {type: 'identifier', name: token.value};
    }
    if (punct('(') && arrowParams()) {
      take();
      const params = [];
      if (!accept(')')) {
        do {
          const param = take();
          if (param.type !== 'identifier' || params.includes(param.value)) stop();
          params.push(param.value);
        } while (accept(','));
        expect(')');
      }
      expect('=>');
      return {type: 'lambda', params, body: expression()};
    }
    if (accept('(')) {
      const value = expression();
      expect(')');
      return value;
    }
    if (accept('[')) {
      const values = [];
      if (!accept(']')) {
        do { values.push(expression()); } while (accept(',') && !punct(']'));
        expect(']');
      }
      return {type: 'array', values};
    }
    if (accept('{')) {
      const entries = [];
      if (!accept('}')) {
        do {
          const key = take();
          if (key.type !== 'identifier' && key.type !== 'literal') stop();
          const name = String(key.value);
          if (BAD_KEYS.has(name)) stop();
          if (accept(':')) entries.push([name, expression()]);
          else if (key.type === 'identifier') entries.push([name, {type: 'identifier', name}]);
          else stop();
        } while (accept(',') && !punct('}'));
        expect('}');
      }
      return {type: 'object', entries};
    }
    stop();
  };

  const keyword = (value) => peek().type === 'identifier' && peek().value === value;
  const identifier = () => {
    const token = take();
    if (token.type !== 'identifier' || ['const', 'let', 'for', 'return'].includes(token.value)) stop();
    return token.value;
  };
  const declaration = () => {
    const kind = take().value;
    if (kind !== 'const' && kind !== 'let') stop();
    const entries = [];
    do {
      const name = identifier();
      expect('=');
      entries.push([name, expression()]);
    } while (accept(','));
    expect(';');
    return {type: 'declaration', kind, entries};
  };
  const update = () => {
    const name = identifier();
    if (!accept('++')) stop();
    return {type: 'update', name};
  };
  const block = () => {
    expect('{');
    const statements = [];
    while (!accept('}')) {
      if (peek().type === 'eof') stop();
      statements.push(statement());
    }
    return statements;
  };
  const statement = () => {
    if (keyword('const') || keyword('let')) return declaration();
    if (keyword('return')) {
      take();
      const value = expression();
      accept(';');
      return {type: 'return', value};
    }
    if (keyword('for')) {
      take();
      expect('(');
      if (!keyword('let')) stop();
      const init = declaration();
      const test = expression();
      expect(';');
      const next = update();
      expect(')');
      return {type: 'for', init, test, next, body: block()};
    }
    if (peek().type === 'identifier' && peek(1).value === '=') {
      const name = identifier();
      expect('=');
      const value = expression();
      expect(';');
      return {type: 'assignment', name, value};
    }
    const value = expression();
    expect(';');
    return {type: 'expressionStatement', value};
  };

  if (keyword('const') || keyword('let') || keyword('for')) {
    const statements = [];
    while (peek().type !== 'eof') statements.push(statement());
    return {type: 'program', statements};
  }
  if (keyword('return')) take();
  const tree = expression();
  accept(';');
  if (peek().type !== 'eof') stop();
  return tree;
}

const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const marker = (value, kind) => value && typeof value === 'object' && value.kind === kind && value === GLOBALS[kind];
const safeKey = (value) => {
  if (typeof value !== 'string' && typeof value !== 'number') stop();
  const key = String(value);
  if (BAD_KEYS.has(key)) stop();
  return key;
};

function interpret(tree, get, bindings) {
  let remaining = STEP_LIMIT;
  const lambdas = new WeakSet();
  const isLambda = (value) => value !== null && typeof value === 'object' && lambdas.has(value);
  const tick = (amount = 1) => { remaining -= amount; if (remaining < 0) stop(); };
  const bounded = (value) => {
    if (typeof value === 'string' && value.length > STRING_LIMIT) stop();
    if (Array.isArray(value) && value.length > COLLECTION_LIMIT) stop();
    return value;
  };
  const member = (object, keyValue) => {
    const key = safeKey(keyValue);
    if (marker(object, 'Math')) {
      if (!MATH_VALUES.has(key)) stop();
      return Math[key];
    }
    if (object === null || object === undefined) stop();
    if ((Array.isArray(object) || typeof object === 'string') && key === 'length') return object.length;
    if ((Array.isArray(object) || typeof object === 'string' || (typeof object === 'object' && object !== null)) && own(Object(object), key)) {
      const value = object[key];
      if (typeof value === 'function') stop();
      return value;
    }
    stop();
  };
  const lambda = (fn, args) => {
    if (!isLambda(fn)) stop();
    const locals = Object.create(fn.locals);
    fn.params.forEach((name, index) => { locals[name] = args[index]; });
    return visit(fn.body, locals);
  };
  const list = (value) => {
    if (!Array.isArray(value)) stop();
    if (value.length > COLLECTION_LIMIT) stop();
    return value;
  };
  const callArray = (array, name, args) => {
    const input = list(array);
    tick(input.length);
    if (name === 'slice') return input.slice(args[0], args[1]);
    if (name === 'concat') {
      const pieces = args.map((item) => Array.isArray(item) ? item : [item]);
      if (input.length + pieces.reduce((total, piece) => total + piece.length, 0) > COLLECTION_LIMIT) stop();
      return input.concat(...pieces);
    }
    if (name === 'includes') return input.includes(args[0], args[1]);
    if (name === 'indexOf') return input.indexOf(args[0], args[1]);
    if (name === 'lastIndexOf') return input.lastIndexOf(args[0], args[1]);
    if (name === 'join') {
      const separator = args[0] === undefined ? ',' : String(args[0]);
      const parts = input.map((item) => item === null || item === undefined ? '' : String(item));
      if (parts.reduce((total, part) => total + part.length, Math.max(0, parts.length - 1) * separator.length) > STRING_LIMIT) stop();
      return parts.join(separator);
    }
    if (name === 'at') return input.at(Number(args[0]));
    if (name === 'reverse') return input.slice().reverse();
    if (name === 'map') return bounded(input.map((value, index) => lambda(args[0], [value, index, input])));
    if (name === 'filter') return input.filter((value, index) => Boolean(lambda(args[0], [value, index, input])));
    if (name === 'some') return input.some((value, index) => Boolean(lambda(args[0], [value, index, input])));
    if (name === 'every') return input.every((value, index) => Boolean(lambda(args[0], [value, index, input])));
    if (name === 'find') return input.find((value, index) => Boolean(lambda(args[0], [value, index, input])));
    if (name === 'findIndex') return input.findIndex((value, index) => Boolean(lambda(args[0], [value, index, input])));
    if (name === 'flatMap') {
      const output = [];
      input.forEach((value, index) => {
        const part = list(lambda(args[0], [value, index, input]));
        if (output.length + part.length > COLLECTION_LIMIT) stop();
        output.push(...part);
      });
      return output;
    }
    if (name === 'reduce') {
      if (input.length === 0 && args.length < 2) stop();
      let index = args.length < 2 ? 1 : 0;
      let result = args.length < 2 ? input[0] : args[1];
      for (; index < input.length; index += 1) result = lambda(args[0], [result, input[index], index, input]);
      return bounded(result);
    }
    if (name === 'sort') {
      if (!isLambda(args[0])) stop();
      return input.slice().sort((a, b) => Number(lambda(args[0], [a, b])) || 0);
    }
    stop();
  };
  const callString = (value, name, args) => {
    const input = String(value);
    if (name === 'slice') return input.slice(args[0], args[1]);
    if (name === 'substring') return input.substring(args[0], args[1]);
    if (name === 'includes') return input.includes(String(args[0]), args[1]);
    if (name === 'startsWith') return input.startsWith(String(args[0]), args[1]);
    if (name === 'endsWith') return input.endsWith(String(args[0]), args[1]);
    if (name === 'indexOf') return input.indexOf(String(args[0]), args[1]);
    if (name === 'lastIndexOf') return input.lastIndexOf(String(args[0]), args[1]);
    if (name === 'toLowerCase') return input.toLowerCase();
    if (name === 'toUpperCase') return input.toUpperCase();
    if (name === 'trim') return input.trim();
    if (name === 'charAt') return input.charAt(args[0]);
    if (name === 'split') return bounded(input.split(args[0] === undefined ? undefined : String(args[0]), Math.min(COLLECTION_LIMIT, Number(args[1] ?? COLLECTION_LIMIT))));
    if (name === 'toLocaleString') return bounded(input.toLocaleString());
    stop();
  };
  const invoke = (callee, argTrees, locals) => {
    const args = argTrees.map((arg) => visit(arg, locals));
    if (callee.type === 'identifier') {
      if (callee.name === 'get') {
        if (args.length !== 1 || typeof args[0] !== 'string') stop();
        return get(args[0]);
      }
      if (callee.name === 'Number') return Number(args[0]);
      if (callee.name === 'String') return bounded(String(args[0]));
      if (callee.name === 'Boolean') return Boolean(args[0]);
      const fn = visit(callee, locals);
      if (isLambda(fn)) return lambda(fn, args);
      stop();
    }
    if (callee.type !== 'member') stop();
    const object = visit(callee.object, locals);
    const name = safeKey(visit(callee.key, locals));
    if (marker(object, 'Math')) {
      if (!MATH_CALLS.has(name)) stop();
      return bounded(Reflect.apply(Math[name], Math, args));
    }
    if (marker(object, 'Array')) {
      if (name === 'isArray') return Array.isArray(args[0]);
      if (name === 'of') return bounded(args);
      if (name === 'from') {
        const raw = args[0];
        let values;
        if (Array.isArray(raw)) values = raw.slice(0, COLLECTION_LIMIT + 1);
        else if (typeof raw === 'string') values = Array.from(raw.slice(0, COLLECTION_LIMIT + 1));
        else if (raw && typeof raw === 'object' && own(raw, 'length')) {
          const length = Math.min(COLLECTION_LIMIT + 1, Math.max(0, Math.floor(Number(raw.length))));
          values = Array.from({length}, (_, index) => own(raw, index) ? raw[index] : undefined);
        } else stop();
        bounded(values);
        return args[1] ? values.map((value, index) => lambda(args[1], [value, index])) : values;
      }
      stop();
    }
    if (marker(object, 'Object')) {
      if (!['keys', 'values', 'entries'].includes(name) || args.length !== 1 || args[0] === null || typeof args[0] !== 'object') stop();
      const keys = Object.keys(args[0]).filter((key) => !BAD_KEYS.has(key) && typeof args[0][key] !== 'function');
      if (keys.length > COLLECTION_LIMIT) stop();
      if (name === 'keys') return bounded(keys);
      if (name === 'values') return bounded(keys.map((key) => args[0][key]));
      return bounded(keys.map((key) => [key, args[0][key]]));
    }
    if (marker(object, 'Number')) {
      if (name === 'isFinite') return Number.isFinite(args[0]);
      if (name === 'isInteger') return Number.isInteger(args[0]);
      if (name === 'isNaN') return Number.isNaN(args[0]);
      stop();
    }
    if (Array.isArray(object)) return callArray(object, name, args);
    if (typeof object === 'string') return callString(object, name, args);
    if (typeof object === 'number') {
      if (name === 'toLocaleString') return bounded(object.toLocaleString());
      if (name === 'toFixed') return object.toFixed(Math.min(20, Math.max(0, Number(args[0] ?? 0))));
    }
    stop();
  };
  const visit = (node, locals) => {
    tick();
    if (node.type === 'literal') return node.value;
    if (node.type === 'cell') return get(node.id);
    if (node.type === 'identifier') {
      // Lambda scopes form a prototype chain of interpreter-created null-proto
      // objects; no ambient/prototype names can enter it.
      if (node.name in locals) return locals[node.name];
      if (own(bindings, node.name)) return bindings[node.name];
      if (own(GLOBALS, node.name)) return GLOBALS[node.name];
      stop();
    }
    if (node.type === 'array') return bounded(node.values.map((value) => visit(value, locals)));
    if (node.type === 'object') {
      const value = Object.create(null);
      node.entries.forEach(([key, item]) => { value[key] = visit(item, locals); });
      return value;
    }
    if (node.type === 'lambda') {
      const value = {params: node.params, body: node.body, locals};
      lambdas.add(value);
      return value;
    }
    if (node.type === 'member') return member(visit(node.object, locals), visit(node.key, locals));
    if (node.type === 'call') return invoke(node.callee, node.args, locals);
    if (node.type === 'unary') {
      const value = visit(node.value, locals);
      if (node.op === '!') return !value;
      if (node.op === '+') return +value;
      if (node.op === '-') return -value;
      stop();
    }
    if (node.type === 'conditional') return visit(node.test, locals) ? visit(node.yes, locals) : visit(node.no, locals);
    if (node.type === 'binary') {
      const left = visit(node.left, locals);
      if (node.op === '&&') return left && visit(node.right, locals);
      if (node.op === '||') return left || visit(node.right, locals);
      if (node.op === '??') return left ?? visit(node.right, locals);
      const right = visit(node.right, locals);
      if (node.op === '+') return bounded(left + right);
      if (node.op === '-') return left - right;
      if (node.op === '*') return left * right;
      if (node.op === '/') return left / right;
      if (node.op === '%') return left % right;
      if (node.op === '**') return left ** right;
      if (node.op === '<') return left < right;
      if (node.op === '<=') return left <= right;
      if (node.op === '>') return left > right;
      if (node.op === '>=') return left >= right;
      if (node.op === '===') return left === right;
      if (node.op === '!==') return left !== right;
      if (node.op === '==') return left == right;
      if (node.op === '!=') return left != right;
      stop();
    }
    stop();
  };
  const execute = (statements, locals, mutable, pushable) => {
    for (const statement of statements) {
      tick();
      if (statement.type === 'declaration') {
        for (const [name, value] of statement.entries) {
          if (own(locals, name) || own(GLOBALS, name) || name === 'get') stop();
          locals[name] = bounded(visit(value, locals));
          if (statement.kind === 'let') mutable.add(name);
          if (value.type === 'array') pushable.add(name);
        }
        continue;
      }
      if (statement.type === 'assignment') {
        if (!mutable.has(statement.name) || !own(locals, statement.name)) stop();
        locals[statement.name] = bounded(visit(statement.value, locals));
        // A reassignment loses the identity guarantee from the declaration's
        // fresh array literal; never let push mutate a value sourced elsewhere.
        pushable.delete(statement.name);
        continue;
      }
      if (statement.type === 'update') {
        if (!mutable.has(statement.name) || typeof locals[statement.name] !== 'number') stop();
        locals[statement.name] += 1;
        continue;
      }
      if (statement.type === 'return') return {returned: true, value: bounded(visit(statement.value, locals))};
      if (statement.type === 'for') {
        // The narrow loop form is `for (let i = …; condition; i++)`; every
        // iteration spends budget and can only mutate declared locals.
        execute([statement.init], locals, mutable, pushable);
        while (visit(statement.test, locals)) {
          tick();
          const returned = execute(statement.body, locals, mutable, pushable);
          if (returned.returned) return returned;
          execute([statement.next], locals, mutable, pushable);
        }
        continue;
      }
      if (statement.type === 'expressionStatement') {
        const call = statement.value;
        if (call.type !== 'call' || call.callee.type !== 'member') stop();
        if (call.callee.object.type !== 'identifier' || !pushable.has(call.callee.object.name)) stop();
        const array = visit(call.callee.object, locals);
        const name = safeKey(visit(call.callee.key, locals));
        if (!Array.isArray(array) || name !== 'push') stop();
        const values = call.args.map((arg) => bounded(visit(arg, locals)));
        if (array.length + values.length > COLLECTION_LIMIT) stop();
        array.push(...values);
        continue;
      }
      stop();
    }
    return {returned: false, value: undefined};
  };
  if (tree.type === 'program') {
    return execute(tree.statements, Object.create(null), new Set(), new Set()).value;
  }
  return visit(tree, Object.create(null));
}

/** Interpret one expression. Failure is data, never executable fallback code. */
export function readSafeExpression(source, get, bindings = Object.create(null)) {
  try {
    return {ok: true, value: interpret(parse(source), get, bindings)};
  } catch {
    return {ok: false};
  }
}
