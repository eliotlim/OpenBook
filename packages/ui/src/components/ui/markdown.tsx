import {Fragment, type ReactNode} from 'react';
import {cn} from '@/lib/utils';

/**
 * A small, dependency-free Markdown renderer for short assistant replies. It
 * covers the constructs models actually emit in chat — headings, bullet/ordered
 * lists, fenced + inline code, blockquotes, horizontal rules, links, and
 * bold/italic/strikethrough — and renders to React elements (never
 * `dangerouslySetInnerHTML`, so there is no HTML-injection surface). Partial
 * Markdown renders gracefully, so it is safe to feed a streaming, half-written
 * answer and re-render as more arrives.
 *
 * It is intentionally not a complete CommonMark implementation (no nested
 * lists, tables, or reference links); those are rare in chat and not worth the
 * weight. Unmatched syntax falls back to literal text.
 */
export function Markdown({content, className}: {content: string; className?: string}): ReactNode {
  return <div className={cn('flex flex-col gap-2 text-sm leading-relaxed break-words', className)}>{renderBlocks(content)}</div>;
}

/** Heading classes per level (h1…h6). */
const HEADING_CLASS = [
  'text-base font-semibold',
  'text-sm font-semibold',
  'text-sm font-semibold',
  'text-sm font-medium',
  'text-sm font-medium',
  'text-sm font-medium',
];

const FENCE = /^```/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const RULE = /^\s*([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^\s*>\s?/;
const UL_ITEM = /^\s*[-*+]\s+(.*)$/;
const OL_ITEM = /^\s*\d+\.\s+(.*)$/;

/** Does a line begin a block construct (so a paragraph shouldn't absorb it)? */
function isBlockStart(line: string): boolean {
  return FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || UL_ITEM.test(line) || OL_ITEM.test(line);
}

/** Parse block-level Markdown into React nodes. */
function renderBlocks(src: string): ReactNode[] {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const out: ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block ```lang … ```
    if (FENCE.test(line)) {
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !FENCE.test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      i += 1; // consume the closing fence (or run off the end if unterminated)
      out.push(
        <pre
          key={key++}
          className="overflow-x-auto rounded-md border border-border bg-background/60 px-3 py-2 font-mono text-xs leading-relaxed"
        >
          <code>{body.join('\n')}</code>
        </pre>,
      );
      continue;
    }

    // Blank line — paragraph separator.
    if (/^\s*$/.test(line)) {
      i += 1;
      continue;
    }

    // Heading.
    const h = HEADING.exec(line);
    if (h) {
      out.push(
        <p key={key++} className={HEADING_CLASS[h[1].length - 1]}>
          {renderInline(h[2])}
        </p>,
      );
      i += 1;
      continue;
    }

    // Horizontal rule.
    if (RULE.test(line)) {
      out.push(<hr key={key++} className="border-border" />);
      i += 1;
      continue;
    }

    // Blockquote (one or more `>` lines, rendered recursively).
    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i])) {
        body.push(lines[i].replace(QUOTE, ''));
        i += 1;
      }
      out.push(
        <blockquote key={key++} className="flex flex-col gap-2 border-l-2 border-border pl-3 text-muted-foreground">
          {renderBlocks(body.join('\n'))}
        </blockquote>,
      );
      continue;
    }

    // List (consecutive items of one kind).
    const ordered = OL_ITEM.test(line);
    if (ordered || UL_ITEM.test(line)) {
      const re = ordered ? OL_ITEM : UL_ITEM;
      const items: ReactNode[] = [];
      while (i < lines.length && re.test(lines[i])) {
        items.push(<li key={items.length}>{renderInline(re.exec(lines[i])![1])}</li>);
        i += 1;
      }
      out.push(
        ordered ? (
          <ol key={key++} className="flex list-decimal flex-col gap-0.5 pl-5">
            {items}
          </ol>
        ) : (
          <ul key={key++} className="flex list-disc flex-col gap-0.5 pl-5">
            {items}
          </ul>
        ),
      );
      continue;
    }

    // Paragraph — gather until a blank line or the start of another block.
    const para: string[] = [];
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !isBlockStart(lines[i])) {
      para.push(lines[i]);
      i += 1;
    }
    out.push(<p key={key++}>{renderInline(para.join(' '))}</p>);
  }
  return out;
}

// Inline tokens, tried left-to-right at the earliest match: code, **bold**,
// __bold__, *italic*, _italic_, ~~strike~~, [text](url), and bare URLs.
const INLINE =
  /`([^`]+)`|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|\*([\s\S]+?)\*|_([\s\S]+?)_|~~([\s\S]+?)~~|\[([^\]]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s<>)]+)/;

/** Only allow safe link schemes (block `javascript:` etc.). */
function safeHref(url: string): string {
  return /^(https?:|mailto:|\/|#)/i.test(url) ? url : '#';
}

const linkClass = 'text-primary underline underline-offset-2';

/** Parse inline Markdown within a single block of text. */
function renderInline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let rest = text;
  let key = 0;
  while (rest) {
    const m = INLINE.exec(rest);
    if (!m) {
      out.push(<Fragment key={key++}>{rest}</Fragment>);
      break;
    }
    if (m.index > 0) out.push(<Fragment key={key++}>{rest.slice(0, m.index)}</Fragment>);
    if (m[1] !== undefined) {
      out.push(
        <code key={key++} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">
          {m[1]}
        </code>,
      );
    } else if (m[2] !== undefined || m[3] !== undefined) {
      out.push(<strong key={key++}>{renderInline(m[2] ?? m[3])}</strong>);
    } else if (m[4] !== undefined || m[5] !== undefined) {
      out.push(<em key={key++}>{renderInline(m[4] ?? m[5])}</em>);
    } else if (m[6] !== undefined) {
      out.push(<s key={key++}>{renderInline(m[6])}</s>);
    } else if (m[7] !== undefined) {
      out.push(
        <a key={key++} href={safeHref(m[8])} target="_blank" rel="noopener noreferrer" className={linkClass}>
          {renderInline(m[7])}
        </a>,
      );
    } else if (m[9] !== undefined) {
      out.push(
        <a key={key++} href={safeHref(m[9])} target="_blank" rel="noopener noreferrer" className={linkClass}>
          {m[9]}
        </a>,
      );
    }
    rest = rest.slice(m.index + m[0].length);
  }
  return out;
}

export default Markdown;
