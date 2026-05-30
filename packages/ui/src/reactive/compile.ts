import type {ReactiveStore} from './ReactiveStore';

export type CompiledExpr = (store: ReactiveStore) => Promise<unknown> | unknown;

/**
 * Token format used in persisted ExprBlock source: `__C__{<cellId>}__`.
 *
 * Braces serve as unambiguous delimiters so cellIds containing characters
 * that aren't valid JS identifier chars (hyphens, in particular — EditorJS
 * 2.x generates ids like `mKTU-N2aPX`) survive both extraction and the
 * source rendering pipeline.
 *
 * compile() never injects the raw cellId into the generated JS — it rewrites
 * each token to a safe sequential alias (`__cell_0`, `__cell_1`, ...) and
 * binds those aliases to store reads. That way the JS function body is
 * always parseable regardless of cellId contents.
 */
const TOKEN_RE = /__C__\{([^}]+)\}__/g;

/** Extracts unique cellIds from an ExprBlock source string. Order preserved. */
export function extractCellIds(source: string): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  let match: RegExpExecArray | null;
  TOKEN_RE.lastIndex = 0;
  while ((match = TOKEN_RE.exec(source)) !== null) {
    const id = match[1];
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

/**
 * Compiles an ExprBlock source string into a runnable function.
 *
 * Steps:
 *   1. Extract referenced cellIds in source order.
 *   2. Assign each a safe alias: cellIds[i] → `__cell_<i>`.
 *   3. Rewrite source: every `__C__{cellId}__` token becomes the alias.
 *   4. Inject `const __cell_i = store.getByCellId('cellId')` for each cell.
 *   5. Wrap in `return (<rewritten>);` and `new Function('store', ...)`.
 *
 * The compiled function reads cells via store.getByCellId, which auto-
 * subscribes the calling reactive scope through Signals' tracking.
 *
 * Signature is union-typed `Promise<unknown> | unknown` so callers always
 * await the result; v1 can swap to a sandboxed evaluator that returns
 * Promise<unknown> without changing call sites.
 */
export function compile(source: string): CompiledExpr {
  if (source.trim() === '') {
    return () => undefined;
  }
  const cellIds = extractCellIds(source);
  const aliasOf = new Map<string, string>();
  cellIds.forEach((id, i) => aliasOf.set(id, `__cell_${i}`));

  // Rewrite the source: replace each token with its alias.
  TOKEN_RE.lastIndex = 0;
  const rewritten = source.replace(TOKEN_RE, (_match, cellId: string) => {
    return aliasOf.get(cellId) ?? '(undefined)';
  });

  const aliasLines = cellIds
    .map((id) => `const ${aliasOf.get(id)!} = store.getByCellId(${JSON.stringify(id)});`)
    .join('\n');
  const body = `${aliasLines}\nreturn (${rewritten});`;
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
  const fn = new Function('store', body) as (s: ReactiveStore) => unknown;
  return (s) => fn(s);
}
