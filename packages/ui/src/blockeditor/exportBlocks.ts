import type {BlockJSON, InlineAttrs, TextRun} from './model';

/**
 * Exporters over the JSON projection of a block document. Markdown for
 * portability; HTML for the standalone/interactive export (the obe-* class
 * names match the editor stylesheet, so exported pages can ship the same
 * minimalist look by inlining that CSS).
 */

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function runToHtml(run: TextRun): string {
  let out = escapeHtml(run.t).replace(/\n/g, '<br>');
  const a: InlineAttrs = run.a ?? {};
  if (a.c) out = `<code>${out}</code>`;
  if (a.b) out = `<strong>${out}</strong>`;
  if (a.i) out = `<em>${out}</em>`;
  if (a.u) out = `<u>${out}</u>`;
  if (a.s) out = `<s>${out}</s>`;
  if (a.m) out = `<a class="ob-mention" data-page-id="${escapeHtml(a.m)}">${out}</a>`;
  else if (a.a) out = `<a href="${escapeHtml(a.a)}">${out}</a>`;
  return out;
}

const textHtml = (runs: TextRun[] | undefined): string => (runs ?? []).map(runToHtml).join('');

function runToMd(run: TextRun): string {
  let out = run.t;
  const a: InlineAttrs = run.a ?? {};
  if (a.c) out = `\`${out}\``;
  if (a.b) out = `**${out}**`;
  if (a.i) out = `*${out}*`;
  if (a.s) out = `~~${out}~~`;
  if (a.a) out = `[${out}](${a.a})`;
  return out;
}

const textMd = (runs: TextRun[] | undefined): string => (runs ?? []).map(runToMd).join('');

/** Render block JSON to clean semantic HTML (one string, no wrapper). */
export function blocksToHtml(blocks: BlockJSON[]): string {
  const parts: string[] = [];
  let i = 0;
  while (i < blocks.length) {
    const b = blocks[i];
    switch (b.type) {
    case 'heading': {
      const level = Math.min(6, Math.max(1, Number(b.props?.level ?? 2)));
      parts.push(`<h${level}>${textHtml(b.text)}</h${level}>`);
      i += 1;
      break;
    }
    case 'list': {
      // Consecutive list items of the same kind join into one list element.
      const kind = (b.props?.kind as string) ?? 'bullet';
      const tag = kind === 'number' ? 'ol' : 'ul';
      const items: string[] = [];
      while (i < blocks.length && blocks[i].type === 'list' && ((blocks[i].props?.kind as string) ?? 'bullet') === kind) {
        items.push(`<li>${textHtml(blocks[i].text)}</li>`);
        i += 1;
      }
      parts.push(`<${tag}>${items.join('')}</${tag}>`);
      break;
    }
    case 'todo': {
      const checked = Boolean(b.props?.checked);
      parts.push(
        `<div class="obe-x-todo"><input type="checkbox" disabled${checked ? ' checked' : ''}> ${textHtml(b.text)}</div>`,
      );
      i += 1;
      break;
    }
    case 'quote':
      parts.push(`<blockquote>${textHtml(b.text)}</blockquote>`);
      i += 1;
      break;
    case 'callout':
      parts.push(`<aside class="obe-x-callout obe-x-${(b.props?.variant as string) ?? 'info'}">${textHtml(b.text)}</aside>`);
      i += 1;
      break;
    case 'code':
      parts.push(`<pre><code>${escapeHtml((b.text ?? []).map((r) => r.t).join(''))}</code></pre>`);
      i += 1;
      break;
    case 'divider':
      parts.push('<hr>');
      i += 1;
      break;
    case 'columns': {
      const cols = b.children ?? [];
      const colHtml = cols
        .map((col) => `<div style="flex:1;min-width:0">${blocksToHtml(col.children ?? [])}</div>`)
        .join('');
      parts.push(`<div style="display:flex;gap:1.25rem" class="obe-x-columns">${colHtml}</div>`);
      i += 1;
      break;
    }
    case 'table': {
      const rows = b.children ?? [];
      const header = Boolean(b.props?.header);
      const body = rows
        .map((row, r) => {
          const tag = header && r === 0 ? 'th' : 'td';
          const cells = (row.children ?? []).map((cell) => `<${tag}>${textHtml(cell.text)}</${tag}>`).join('');
          return `<tr>${cells}</tr>`;
        })
        .join('');
      parts.push(`<table class="obe-x-table"><tbody>${body}</tbody></table>`);
      i += 1;
      break;
    }
    default:
      parts.push(`<p>${textHtml(b.text) || '&nbsp;'}</p>`);
      i += 1;
    }
  }
  return parts.join('\n');
}

