/** Shared value formatting for exports (mirrors the editor's result display). */
export function formatValue(v: unknown): string {
  if (v === undefined) return '—';
  if (v === null) return 'null';
  if (Array.isArray(v)) {
    return v.length > 8 ? `[${v.slice(0, 8).map(formatScalar).join(', ')}, … (${v.length})]` : `[${v.map(formatScalar).join(', ')}]`;
  }
  if (typeof v === 'object') {
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  return formatScalar(v);
}

function formatScalar(v: unknown): string {
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Math.round(v * 1000) / 1000);
  return String(v);
}
