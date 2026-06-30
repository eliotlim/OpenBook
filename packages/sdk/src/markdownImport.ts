/**
 * **Markdown / GFM → blocks importer.** Turns a CommonMark + GFM source string
 * into the format-agnostic {@link ImportedDoc} IR (see `import.ts`), so
 * {@link importDoc} can land it through the existing data paths. A parser's only
 * job is this transform; it never touches the store, the CRDT, or the wire.
 *
 * **Parser choice — `marked`.** It is pure JS with zero runtime dependencies,
 * ships first-class GFM (tables, task lists, strikethrough, autolinks), and —
 * crucially — exposes a structured token AST via {@link lexer} (block tokens
 * carry their inline children in `.tokens`). That lets us map tokens → blocks
 * directly, with NO DOM. The UI's `htmlToRuns`/`htmlToBlocks` are deliberately
 * *not* reused: they are `document`-bound (they return stripped plain text when
 * `document` is undefined) and live in `@book.dev/ui`, which depends on the SDK —
 * importing them here would invert that dependency. We build runs from marked's
 * inline tokens instead.
 *
 * **Block mapping** (shapes cited from `@book.dev/ui`'s `blockeditor/model.ts`):
 *
 *  | Markdown / GFM            | Block (`ImportedBlock`)                         |
 *  | ------------------------- | ----------------------------------------------- |
 *  | `# … ######` heading      | `heading` · `props.level` 1–3 (clamped, as editor)|
 *  | paragraph                 | `paragraph`                                      |
 *  | `-`/`*`/`+` list          | `list` · `props.kind:'bullet'`                   |
 *  | `1.` ordered list         | `list` · `props.kind:'number'`                   |
 *  | nested list item          | flat `list`/`todo` · `props.indent` = depth      |
 *  | `- [ ]` / `- [x]` task     | `todo` · `props.checked`                         |
 *  | `>` blockquote            | `quote` (block children folded to its rich text) |
 *  | ```` ``` ```` fenced code  | `code` · `props.language`                        |
 *  | GFM table                 | `table` → `row` → `cell` children                |
 *  | `---` thematic break      | `divider`                                        |
 *  | `**`/`*`/`~~`/`` ` ``/link | inline `runs` (`{b,i,s,c,a}`)                     |
 *  | `![alt](src)` image       | {@link imagePlaceholderBlock} (block) / linked run (cell)|
 *  | raw HTML / unknown        | degrades to a `paragraph` — never dropped        |
 *
 * **Images.** An image never vanishes: in body content it becomes the import
 * core's {@link imagePlaceholderBlock} (preserving `src` + `alt` + `title`); in
 * a table cell — which can hold only inline text — it becomes a link run to the
 * `src` carrying the `alt`. **Unknown / unsupported constructs** degrade to a
 * paragraph of their text, honoring the converter contract that import content
 * is "never silently dropped" (`model.ts`).
 *
 * **Front-matter.** A leading `---` YAML block is read for `title:` (used as the
 * page title); the remaining lines are passed through verbatim as a `yaml` code
 * block rather than dropped.
 */

import {lexer, type Token, type Tokens} from 'marked';
import {
  imagePlaceholderBlock,
  type ImportedAsset,
  type ImportedBlock,
  type ImportedDoc,
  type ImportInlineAttrs,
  type ImportTextRun,
} from './import';

/** Options for {@link markdownToImportedDoc}. */
export interface MarkdownImportOptions {
  /** Explicit page title — overrides front-matter and any leading heading. */
  title?: string;
  /** Title used when none can be derived. Default `'Imported document'`. */
  defaultTitle?: string;
  /**
   * When no explicit/front-matter title is given, promote a leading heading to
   * the page title (consuming it from the body). Default `true`.
   */
  firstHeadingAsTitle?: boolean;
}

const DEFAULT_TITLE = 'Imported document';

// ── Inline → runs ────────────────────────────────────────────────────────────

/** Mutable state threaded through {@link walkInline}. */
interface InlineCtx {
  /** Images collected for emission as sibling placeholder blocks (body mode). */
  images: ImportedAsset[];
  /**
   * Cell mode: a cell holds only inline text, so an image becomes a link run to
   * its `src` (carrying `alt`) instead of a sibling block.
   */
  inlineImages: boolean;
}

