import type {BlockJSON, InlineAttrs, TextRun} from './model';
import {decodeSnapshot} from './model';
import {COLOR_EXPORT_HEX} from './colors';
import {resolveOptionsFromProps, varNameFromLabel} from './kit/options';
import {computeExportCells, type ExportCell} from './kit/scope';

// TextRun is referenced in the kit emit cases below.

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
  if (a.hl) out = `<mark${COLOR_EXPORT_HEX[a.hl] ? ` style="background:${COLOR_EXPORT_HEX[a.hl].hl}"` : ''}>${out}</mark>`;
  if (a.tc && COLOR_EXPORT_HEX[a.tc]) out = `<span style="color:${COLOR_EXPORT_HEX[a.tc].fg}">${out}</span>`;
  if (a.m) out = `<a class="ob-mention" data-page-id="${escapeHtml(a.m)}">${out}</a>`;
  else if (a.a) out = `<a href="${escapeHtml(a.a)}">${out}</a>`;
  return out;
}

const textHtml = (runs: TextRun[] | undefined): string => (runs ?? []).map(runToHtml).join('');

/** The current value of a June-2026 kit input rendered as HTML (selection text
 *  for the choosers, escaped/markup text for long/rich text). */
function kitInputText(b: BlockJSON): string {
  const p = b.props ?? {};
  if (b.type === 'richtext') return Array.isArray(p.runs) ? textHtml(p.runs as TextRun[]) : '';
  if (b.type === 'longtext') return textHtml([{t: String(p.value ?? '')}]);
  // Choosers: map the selected value(s) to their option labels.
  const opts = resolveOptionsFromProps(p);
  const labelFor = (v: string): string => opts.find((o) => o.value === v)?.label ?? v;
  const val = b.type === 'tagfield' || p.multi ? (Array.isArray(p.selected) ? p.selected : []) : (p.value ?? null);
  const shown = Array.isArray(val) ? (val as string[]).map(labelFor).join(', ') : val ? labelFor(String(val)) : '—';
  return textHtml([{t: shown}]);
}

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

