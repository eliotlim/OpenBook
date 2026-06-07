import type {BlockTool, BlockToolConstructorOptions, BlockToolData, ToolboxConfig} from '@editorjs/editorjs';
import {t} from '@/i18n';
import {RICH_TEXT_SANITIZE, makeEditable, icon} from './shared';

interface AccordionData extends BlockToolData {
  title?: string;
  content?: string;
  open?: boolean;
}

/**
 * A collapsible toggle: a rich-text summary with a chevron + a rich-text body
 * that hides when collapsed. The open/closed state is part of the block data,
 * so it persists and round-trips through real-time sync; toggling it
 * `dispatchChange()`s. Both regions are contenteditable, so typing autosaves and
 * the inline toolbar works.
 */
export class AccordionBlock implements BlockTool {
  private readonly block: BlockToolConstructorOptions<AccordionData>['block'];
  private data: AccordionData;
  private wrapper: HTMLElement | null = null;
  private titleEl: HTMLElement | null = null;
  private contentEl: HTMLElement | null = null;

  constructor({data, block}: BlockToolConstructorOptions<AccordionData>) {
    this.block = block;
    this.data = data ?? {};
  }

  static get toolbox(): ToolboxConfig {
    return {
      title: t('blocks.accordion'),
      icon: icon('<polyline points="9 18 15 12 9 6"/>'),
    };
  }

  static get sanitize() {
    return {title: RICH_TEXT_SANITIZE, content: RICH_TEXT_SANITIZE, open: false};
  }

  private setOpen(open: boolean): void {
    this.data.open = open;
    if (this.wrapper) this.wrapper.dataset.open = String(open);
    this.block?.dispatchChange();
  }

  render(): HTMLElement {
    const open = this.data.open !== false; // default open
    const wrapper = document.createElement('div');
    wrapper.className = 'block-accordion';
    wrapper.dataset.open = String(open);

    const header = document.createElement('div');
    header.className = 'block-accordion__header';

    const chevron = document.createElement('button');
    chevron.type = 'button';
    chevron.className = 'block-accordion__chevron';
    chevron.setAttribute('aria-label', t('blocks.accordionToggle'));
    chevron.innerHTML = icon('<polyline points="9 18 15 12 9 6"/>');
    chevron.addEventListener('mousedown', (e) => e.preventDefault());
    chevron.addEventListener('click', () => this.setOpen(this.wrapper?.dataset.open !== 'true'));

    const title = makeEditable({
      className: 'block-accordion__title',
      html: this.data.title ?? '',
      placeholder: t('blocks.accordionTitlePlaceholder'),
    });

    header.append(chevron, title);

    const content = makeEditable({
      className: 'block-accordion__content',
      html: this.data.content ?? '',
      placeholder: t('blocks.accordionContentPlaceholder'),
    });

    wrapper.append(header, content);
    this.wrapper = wrapper;
    this.titleEl = title;
    this.contentEl = content;
    return wrapper;
  }

  save(): AccordionData {
    return {
      title: this.titleEl?.innerHTML ?? this.data.title ?? '',
      content: this.contentEl?.innerHTML ?? this.data.content ?? '',
      open: this.wrapper?.dataset.open !== 'false',
    };
  }
}
