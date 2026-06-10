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
  if (a.a) out = `<a href="${escapeHtml(a.a)}">${out}</a>`;
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