/** Render block JSON to GitHub-flavoured Markdown. */
export function blocksToMarkdown(blocks: BlockJSON[]): string {
  const out: string[] = [];
  let n = 0; // numbered-list counter (resets when the run breaks)
  for (const b of blocks) {
    if (b.type !== 'list' || (b.props?.kind as string) !== 'number') n = 0;
    switch (b.type) {
    case 'heading':
      out.push(`${'#'.repeat(Math.min(6, Math.max(1, Number(b.props?.level ?? 2))))} ${textMd(b.text)}`);
      break;
    case 'list':
      if ((b.props?.kind as string) === 'number') {
        n += 1;
        out.push(`${n}. ${textMd(b.text)}`);
      } else {
        out.push(`- ${textMd(b.text)}`);
      }
      break;
    case 'todo':
      out.push(`- [${b.props?.checked ? 'x' : ' '}] ${textMd(b.text)}`);
      break;
    case 'quote':
      out.push(`> ${textMd(b.text)}`);
      break;
    case 'callout':
      out.push(`> **${((b.props?.variant as string) ?? 'note').toUpperCase()}:** ${textMd(b.text)}`);
      break;
    case 'code':
      out.push(`\`\`\`${(b.props?.language as string) ?? ''}\n${(b.text ?? []).map((r) => r.t).join('')}\n\`\`\``);
      break;
    case 'divider':
      out.push('---');
      break;
    case 'columns':
      for (const col of b.children ?? []) out.push(blocksToMarkdown(col.children ?? []));
      break;
    case 'table': {
      const rows = (b.children ?? []).map((row) => (row.children ?? []).map((cell) => textMd(cell.text).replace(/\|/g, '\\|')));
      if (rows.length > 0) {
        const width = Math.max(...rows.map((r) => r.length));
        const pad = (r: string[]): string[] => [...r, ...Array.from({length: width - r.length}, () => '')];
        const lines = [
          `| ${pad(rows[0]).join(' | ')} |`,
          `| ${Array.from({length: width}, () => '---').join(' | ')} |`,
          ...rows.slice(1).map((r) => `| ${pad(r).join(' | ')} |`),
        ];
        out.push(lines.join('\n'));
      }
      break;
    }
    default:
      out.push(textMd(b.text));
    }
  }
  return out.join('\n\n');
}

// ── EditorJS adapter (the bridge into the app's export pipeline) ─────────────

