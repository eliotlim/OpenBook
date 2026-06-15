/**
 * Render a {@link DocModel} to Markdown. Pure and unit-tested. Reactive blocks
 * collapse to their current value (`**name** = value`); charts to a caption with
 * series names; `@`-mentions to their label text (there is no portable URL).
 */
import type {DocBlock, DocModel, InlineRun, ListItem} from './documentModel';
import {formatValue} from './format';

function escapeMd(text: string): string {
  return text.replace(/([\\`*_[\]<>])/g, '\\$1');
}

function runToMd(r: InlineRun): string {
  if (r.text === '\n') return '  \n';
  if (r.code) return '`' + r.text + '`';
  if (r.mention) return `[${r.text}]`;
  let t = escapeMd(r.text);
  if (r.bold) t = `**${t}**`;
  if (r.italic) t = `*${t}*`;
  if (r.strike) t = `~~${t}~~`;
  if (r.underline) t = `<u>${t}</u>`;
  if (r.marker) t = `==${t}==`;
  if (r.link) t = `[${t}](${r.link})`;
  return t;
}

const inlineToMd = (runs: InlineRun[]): string => runs.map(runToMd).join('');

const numList = (a: number[]): string => a.map((n) => formatValue(n)).slice(0, 16).join(', ') + (a.length > 16 ? ', …' : '');

/** A textual summary of a chart's data — the Markdown counterpart of the
 *  rendered chart. Handles every value shape the kit accepts. */
function chartRows(value: unknown, labels: string[]): string[] {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    if (Array.isArray(obj.series)) {
      return (obj.series as Array<{name?: unknown; data?: unknown}>)
        .filter((s) => Array.isArray(s?.data))
        .map((s) => `- ${escapeMd(String(s.name ?? 'series'))}: ${numList(s.data as number[])}`);
    }
    // Object of number arrays (multi-series, e.g. {Invested:[…], Projected:[…]}).
    const seriesEntries = Object.entries(obj).filter(([, v]) => Array.isArray(v) && v.length && v.every((n) => typeof n === 'number'));
    if (seriesEntries.length) return seriesEntries.map(([k, v]) => `- ${escapeMd(k)}: ${numList(v as number[])}`);
    // Object of numbers (pie/donut/labelled): key → value.
    return Object.entries(obj)
      .filter(([, v]) => typeof v === 'number')
      .map(([k, v]) => `- ${escapeMd(k)}: ${formatValue(v)}`);
  }
  if (Array.isArray(value)) {
    if (value.length && value.every((p) => p && typeof p === 'object' && 'x' in p && 'y' in p)) {
      return (value as Array<{x: number; y: number}>).slice(0, 16).map((p) => `- (${formatValue(p.x)}, ${formatValue(p.y)})`);
    }
    if (value.every((n) => typeof n === 'number')) {
      // Labelled → one row per label; bare numbers → a single compact row.
      return labels.length
        ? (value as number[]).map((v, i) => `- ${labels[i] ? `${escapeMd(labels[i])}: ` : ''}${formatValue(v)}`)
        : [`- ${numList(value as number[])}`];
    }
    if (value.every((a) => Array.isArray(a))) {
      return (value as number[][]).map((a, i) => `- s${i + 1}: ${numList(a)}`);
    }
  }
  return [];
}

function listToMd(items: ListItem[], ordered: boolean, depth = 0): string {
  const indent = '  '.repeat(depth);
  return items
    .map((item, i) => {
      const marker = ordered ? `${i + 1}.` : '-';
      const line = `${indent}${marker} ${inlineToMd(item.runs)}`;
      const nested = item.items.length ? '\n' + listToMd(item.items, ordered, depth + 1) : '';
      return line + nested;
    })
    .join('\n');
}

function blockToMd(block: DocBlock): string {
  switch (block.type) {
  case 'header':
    return `${'#'.repeat(block.level)} ${inlineToMd(block.runs)}`;
  case 'paragraph':
    return inlineToMd(block.runs);
  case 'list':
    return listToMd(block.items, block.ordered);
  case 'quote': {
    const body = inlineToMd(block.runs)
      .split('\n')
      .map((l) => `> ${l}`)
      .join('\n');
    return block.caption ? `${body}\n>\n> — ${escapeMd(block.caption)}` : body;
  }
  case 'code':
    return '```\n' + block.code + '\n```';
  case 'delimiter':
    return '---';
  case 'table': {
    if (block.rows.length === 0) return '';
    const cell = (runs: InlineRun[]) => inlineToMd(runs).replace(/\|/g, '\\|').replace(/\n/g, ' ') || ' ';
    const [head, ...body] = block.rows;
    const lines = [
      `| ${head.map(cell).join(' | ')} |`,
      `| ${head.map(() => '---').join(' | ')} |`,
      ...body.map((row) => `| ${row.map(cell).join(' | ')} |`),
    ];
    return lines.join('\n');
  }
  case 'callout': {
    const tag = `> [!${block.variant}]`;
    const body = inlineToMd(block.runs)
      .split('\n')
      .map((l) => `> ${l}`)
      .join('\n');
    return body.trim() ? `${tag}\n${body}` : tag;
  }
  case 'accordion':
    return `<details${block.open ? ' open' : ''}>\n<summary>${inlineToMd(block.title)}</summary>\n\n${inlineToMd(block.content)}\n\n</details>`;
  case 'checklist':
    return block.items.map((it) => `- [${it.checked ? 'x' : ' '}] ${inlineToMd(it.runs)}`).join('\n');
  case 'toc': {
    if (block.entries.length === 0) return '';
    const min = Math.min(...block.entries.map((e) => e.level));
    return block.entries.map((e) => `${'  '.repeat(e.level - min)}- ${escapeMd(e.text)}`).join('\n');
  }
  case 'button':
    return block.url ? `[${escapeMd(block.label || block.url)}](${block.url})` : escapeMd(block.label);
  case 'divider':
    return block.style === 'labeled' && block.label ? `**${escapeMd(block.label)}**\n\n---` : '---';
  case 'slider':
  case 'expr':
    return `**${block.name}** = ${formatValue(block.value)}`;
  case 'kvalue':
    return `**${escapeMd(block.label)}:** ${formatValue(block.value)}`;
  case 'light': {
    const icon = {ok: '🟢', warn: '🟡', bad: '🔴', off: '⚪'}[block.status] ?? '⚪';
    return `${icon} **${escapeMd(block.label)}** — ${formatValue(block.value)}`;
  }
  case 'progress':
    return `**${escapeMd(block.label)}:** ${block.readout}`;
  case 'chart': {
    const title = block.title ? `**${escapeMd(block.title)}**` : '**Chart**';
    const rows = chartRows(block.value, block.labels);
    return rows.length ? `${title}\n${rows.join('\n')}` : title;
  }
  case 'unknown':
    return `_(${block.raw} block)_`;
  default:
    return '';
  }
}

export function toMarkdown(model: DocModel): string {
  const parts: string[] = [`# ${model.icon ? `${model.icon} ` : ''}${model.title}`];
  for (const block of model.blocks) {
    const md = blockToMd(block);
    if (md.length > 0) parts.push(md);
  }
  return parts.join('\n\n') + '\n';
}
