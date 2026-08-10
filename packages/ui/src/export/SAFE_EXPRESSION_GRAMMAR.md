# Standalone export expression grammar

Standalone HTML files do not run page-authored JavaScript. Both the legacy
`D.exprs` runtime and the hydrated viewer route reactive sources through
`safeExpressionRuntime.js`.

## Accepted grammar

- JSON-like literals: finite numbers, strings, booleans, `null`, `undefined`,
  `NaN`, `Infinity`, arrays, and plain objects (including identifier shorthand).
- Cell reads: `__C__{cellId}__` and `get("cellId")`. Hydrated block-doc pages
  additionally resolve their already-built input scope by identifier.
- Parentheses; unary `!`, `+`, `-`; arithmetic `+ - * / % **`; comparisons and
  equality; `&&`, `||`, `??`; and `condition ? yes : no`.
- Own-property reads and array/string `.length`. `__proto__`, `prototype`, and
  `constructor` are always rejected.
- Expression-bodied arrow callbacks and these bounded helpers:
  - deterministic `Math` constants and numeric functions (including the real
    export uses `min`, `max`, `round`, and `pow`; `random` is excluded);
  - `Array.isArray`, `Array.of`, `Array.from`;
  - `Object.keys`, `Object.values`, `Object.entries`;
  - non-mutating array operations `slice`, `concat`, `includes`, `indexOf`,
    `lastIndexOf`, `join`, `at`, `reverse`, `map`, `filter`, `some`, `every`,
    `find`, `findIndex`, `flatMap`, `reduce`, and `sort` (sort/reverse clone);
  - bounded string search/case/slice/split helpers and numeric formatting.
- A narrow statement shell used by the bundled Grocery and Savings pages:
  local `const`/`let`, assignment to a declared `let`, a counted
  `for (let i = …; condition; i++)`, `push` to a locally-created array, and
  `return`. Source, token, step, string, and collection limits bound all work.

The exporter emits expressions in document order. Formula, kit-chart,
progress-bar, and status-light sources have named inputs/formulas rewritten to
cell tokens. Database charts are JSON literals. The bundled pages additionally
exercise string concatenation, nested member reads, ternaries, object/array
literals, `Array.from` callbacks, and the bounded statement shell above; all are
covered by tests.

## Intentionally dropped from the old JavaScript evaluator

Arbitrary ambient globals and calls (`window`, `document`, `fetch`,
`globalThis`, Tauri internals), constructors/`new`, user-defined functions and
classes, function-body arrows, `var`, `if`/`switch`/`while`/`try`/`throw`, async
code, imports, generators, assignments to cells/properties, mutating array
methods other than local-array `push`, computed prototype access, regular
expressions, template literals, destructuring/spread, bitwise/comma operators,
and non-allowlisted host APIs are unsupported. These are author-written exotic
live-code constructs; no current bundled page needs them.

An unsupported or over-budget source returns no result. Recompute keeps that
cell's export-time value; if no value was exported, the existing inert `—`/empty
state remains. There is no executable fallback.