interface EditorJsOut {
  blocks: Array<{id?: string; type: string; data: Record<string, unknown>}>;
  values: Array<[string, unknown]>;
  names: Array<[string, string]>;
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Project a block document into the EditorJS shape the export pipeline
 * (markdown / PDF / the interactive HTML site) consumes — so block pages get
 * every exporter, including the live reactive runtime, without a second
 * pipeline. Sliders/formulas become reactive blocks keyed by their block id
 * (formula sources have slider names re-tokenized to `__C__{id}__`, the
 * format the export runtime evaluates); columns flatten in reading order.
 */
export function blocksToEditorJs(blocks: BlockJSON[]): EditorJsOut {
  const out: EditorJsOut = {blocks: [], values: [], names: []};

  // First pass: slider names → block ids (for formula re-tokenizing).
  const sliders: Array<{id: string; name: string}> = [];
  const collect = (list: BlockJSON[]): void => {
    for (const b of list) {
      if (b.type === 'slider') sliders.push({id: b.id, name: String(b.props?.name ?? 'x')});
      if (b.children) for (const child of b.children) collect([child, ...(child.children ?? [])]);
    }
  };
  collect(blocks);
  sliders.sort((a, b) => b.name.length - a.name.length); // longest names first

  const tokenize = (source: string): string => {
    let s = source;
    for (const {id, name} of sliders) {
      s = s.replace(new RegExp(`\\b${escapeRe(name)}\\b`, 'g'), `__C__{${id}}__`);
    }
    return s;
  };

  const emit = (list: BlockJSON[]): void => {
    let i = 0;
    while (i < list.length) {
      const b = list[i];
      switch (b.type) {
      case 'heading':
        out.blocks.push({id: b.id, type: 'header', data: {text: textHtml(b.text), level: Number(b.props?.level ?? 2)}});
        i += 1;
        break;
      case 'list': {
        const kind = (b.props?.kind as string) ?? 'bullet';
        const items: string[] = [];
        while (i < list.length && list[i].type === 'list' && ((list[i].props?.kind as string) ?? 'bullet') === kind) {
          items.push(textHtml(list[i].text));
          i += 1;
        }
        out.blocks.push({type: 'list', data: {style: kind === 'number' ? 'ordered' : 'unordered', items}});
        break;
      }
      case 'todo': {
        const items: Array<{text: string; checked: boolean}> = [];
        while (i < list.length && list[i].type === 'todo') {
          items.push({text: textHtml(list[i].text), checked: Boolean(list[i].props?.checked)});
          i += 1;
        }
        out.blocks.push({type: 'checklist', data: {items}});
        break;
      }
      case 'quote':
        out.blocks.push({id: b.id, type: 'quote', data: {text: textHtml(b.text)}});
        i += 1;
        break;
      case 'callout':
        out.blocks.push({id: b.id, type: 'callout', data: {variant: (b.props?.variant as string) ?? 'info', text: textHtml(b.text)}});
        i += 1;
        break;
      case 'code':
        out.blocks.push({id: b.id, type: 'code', data: {code: (b.text ?? []).map((r) => r.t).join(''), language: b.props?.language}});
        i += 1;
        break;
      case 'divider':
        out.blocks.push({id: b.id, type: 'divider', data: {style: 'line'}});
        i += 1;
        break;
      case 'table': {
        const content = (b.children ?? []).map((row) => (row.children ?? []).map((cell) => textHtml(cell.text)));
        out.blocks.push({id: b.id, type: 'table', data: {withHeadings: Boolean(b.props?.header), content}});
        i += 1;
        break;
      }
      case 'columns':
        // The export model is single-column: flatten in reading order.
        for (const col of b.children ?? []) emit(col.children ?? []);
        i += 1;
        break;
      case 'slider': {
        const name = String(b.props?.name ?? 'x');
        const value = Number(b.props?.value ?? 50);
        out.blocks.push({
          id: b.id,
          type: 'slider',
          data: {name, min: Number(b.props?.min ?? 0), max: Number(b.props?.max ?? 100), step: 1, initial: value},
        });
        out.values.push([b.id, value]);
        out.names.push([name, b.id]);
        i += 1;
        break;
      }
      case 'formula': {
        out.blocks.push({id: b.id, type: 'expr', data: {name: '', source: tokenize(String(b.props?.source ?? ''))}});
        i += 1;
        break;
      }
      default:
        out.blocks.push({id: b.id, type: 'paragraph', data: {text: textHtml(b.text)}});
        i += 1;
      }
    }
  };
  emit(blocks);
  return out;
}

/** Snapshot-level normalization: pages written by the block editor project
 *  into the EditorJS shape; everything else passes through untouched. Export
 *  entry points call this so mixed trees (an EditorJS parent linking block
 *  subpages, or vice versa) export every page faithfully. */
export function blockSnapshotToEditorJs<T extends {editor?: string; blockdoc?: unknown}>(snapshot: T): T {
  if (!snapshot || snapshot.editor !== 'blocks' || !snapshot.blockdoc) return snapshot;
  const blocks = ((snapshot.blockdoc as {blocks?: BlockJSON[]}).blocks ?? []) as BlockJSON[];
  const projected = blocksToEditorJs(blocks);
  return {...snapshot, editorjs: {blocks: projected.blocks}, values: projected.values, names: projected.names};
}