/** The current value of a June-2026 kit input rendered as Markdown. */
function kitInputMd(b: BlockJSON): string {
  const p = b.props ?? {};
  if (b.type === 'richtext') return Array.isArray(p.runs) ? textMd(p.runs as TextRun[]) : '';
  if (b.type === 'longtext') return String(p.value ?? '');
  const opts = resolveOptionsFromProps(p);
  const labelFor = (v: string): string => opts.find((o) => o.value === v)?.label ?? v;
  const val = b.type === 'tagfield' || p.multi ? (Array.isArray(p.selected) ? p.selected : []) : (p.value ?? null);
  return Array.isArray(val) ? (val as string[]).map(labelFor).join(', ') : val ? labelFor(String(val)) : '—';
}

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
    case 'notes': // speaker-only — never exported
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
    case 'dbview':
      // No live table in static HTML — export a link to the database page.
      parts.push(
        `<p><a class="ob-mention" data-page-id="${escapeHtml(String(b.props?.pageId ?? ''))}">🗃 ${escapeHtml(String(b.props?.name ?? 'Database'))}</a></p>`,
      );
      i += 1;
      break;
    case 'group': {
      const name = String(b.props?.name ?? '').trim();
      const heading = name ? `<p class="obe-x-group-name"><strong>${escapeHtml(name)}</strong></p>` : '';
      parts.push(`<section class="obe-x-group">${heading}${blocksToHtml(b.children ?? [])}</section>`);
      i += 1;
      break;
    }
    case 'tabs':
    case 'accordion': {
      // Each tab/section becomes a titled block (the static export has no
      // interactive tab/accordion widget).
      const sections = (b.children ?? [])
        .map((s) => {
          const label = String(s.props?.label ?? '').trim();
          const head = label ? `<h3>${escapeHtml(label)}</h3>` : '';
          return `<section class="obe-x-section">${head}${blocksToHtml(s.children ?? [])}</section>`;
        })
        .join('');
      parts.push(`<section class="obe-x-${b.type}">${sections}</section>`);
      i += 1;
      break;
    }
    case 'choicecards':
    case 'searchselect':
    case 'tagfield':
    case 'longtext':
    case 'richtext': {
      const label = String(b.props?.label ?? b.props?.name ?? '').trim();
      const head = label ? `<strong>${escapeHtml(label)}:</strong> ` : '';
      const body = kitInputText(b);
      parts.push(`<p class="obe-x-kitvalue">${head}${body}</p>`);
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
    case 'notes': // speaker-only — never exported
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
    case 'dbview':
      out.push(`**🗃 ${String(b.props?.name ?? 'Database')}**`);
      break;
    case 'group': {
      const name = String(b.props?.name ?? '').trim();
      if (name) out.push(`**${name}**`);
      out.push(blocksToMarkdown(b.children ?? []));
      break;
    }
    case 'tabs':
    case 'accordion':
      for (const section of b.children ?? []) {
        const label = String(section.props?.label ?? '').trim();
        if (label) out.push(`### ${label}`);
        out.push(blocksToMarkdown(section.children ?? []));
      }
      break;
    case 'choicecards':
    case 'searchselect':
    case 'tagfield':
    case 'longtext':
    case 'richtext': {
      const label = String(b.props?.label ?? b.props?.name ?? '').trim();
      const body = kitInputMd(b);
      out.push(label ? `**${label}:** ${body}` : body);
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
/** Kit input types and the value they publish (mirrors kit/scope.ts). */
const KIT_INPUT_VALUE: Record<string, (props: Record<string, unknown>) => unknown> = {
  slider: (p) => Number(p.value ?? 50),
  number: (p) => Number(p.value ?? 0),
  textfield: (p) => String(p.value ?? ''),
  radio: (p) => p.value ?? null,
  dropdown: (p) => p.value ?? null,
  checklist: (p) => (Array.isArray(p.selected) ? p.selected : []),
  toggle: (p) => Boolean(p.value ?? false),
  location: (p) => ({lat: p.lat ?? null, lng: p.lng ?? null, label: p.labeltext ?? ''}),
  // June-2026 inputs. Choice cards / search-select publish a scalar (single) or
  // string[] (multi); the tag field is always string[]; long text a string;
  // rich text its plain-text projection (the markup lives in `runs`).
  choicecards: (p) => (p.multi ? (Array.isArray(p.selected) ? p.selected : []) : (p.value ?? null)),
  searchselect: (p) => (p.multi ? (Array.isArray(p.selected) ? p.selected : []) : (p.value ?? null)),
  tagfield: (p) => (Array.isArray(p.selected) ? p.selected : []),
  longtext: (p) => String(p.value ?? ''),
  richtext: (p) => (Array.isArray(p.runs) ? (p.runs as Array<{t?: string}>).map((r) => r?.t ?? '').join('') : ''),
};

export function blocksToEditorJs(blocks: BlockJSON[], computed?: Map<string, ExportCell>): EditorJsOut {
  const out: EditorJsOut = {blocks: [], values: [], names: []};
  // Seed a reactive cell's CURRENT value (resolved by the editor's evaluator) so
  // static exports show the same numbers/series/states as the live window. Only
  // when a value was actually computed — never a spurious `undefined` entry.
  const pushCell = (id: string): void => {
    if (computed?.has(id)) out.values.push([id, computed.get(id)!.value]);
  };

  // First pass: every named input AND named live-code output → block id (for
  // expression re-tokenizing; the export runtime evaluates exprs in document
  // order, so chained references resolve there exactly as in the editor).
  const inputs: Array<{id: string; name: string}> = [];
  const propsById = new Map<string, Record<string, unknown>>();
  // Mirror the editor's scope exactly (kit/scope.ts): an INPUT inside a named
  // `group` is addressable as `<group>.<field>.value` (inputScope namespaces it);
  // a top-level input as the bare `<field>`. Live code / formulas publish their
  // bare name regardless of nesting (computeScope does NOT namespace them). `group`
  // tracks the nearest enclosing group's key (`varNameFromLabel` of its name).
  const collect = (list: BlockJSON[], group: string): void => {
    for (const b of list) {
      if (KIT_INPUT_VALUE[b.type] && b.props?.name) {
        const field = String(b.props.name);
        inputs.push({id: b.id, name: group ? `${group}.${field}.value` : field});
        propsById.set(b.id, b.props ?? {});
      }
      if (b.type === 'code' && b.props?.live && b.props?.name) inputs.push({id: b.id, name: String(b.props.name)});
      // Formula blocks publish a named value too (computeScope treats them the
      // same as live code) — so a formula referencing another formula/input must
      // be tokenizable, or its dependents resolve to `undefined` in the runtime.
      if (b.type === 'formula' && b.props?.name) inputs.push({id: b.id, name: String(b.props.name)});
      if (b.children) collect(b.children, b.type === 'group' ? varNameFromLabel(String(b.props?.name ?? '')) || group : group);
    }
  };
  collect(blocks, '');
  inputs.sort((a, b) => b.name.length - a.name.length); // longest names first

  const tokenize = (source: string): string => {
    let s = source;
    for (const {id, name} of inputs) {
      s = s.replace(new RegExp(`\\b${escapeRe(name)}\\b`, 'g'), `__C__{${id}}__`);
    }
    return s;
  };

  /** Publish an input's value/name so tokenized expressions read it live. */
  const publish = (b: BlockJSON): void => {
    const read = KIT_INPUT_VALUE[b.type];
    if (!read) return;
    out.values.push([b.id, read(b.props ?? {})]);
    if (b.props?.name) out.names.push([String(b.props.name), b.id]);
  };

  const emit = (list: BlockJSON[], sink: EditorJsOut['blocks'] = out.blocks): void => {
    let i = 0;
    while (i < list.length) {
      const b = list[i];
      switch (b.type) {
      case 'heading':
        sink.push({id: b.id, type: 'header', data: {text: textHtml(b.text), level: Number(b.props?.level ?? 2)}});
        i += 1;
        break;
      case 'list': {
        const kind = (b.props?.kind as string) ?? 'bullet';
        const items: string[] = [];
        while (i < list.length && list[i].type === 'list' && ((list[i].props?.kind as string) ?? 'bullet') === kind) {
          items.push(textHtml(list[i].text));
          i += 1;
        }
        sink.push({type: 'list', data: {style: kind === 'number' ? 'ordered' : 'unordered', items}});
        break;
      }
      case 'todo': {
        const items: Array<{text: string; checked: boolean}> = [];
        while (i < list.length && list[i].type === 'todo') {
          items.push({text: textHtml(list[i].text), checked: Boolean(list[i].props?.checked)});
          i += 1;
        }
        sink.push({type: 'checklist', data: {items}});
        break;
      }
      case 'quote':
        sink.push({id: b.id, type: 'quote', data: {text: textHtml(b.text)}});
        i += 1;
        break;
      case 'callout':
        sink.push({id: b.id, type: 'callout', data: {variant: (b.props?.variant as string) ?? 'info', text: textHtml(b.text)}});
        i += 1;
        break;
      case 'code': {
        const codeText = (b.text ?? []).map((r) => r.t).join('');
        if (b.props?.live) {
          // Live code exports as a computed cell — named, so later expressions
          // (and charts) keep referencing it in the standalone HTML. Seed its
          // resolved value so the static export (and pre-hydration HTML) reads
          // the same result the editor shows.
          sink.push({id: b.id, type: 'expr', data: {name: String(b.props?.name ?? ''), source: tokenize(codeText)}});
          pushCell(b.id);
          if (b.props?.name) out.names.push([String(b.props.name), b.id]);
        } else {
          sink.push({id: b.id, type: 'code', data: {code: codeText, language: b.props?.language}});
        }
        i += 1;
        break;
      }
      case 'notes': // speaker-only — never exported
        i += 1;
        break;
      case 'divider':
        sink.push({id: b.id, type: 'divider', data: {style: 'line'}});
        i += 1;
        break;
      case 'table': {
        const content = (b.children ?? []).map((row) => (row.children ?? []).map((cell) => textHtml(cell.text)));
        sink.push({id: b.id, type: 'table', data: {withHeadings: Boolean(b.props?.header), content}});
        i += 1;
        break;
      }
      case 'columns': {
        // Keep columns as a nested block so the HTML export lays them
        // side-by-side (PDF/Markdown flatten them later). Inner reactive blocks
        // still publish via emit, so charts/formulas stay live wherever they sit.
        const columns = (b.children ?? []).map((col) => {
          const sub: EditorJsOut['blocks'] = [];
          emit(col.children ?? [], sub);
          return sub;
        });
        sink.push({id: b.id, type: 'columns', data: {columns}});
        i += 1;
        break;
      }
      case 'tabs':
      case 'accordion':
        // No tab/accordion widget in the standalone runtime — flatten each
        // tab/section's blocks in reading order (a labelled heading per
        // section keeps them legible). Inputs inside still publish/stay live.
        for (const section of b.children ?? []) {
          const heading = String(section.props?.label ?? '').trim();
          if (heading) sink.push({type: 'header', data: {text: textHtml([{t: heading}]), level: 3}});
          emit(section.children ?? [], sink);
        }
        i += 1;
        break;
      case 'group':
        // A group is a container (lock / cross-page sync in the editor); the
        // standalone runtime has no frame widget, so flatten its children inline.
        // Without this the group fell through to `default` and ALL its reactive
        // content (inputs, code, charts) was silently dropped from the export.
        emit(b.children ?? [], sink);
        i += 1;
        break;
      case 'slider': {
        const name = String(b.props?.name ?? 'x');
        const value = Number(b.props?.value ?? 50);
        sink.push({
          id: b.id,
          type: 'slider',
          data: {name, min: Number(b.props?.min ?? 0), max: Number(b.props?.max ?? 100), step: 1, initial: value},
        });
        publish(b);
        i += 1;
        break;
      }
      case 'number': {
        // Steppers stay interactive in the export as range inputs.
        const name = String(b.props?.name ?? 'n');
        const value = Number(b.props?.value ?? 0);
        const min = Number(b.props?.min ?? Math.min(0, value));
        const max = Number(b.props?.max ?? Math.max(100, value * 2 || 10));
        sink.push({id: b.id, type: 'slider', data: {name, min, max, step: Number(b.props?.step ?? 1), initial: value}});
        publish(b);
        i += 1;
        break;
      }
      case 'formula': {
        const name = String(b.props?.name ?? '');
        sink.push({id: b.id, type: 'expr', data: {name, source: tokenize(String(b.props?.source ?? ''))}});
        pushCell(b.id);
        // Publish the name so the runtime maps cell→name (and downstream
        // tokenized refs to this formula resolve live), matching computeScope.
        if (name) out.names.push([name, b.id]);
        i += 1;
        break;
      }
      case 'statuslight': {
        // A computed cell drives a real light (dot + label) in the export. The
        // expr is hidden (the light IS the readout); the light carries the
        // thresholds so the runtime recomputes its 3-state colour live, plus the
        // resolved status for the static (PDF/Markdown) render.
        sink.push({id: b.id, type: 'expr', data: {name: String(b.props?.label ?? 'Status'), source: tokenize(String(b.props?.source ?? '')), hidden: true}});
        pushCell(b.id);
        sink.push({
          id: `${b.id}-light`,
          type: 'kitlight',
          data: {
            refCellId: b.id,
            label: String(b.props?.label ?? 'Status'),
            okAt: Number(b.props?.okAt ?? 1),
            warnAt: Number(b.props?.warnAt ?? 0),
            status: computed?.get(b.id)?.status ?? 'off',
          },
        });
        i += 1;
        break;
      }
      case 'kitchart': {
        // The chart's data expression becomes a HIDDEN computed cell (the chart
        // is the readout — no `title = value` line), and a chart block draws it.
        // Exported charts stay LIVE: moving a slider recomputes the cell and the
        // plot redraws; the seeded value renders the static export + first paint.
        sink.push({id: b.id, type: 'expr', data: {name: String(b.props?.title ?? 'chart'), source: tokenize(String(b.props?.source ?? '')), hidden: true}});
        pushCell(b.id);
        sink.push({
          id: `${b.id}-plot`,
          type: 'chart',
          data: {refCellIds: [b.id], kind: String(b.props?.kind ?? 'line'), title: String(b.props?.title ?? ''), labels: String(b.props?.labels ?? '')},
        });
        i += 1;
        break;
      }
      case 'textfield':
      case 'radio':
      case 'checklist':
      case 'dropdown':
      case 'toggle': {
        // These stay INTERACTIVE in the export — flipping a choice offline
        // recomputes everything downstream, exactly like the editor.
        const read = KIT_INPUT_VALUE[b.type];
        sink.push({
          id: b.id,
          type: 'kitinput',
          data: {
            kind: b.type,
            name: String(b.props?.name ?? b.type),
            label: String(b.props?.label ?? b.props?.name ?? b.type),
            // Resolved {label,value} pairs so the export shows labels but
            // serialises values; full-width unless the block opted into compact.
            opts: resolveOptionsFromProps(b.props ?? {}),
            placeholder: String(b.props?.placeholder ?? ''),
            wide: !b.props?.compact,
            value: read(b.props ?? {}),
          },
        });
        publish(b);
        i += 1;
        break;
      }
      case 'location': {
        const lat = b.props?.lat;
        const lng = b.props?.lng;
        const place = String(b.props?.labeltext ?? '');
        const coords = typeof lat === 'number' && typeof lng === 'number' ? `<a href="https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}">${lat}, ${lng}</a>` : '';
        sink.push({id: b.id, type: 'paragraph', data: {text: [`<b>${String(b.props?.name ?? 'place')}</b>:`, place, coords].filter(Boolean).join(' ')}});
        publish(b);
        i += 1;
        break;
      }
      case 'tooltipcard':
        sink.push({id: b.id, type: 'paragraph', data: {text: `<b>${String(b.props?.term ?? '')}</b> — ${String(b.props?.tip ?? '')}`}});
        i += 1;
        break;
      case 'linkcard': {
        const url = String(b.props?.url ?? '');
        const href = url && (/^https?:\/\//.test(url) ? url : `https://${url}`);
        const title = String(b.props?.title ?? 'Untitled');
        const desc = String(b.props?.description ?? '');
        sink.push({id: b.id, type: 'paragraph', data: {text: [href ? `<a href="${href}">${title}</a>` : `<b>${title}</b>`, desc].filter(Boolean).join(' — ')}});
        i += 1;
        break;
      }
      case 'actionbutton': {
        const action = String(b.props?.action ?? 'increment');
        const label = String(b.props?.btnlabel ?? 'Button');
        if (action === 'link') {
          const url = String(b.props?.url ?? '');
          if (url) sink.push({id: b.id, type: 'kitbutton', data: {label, action, url: /^https?:\/\//.test(url) ? url : `https://${url}`}});
          i += 1;
          break;
        }
        const target = inputs.find((x) => x.name === String(b.props?.target ?? ''));
        if (target) {
          const tprops = propsById.get(target.id) ?? {};
          sink.push({
            id: b.id,
            type: 'kitbutton',
            data: {label, action, target: target.id, amount: Number(b.props?.amount ?? 1), min: tprops.min, max: tprops.max},
          });
        }
        i += 1;
        break;
      }
      case 'choicecards':
      case 'searchselect':
      case 'tagfield': {
        // The standalone runtime has no searchable/card widgets — export the
        // current selection as readable text, but still PUBLISH the value so
        // downstream charts/formulas read it live (longest-names-first
        // tokenizing means an expr over this input resolves in the export).
        const read = KIT_INPUT_VALUE[b.type];
        const val = read(b.props ?? {});
        const opts = resolveOptionsFromProps(b.props ?? {});
        const labelFor = (v: string): string => opts.find((o) => o.value === v)?.label ?? v;
        const shown = Array.isArray(val) ? val.map(labelFor).join(', ') : val ? labelFor(String(val)) : '—';
        const label = String(b.props?.label ?? b.props?.name ?? b.type);
        sink.push({id: b.id, type: 'paragraph', data: {text: `<b>${label}:</b> ${textHtml([{t: shown}])}`}});
        publish(b);
        i += 1;
        break;
      }
      case 'longtext':
      case 'richtext': {
        // Long/rich text export as paragraphs; rich text keeps its inline
        // markup (the runs already carry b/i/u/links), plain long text is
        // escaped. Both publish their value (plain string) for expressions.
        const runs = b.type === 'richtext' && Array.isArray(b.props?.runs) ? (b.props!.runs as TextRun[]) : [{t: String(b.props?.value ?? '')}];
        sink.push({id: b.id, type: 'paragraph', data: {text: textHtml(runs)}});
        publish(b);
        i += 1;
        break;
      }
      case 'progressbar': {
        // A hidden computed cell drives a real progress bar (label + track +
        // readout) that recomputes live; the seeded value renders the static
        // export and first paint.
        sink.push({id: b.id, type: 'expr', data: {name: String(b.props?.label ?? 'Progress'), source: tokenize(String(b.props?.source ?? '')), hidden: true}});
        pushCell(b.id);
        sink.push({
          id: `${b.id}-bar`,
          type: 'kitprogress',
          data: {refCellId: b.id, label: String(b.props?.label ?? 'Progress'), max: Number(b.props?.max ?? 100), format: String(b.props?.format ?? 'percent')},
        });
        i += 1;
        break;
      }
      case 'dbview':
        // Embedded databases export as a link to their page (the standalone
        // runtime has no database engine).
        sink.push({
          id: b.id,
          type: 'paragraph',
          data: {text: textHtml([{t: `🗃 ${String(b.props?.name ?? 'Database')}`, a: {m: String(b.props?.pageId ?? '')}}])},
        });
        i += 1;
        break;
      default:
        sink.push({id: b.id, type: 'paragraph', data: {text: textHtml(b.text)}});
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
  const blockdoc = snapshot.blockdoc as {blocks?: BlockJSON[]; update?: string};
  const blocks = (blockdoc.blocks ?? []) as BlockJSON[];
  // Resolve the reactive graph the way the editor does, so the export carries the
  // same computed values (numbers, chart series, light/progress states) the
  // window shows — not empty cells. Falls back to an empty map if the CRDT update
  // can't be decoded (the projection still works, just without precomputed
  // values; the interactive HTML recomputes them anyway).
  let computed: Map<string, ExportCell> | undefined;
  try {
    computed = computeExportCells(decodeSnapshot(blockdoc as never));
  } catch {
    computed = undefined;
  }
  const projected = blocksToEditorJs(blocks, computed);
  return {...snapshot, editorjs: {blocks: projected.blocks}, values: projected.values, names: projected.names};
}
