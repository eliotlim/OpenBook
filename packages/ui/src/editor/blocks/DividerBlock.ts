import type {BlockTool, BlockToolConstructorOptions, BlockToolData, ToolboxConfig} from '@editorjs/editorjs';
import {t} from '@/i18n';
import type {TKey} from '@/i18n';
import {makeEditable, icon} from './shared';

export type DividerStyle = 'line' | 'dashed' | 'dotted' | 'thick' | 'labeled';

interface DividerData extends BlockToolData {
  style?: DividerStyle;
  label?: string;
}

const STYLES: {value: DividerStyle; labelKey: TKey}[] = [
  {value: 'line', labelKey: 'blocks.dividerLine'},
  {value: 'dashed', labelKey: 'blocks.dividerDashed'},
  {value: 'dotted', labelKey: 'blocks.dividerDotted'},
  {value: 'thick', labelKey: 'blocks.dividerThick'},
  {value: 'labeled', labelKey: 'blocks.dividerLabeled'},
];

/**
 * A horizontal divider with a style variant (line / dashed / dotted / thick /
 * labeled). The line is drawn by CSS keyed off `data-style`; the `labeled`
 * variant reveals a centred contenteditable caption. Style is chosen via block
 * tunes and `dispatchChange()`s.
 */
export class DividerBlock implements BlockTool {
  private readonly block: BlockToolConstructorOptions<DividerData>['block'];
  private data: DividerData;
  private wrapper: HTMLElement | null = null;
  private labelEl: HTMLElement | null = null;

  constructor({data, block}: BlockToolConstructorOptions<DividerData>) {
    this.block = block;
    this.data = data ?? {};
  }

  static get toolbox(): ToolboxConfig {
    return {
      title: t('blocks.divider'),
      icon: icon('<line x1="3" y1="12" x2="21" y2="12"/>'),
    };
  }

  static get sanitize() {
    return {style: false, label: {}};
  }

  private get style(): DividerStyle {
    return this.data.style && STYLES.some((s) => s.value === this.data.style) ? this.data.style : 'line';
  }

  private setStyle(style: DividerStyle): void {
    this.data.style = style;
    if (this.wrapper) this.wrapper.dataset.style = style;
    this.block?.dispatchChange();
  }

  render(): HTMLElement {
    const wrapper = document.createElement('div');
    wrapper.className = 'block-divider';
    wrapper.dataset.style = this.style;

    const label = makeEditable({
      className: 'block-divider__label',
      html: this.data.label ?? '',
      placeholder: t('blocks.dividerLabelPlaceholder'),
    });

    wrapper.append(label);
    this.wrapper = wrapper;
    this.labelEl = label;
    return wrapper;
  }

  renderSettings() {
    return STYLES.map((s) => ({
      icon: icon('<line x1="3" y1="12" x2="21" y2="12"/>'),
      title: t(s.labelKey),
      isActive: this.style === s.value,
      onActivate: () => this.setStyle(s.value),
    }));
  }

  save(): DividerData {
    return {style: this.style, label: this.labelEl?.textContent?.trim() || undefined};
  }
}