const hasAttrs = (a: ImportInlineAttrs): boolean => Object.keys(a).length > 0;

const sameAttrs = (a: ImportInlineAttrs | undefined, b: ImportInlineAttrs | undefined): boolean =>
  JSON.stringify(a ?? {}) === JSON.stringify(b ?? {});

/** Append text, merging into the previous run when the formatting is identical. */
function pushRun(out: ImportTextRun[], text: string, attrs: ImportInlineAttrs): void {
  if (text === '') return;
  const run: ImportTextRun = hasAttrs(attrs) ? {t: text, a: {...attrs}} : {t: text};
  const prev = out[out.length - 1];
  if (prev && sameAttrs(prev.a, run.a)) prev.t += run.t;
  else out.push(run);
}

const assetOf = (img: Tokens.Image): ImportedAsset => ({
  kind: 'image',
  ref: img.href,
  ...(img.text ? {alt: img.text} : {}),
  ...(img.title ? {title: img.title} : {}),
});

/** Fold a list of marked inline tokens into rich runs under the given attrs. */
function walkInline(tokens: Token[] | undefined, attrs: ImportInlineAttrs, out: ImportTextRun[], ctx: InlineCtx): void {
  if (!tokens) return;
  for (const tok of tokens) {
    switch (tok.type) {
    case 'text':
    case 'escape': {
      const t = tok as Tokens.Text;
      if (t.tokens && t.tokens.length > 0) walkInline(t.tokens, attrs, out, ctx);
      else pushRun(out, t.text ?? t.raw ?? '', attrs);
      break;
    }
    case 'strong':
      walkInline((tok as Tokens.Strong).tokens, {...attrs, b: true}, out, ctx);
      break;
    case 'em':
      walkInline((tok as Tokens.Em).tokens, {...attrs, i: true}, out, ctx);
      break;
    case 'del':
      walkInline((tok as Tokens.Del).tokens, {...attrs, s: true}, out, ctx);
      break;
    case 'codespan':
      pushRun(out, (tok as Tokens.Codespan).text, {...attrs, c: true});
      break;
    case 'br':
      pushRun(out, '\n', {});
      break;
    case 'link': {
      const link = tok as Tokens.Link;
      const linked: ImportInlineAttrs = {...attrs, a: link.href};
      if (link.tokens && link.tokens.length > 0) walkInline(link.tokens, linked, out, ctx);
      else pushRun(out, link.text ?? link.href, linked);
      break;
    }
    case 'image': {
      const img = tok as Tokens.Image;
      if (ctx.inlineImages) pushRun(out, img.text || img.href, {...attrs, a: img.href});
      else ctx.images.push(assetOf(img));
      break;
    }
    case 'checkbox':
      // Task-list marker — handled via the list item's `task`/`checked` fields.
      break;
    case 'html':
      // Inline raw HTML: degrade to its text, never drop.
      pushRun(out, (tok as Tokens.HTML).text ?? (tok as Tokens.HTML).raw ?? '', attrs);
      break;
    default: {
      // Any inline token we don't special-case: keep its text/raw verbatim.
      const g = tok as Tokens.Generic;
      if (g.tokens && g.tokens.length > 0) walkInline(g.tokens, attrs, out, ctx);
      else pushRun(out, (g.text as string) ?? g.raw ?? '', attrs);
    }
    }
  }
}

/** Inline tokens → `{runs, images}`; `inlineImages` linkifies images in place. */
function inlineRuns(tokens: Token[] | undefined, inlineImages = false): {runs: ImportTextRun[]; images: ImportedAsset[]} {
  const ctx: InlineCtx = {images: [], inlineImages};
  const runs: ImportTextRun[] = [];
  walkInline(tokens, {}, runs, ctx);
  return {runs, images: ctx.images};
}

const plainText = (runs: ImportTextRun[]): string => runs.map((r) => r.t).join('');

// ── Block tokens → ImportedBlock[] ───────────────────────────────────────────

