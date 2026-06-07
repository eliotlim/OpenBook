import React, {useEffect, useRef, useState} from 'react';
import type {ReactElement} from 'react';
import type {ToolboxConfig} from '@editorjs/editorjs';
import {ReactBlockTool} from '@/reactive/editorJsReactAdapter';
import {t} from '@/i18n';
import {icon} from './shared';

interface Heading {
  id: string;
  level: number;
  text: string;
}

/** Read the heading blocks of the editor this ToC lives in, in document order. */
function readHeadings(root: HTMLElement): Heading[] {
  const out: Heading[] = [];
  root.querySelectorAll<HTMLElement>('.ce-block').forEach((blockEl) => {
    const header = blockEl.querySelector<HTMLElement>('h1, h2, h3, h4, h5, h6');
    if (!header) return;
    const text = header.textContent?.trim() ?? '';
    if (!text) return;
    out.push({
      id: blockEl.dataset.id ?? '',
      level: Number(header.tagName.slice(1)) || 2,
      text,
    });
  });
  return out;
}

const TocView: React.FC = () => {
  const ref = useRef<HTMLDivElement | null>(null);
  const [headings, setHeadings] = useState<Heading[]>([]);

  useEffect(() => {
    const redactor = ref.current?.closest('.codex-editor')?.querySelector<HTMLElement>('.codex-editor__redactor');
    if (!redactor) return;

    let timer: ReturnType<typeof setTimeout> | null = null;
    const rescan = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setHeadings(readHeadings(redactor)), 150);
    };
    rescan();
    const observer = new MutationObserver(rescan);
    observer.observe(redactor, {subtree: true, childList: true, characterData: true});
    return () => {
      if (timer) clearTimeout(timer);
      observer.disconnect();
    };
  }, []);

  const jumpTo = (id: string) => {
    const target = ref.current
      ?.closest('.codex-editor')
      ?.querySelector<HTMLElement>(`.ce-block[data-id="${id}"]`);
    if (!target) return;
    target.scrollIntoView({behavior: 'smooth', block: 'start'});
    target.classList.add('ce-block--toc-flash');
    setTimeout(() => target.classList.remove('ce-block--toc-flash'), 900);
  };

  const minLevel = headings.length ? Math.min(...headings.map((h) => h.level)) : 1;

  return (
    <div className="block-toc" ref={ref}>
      <div className="block-toc__label">{t('blocks.tocTitle')}</div>
      {headings.length === 0 ? (
        <div className="block-toc__empty">{t('blocks.tocEmpty')}</div>
      ) : (
        <ul className="block-toc__list">
          {headings.map((h, i) => (
            <li
              key={`${h.id}-${i}`}
              className="block-toc__item"
              style={{paddingInlineStart: `${(h.level - minLevel) * 14}px`}}
            >
              <button type="button" className="block-toc__link" onMouseDown={(e) => e.preventDefault()} onClick={() => jumpTo(h.id)}>
                {h.text}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

/**
 * An auto-generated outline of the page's headings. It scans its own editor's
 * heading blocks and rebuilds (debounced) whenever the document changes via a
 * MutationObserver — clicking an entry scrolls to that heading. The content is
 * derived, never stored: `save()` returns an empty object so the block never
 * produces a spurious diff in real-time sync.
 */
export class TableOfContentsBlock extends ReactBlockTool {
  static get toolbox(): ToolboxConfig {
    return {
      title: t('blocks.toc'),
      icon: icon('<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>'),
    };
  }

  static get pasteConfig(): false {
    return false;
  }

  protected toolName(): string {
    return 'toc';
  }

  protected renderComponent(): ReactElement {
    return <TocView />;
  }

  save(): Record<string, never> {
    return {};
  }
}
