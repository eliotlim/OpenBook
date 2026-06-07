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
  if (r.marker) t = `==${t}==`;
  if (r.link) t = `[${t}](${r.link})`;
  return t;
}

const inlineToMd = (runs: InlineRun[]): string => runs.map(runToMd).join('');

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
  case 'slider':
  case 'expr':
    return `**${block.name}** = ${formatValue(block.value)}`;
  case 'chart': {
    if (block.series.length === 0) return '_(chart)_';
    const lines = block.series.map((s) => `- ${s.name} (${s.data.length} points)`);
    return `**Chart**\n${lines.join('\n')}`;
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