/** Text-bearing blocks whose runs fold into a parent quote's rich text. */
const QUOTE_FOLDABLE = new Set(['paragraph', 'heading', 'list', 'todo', 'quote']);

/** Emit list items as flat `list`/`todo` blocks, recursing nested lists by depth. */
function emitList(list: Tokens.List, depth: number, out: ImportedBlock[]): void {
  const kind = list.ordered ? 'number' : 'bullet';
  for (const item of list.items) {
    const runs: ImportTextRun[] = [];
    const images: ImportedAsset[] = [];
    const trailing: ImportedBlock[] = [];
    const nested: Tokens.List[] = [];
    for (const child of item.tokens) {
      if (child.type === 'checkbox') {
        // The task marker — its state is carried by `item.task`/`item.checked`.
        continue;
      } else if (child.type === 'list') {
        nested.push(child as Tokens.List);
      } else if (child.type === 'text' || child.type === 'paragraph') {
        const r = inlineRuns((child as Tokens.Text | Tokens.Paragraph).tokens);
        runs.push(...r.runs);
        images.push(...r.images);
      } else {
        // Block content nested in a list item (code, blockquote, table…): keep
        // it as a following block rather than dropping it.
        tokensToBlocks([child], depth, trailing);
      }
    }
    const isTodo = item.task === true;
    const props: Record<string, unknown> = {};
    if (isTodo) {
      if (item.checked) props.checked = true;
    } else {
      props.kind = kind;
    }
    // Clamp the indent: the editor's CSS only defines `.obe-indent-1..4`, so a
    // deeper nesting would render flat — pin it to the deepest defined level.
    if (depth > 0) props.indent = Math.min(4, depth);
    out.push({type: isTodo ? 'todo' : 'list', text: runs, ...(Object.keys(props).length > 0 ? {props} : {})});
    for (const img of images) out.push(imagePlaceholderBlock(img));
    out.push(...trailing);
    for (const nl of nested) emitList(nl, depth + 1, out);
  }
}

/** Map a GFM table token to a `table` → `row` → `cell` block tree. */
function emitTable(table: Tokens.Table): ImportedBlock {
  const rowOf = (cells: Tokens.TableCell[]): ImportedBlock => ({
    type: 'row',
    children: cells.map((cell) => ({type: 'cell', text: inlineRuns(cell.tokens, true).runs})),
  });
  return {
    type: 'table',
    props: {header: true},
    children: [rowOf(table.header), ...table.rows.map(rowOf)],
  };
}

/** Fold a blockquote's child blocks into a single `quote`, keeping the rest after. */
function emitBlockquote(bq: Tokens.Blockquote, out: ImportedBlock[]): void {
  const inner: ImportedBlock[] = [];
  tokensToBlocks(bq.tokens, 0, inner);
  const quoteRuns: ImportTextRun[] = [];
  const trailing: ImportedBlock[] = [];
  for (const b of inner) {
    if (QUOTE_FOLDABLE.has(b.type) && b.text) {
      if (quoteRuns.length > 0) quoteRuns.push({t: '\n'});
      quoteRuns.push(...b.text);
    } else {
      trailing.push(b);
    }
  }
  out.push({type: 'quote', text: quoteRuns});
  out.push(...trailing);
}

