import {z} from 'zod';

/** Inline attributes supported by agent/MCP rich-text input. */
export interface RunAttrs extends Record<string, unknown> {
  b?: true;
  i?: true;
  u?: true;
  s?: true;
  c?: true;
  a?: string;
}

/** The editor's JSON-projection run shape. */
export interface Run {
  t: string;
  a?: RunAttrs;
}

export type RichTextInput = string | {runs: Run[]};

export type RichTextInputErrorCode = 'invalid-runs' | 'unsafe-link';

/** A machine-readable rich-text validation failure. */
export class RichTextInputError extends Error {
  constructor(readonly code: RichTextInputErrorCode, message: string) {
    super(message);
    this.name = 'RichTextInputError';
  }
}

const attrsSchema = z.object({
  b: z.literal(true).optional(),
  i: z.literal(true).optional(),
  u: z.literal(true).optional(),
  s: z.literal(true).optional(),
  c: z.literal(true).optional(),
  a: z.string().optional(),
}).strict();

const runSchema = z.object({t: z.string(), a: attrsSchema.optional()}).strict();

const safeLink = (href: string): boolean => {
  try {
    const url = new URL(href);
    return url.protocol === 'https:' || url.protocol === 'http:' || url.protocol === 'mailto:';
  } catch {
    return false;
  }
};

const sameAttrs = (a?: RunAttrs, b?: RunAttrs): boolean =>
  JSON.stringify(a ?? {}) === JSON.stringify(b ?? {});

/** Validate, copy, and coalesce editor-projection runs supplied by a client. */
export function normalizeRuns(input: unknown): Run[] {
  const parsed = z.array(runSchema).safeParse(input);
  if (!parsed.success) {
    throw new RichTextInputError('invalid-runs', `Invalid rich-text runs: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`);
  }
  const out: Run[] = [];
  for (const raw of parsed.data) {
    if (raw.a?.a && !safeLink(raw.a.a)) {
      throw new RichTextInputError('unsafe-link', `Unsafe link scheme in "${raw.a.a}"; use https, http, or mailto.`);
    }
    if (!raw.t) continue;
    const attrs = raw.a && Object.keys(raw.a).length > 0 ? raw.a : undefined;
    const run: Run = attrs ? {t: raw.t, a: attrs} : {t: raw.t};
    const previous = out[out.length - 1];
    if (previous && sameAttrs(previous.a, run.a)) previous.t += run.t;
    else out.push(run);
  }
  return out;
}

const MARKERS: Array<{token: string; attr: keyof RunAttrs}> = [
  {token: '**', attr: 'b'},
  {token: '~~', attr: 's'},
  {token: '`', attr: 'c'},
  {token: '*', attr: 'i'},
  {token: '_', attr: 'i'},
];

const closingAt = (text: string, token: string, from: number): number => {
  for (let i = from; i <= text.length - token.length; i += 1) {
    if (text[i] === '\\') {
      i += 1;
      continue;
    }
    // In `**bold *italic***`, the first star in the closing triple belongs to
    // the inner italic span; the final two close the outer bold span.
    if (token === '**' && text.startsWith('***', i)) return i + 1;
    if (text.startsWith(token, i)) return i;
  }
  return -1;
};

const withAttr = (runs: Run[], attr: keyof RunAttrs, value: true | string): Run[] =>
  runs.map((run) => ({...run, a: {...run.a, [attr]: value}}));

const parseRange = (source: string): Run[] => {
  const runs: Run[] = [];
  let literal = '';
  const flush = (): void => {
    if (literal) runs.push({t: literal});
    literal = '';
  };
  for (let i = 0; i < source.length;) {
    if (source[i] === '\\' && i + 1 < source.length && /[\\*_[\]()`~]/.test(source[i + 1])) {
      literal += source[i + 1];
      i += 2;
      continue;
    }
    if (source[i] === '[') {
      const labelEnd = closingAt(source, ']', i + 1);
      if (labelEnd >= 0 && source[labelEnd + 1] === '(') {
        const urlEnd = closingAt(source, ')', labelEnd + 2);
        if (urlEnd >= 0) {
          const href = source.slice(labelEnd + 2, urlEnd);
          if (!safeLink(href)) throw new RichTextInputError('unsafe-link', `Unsafe link scheme in "${href}"; use https, http, or mailto.`);
          flush();
          runs.push(...withAttr(parseRange(source.slice(i + 1, labelEnd)), 'a', href));
          i = urlEnd + 1;
          continue;
        }
      }
    }
    const marker = MARKERS.find(({token}) => source.startsWith(token, i));
    if (marker) {
      const end = closingAt(source, marker.token, i + marker.token.length);
      if (end >= 0 && end > i + marker.token.length) {
        flush();
        runs.push(...withAttr(parseRange(source.slice(i + marker.token.length, end)), marker.attr, true));
        i = end + marker.token.length;
        continue;
      }
    }
    literal += source[i];
    i += 1;
  }
  flush();
  return normalizeRuns(runs);
};

/** Parse the deliberately small, DOM-free markdown subset accepted by write tools. */
export function parseMiniMarkdown(text: string): Run[] {
  return text ? parseRange(text) : [];
}

/** Resolve either mini-markdown/plain text or an explicit run envelope. */
export function richTextRuns(input: RichTextInput, plain = false): Run[] {
  if (typeof input === 'string') return plain ? (input ? [{t: input}] : []) : parseMiniMarkdown(input);
  return normalizeRuns(input.runs);
}
