export type SafeExpressionResult = {ok: true; value: unknown} | {ok: false};

export function readSafeExpression(
  source: string,
  get: (cellId: string) => unknown,
  bindings?: Readonly<Record<string, unknown>>,
): SafeExpressionResult;