/** Walk top-level (or nested) marked block tokens, appending blocks to `out`. */
function tokensToBlocks(tokens: Token[], depth: number, out: ImportedBlock[]): void {
  for (const tok of tokens) {
    switch (tok.type) {
    case 'space':
    case 'def':
      break;
    case 'heading': {
      const h = tok as Tokens.Heading;
      const {runs, images} = inlineRuns(h.tokens);
      out.push({type: 'heading', text: runs, props: {level: Math.min(3, Math.max(1, h.depth))}});
      for (const img of images) out.push(imagePlaceholderBlock(img));
      break;
    }
    case 'paragraph':
    case 'text': {
      const p = tok as Tokens.Paragraph | Tokens.Text;
      const {runs, images} = inlineRuns(p.tokens ?? undefined);
      const text = plainText(runs);
      if (text.trim() !== '') out.push({type: 'paragraph', text: runs});
      for (const img of images) out.push(imagePlaceholderBlock(img));
      break;
    }
    case 'list':
      emitList(tok as Tokens.List, depth, out);
      break;
    case 'blockquote':
      emitBlockquote(tok as Tokens.Blockquote, out);
      break;
    case 'code': {
      const c = tok as Tokens.Code;
      const language = c.lang?.trim().split(/\s+/)[0];
      out.push({type: 'code', text: [{t: c.text}], ...(language ? {props: {language}} : {})});
      break;
    }
    case 'table':
      out.push(emitTable(tok as Tokens.Table));
      break;
    case 'hr':
      out.push({type: 'divider'});
      break;
    case 'html': {
      // Raw HTML block — degrade to a paragraph carrying the markup verbatim.
      const raw = ((tok as Tokens.HTML).text ?? (tok as Tokens.HTML).raw ?? '').trim();
      if (raw !== '') out.push({type: 'paragraph', text: [{t: raw}]});
      break;
    }
    default: {
      // Unknown / unsupported construct: never drop — degrade to its text.
      const g = tok as Tokens.Generic;
      const raw = ((g.text as string) ?? g.raw ?? '').trim();
      if (raw !== '') out.push({type: 'paragraph', text: [{t: raw}]});
    }
    }
  }
}

// ── Front-matter ─────────────────────────────────────────────────────────────

const FRONT_MATTER_RE = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/** Split a leading `---` YAML block off the source; returns `{title, rest, body}`. */
function splitFrontMatter(markdown: string): {title?: string; rest: string; body: string} {
  const m = FRONT_MATTER_RE.exec(markdown);
  if (!m) return {rest: '', body: markdown.replace(/^\uFEFF/, '')};
  const lines = m[1].split(/\r?\n/);
  let title: string | undefined;
  const rest: string[] = [];
  for (const line of lines) {
    const kv = /^(\w[\w-]*)\s*:\s*(.*)$/.exec(line);
    if (title === undefined && kv && kv[1].toLowerCase() === 'title') {
      title = kv[2].trim().replace(/^["']|["']$/g, '');
    } else {
      rest.push(line);
    }
  }
  return {title, rest: rest.join('\n').trim(), body: markdown.slice(m[0].length)};
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Parse a Markdown/GFM string into {@link ImportedBlock}s. Pure and DOM-free, so
 * it is directly unit-testable and reusable wherever only the block list is
 * wanted (e.g. importing a fragment into an existing page). Honors the
 * "never silently drop content" contract: unknown constructs degrade to text,
 * images become placeholders.
 */
export function markdownToBlocks(markdown: string): ImportedBlock[] {
  const tokens = lexer(markdown ?? '', {gfm: true});
  const blocks: ImportedBlock[] = [];
  tokensToBlocks(tokens, 0, blocks);
  return blocks;
}

/**
 * Parse a full Markdown/GFM document into an {@link ImportedDoc} (a single page)
 * ready for {@link importDoc}. The page title is resolved as:
 *
 *  1. `opts.title` (explicit), else
 *  2. front-matter `title:`, else
 *  3. a leading heading promoted to the title (consumed from the body) when
 *     `opts.firstHeadingAsTitle !== false`, else
 *  4. `opts.defaultTitle` (default `'Imported document'`).
 *
 * Any non-title front-matter is preserved as a leading `yaml` code block.
 */
export function markdownToImportedDoc(markdown: string, opts: MarkdownImportOptions = {}): ImportedDoc {
  const {title: fmTitle, rest, body} = splitFrontMatter(markdown ?? '');
  const blocks = markdownToBlocks(body);

  let title = opts.title ?? fmTitle;
  if (title === undefined && opts.firstHeadingAsTitle !== false && blocks[0]?.type === 'heading') {
    const headingText = plainText(blocks[0].text ?? []).trim();
    if (headingText !== '') {
      title = headingText;
      blocks.shift();
    }
  }
  title = title?.trim() || opts.defaultTitle || DEFAULT_TITLE;

  // Preserve any leftover front-matter rather than dropping it.
  if (rest !== '') blocks.unshift({type: 'code', text: [{t: rest}], props: {language: 'yaml'}});

  return {pages: [{title, blocks}]};
}
