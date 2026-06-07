import type {BlockTool, BlockToolConstructorOptions, BlockToolData, ToolboxConfig} from '@editorjs/editorjs';
import {t} from '@/i18n';
import type {TKey} from '@/i18n';
import {RICH_TEXT_SANITIZE, makeEditable, icon} from './shared';

export type CalloutVariant = 'info' | 'warning' | 'success' | 'danger';

interface CalloutData extends BlockToolData {
  variant?: CalloutVariant;
  text?: string;
}

const VARIANTS: Record<CalloutVariant, {emoji: string; labelKey: TKey}> = {
  info: {emoji: '💡', labelKey: 'blocks.calloutInfo'},
  warning: {emoji: '⚠️', labelKey: 'blocks.calloutWarning'},
  success: {emoji: '✅', labelKey: 'blocks.calloutSuccess'},
  danger: {emoji: '🛑', labelKey: 'blocks.calloutDanger'},
};
const ORDER: CalloutVariant[] = ['info', 'warning', 'success', 'danger'];

/**
 * A coloured callout box: an emoji marker + a rich-text body, in one of four
 * variants (info / warning / success / danger). The body is contenteditable so
 * the inline toolbar works and typing autosaves via the editor's `input`
 * listener; changing the variant (block tunes or clicking the emoji) cycles it
 * and `dispatchChange()`s so the new variant is persisted.
 */
export class CalloutBlock implements BlockTool {
  private readonly block: BlockToolConstructorOptions<CalloutData>['block'];
  private data: CalloutData;
  private wrapper: HTMLElement | null = null;
  private emojiEl: HTMLElement | null = null;
  private bodyEl: HTMLElement | null = null;

  constructor({data, block}: BlockToolConstructorOptions<CalloutData>) {
    this.block = block;
    this.data = data ?? {};
  }

  static get toolbox(): ToolboxConfig {
    return {
      title: t('blocks.callout'),
      icon: icon('<path d="M3 5h18v11H8l-4 4z"/>'),
    };
  }

  static get sanitize() {
    return {variant: false, text: RICH_TEXT_SANITIZE};
  }

  private get variant(): CalloutVariant {
    return this.data.variant && this.data.variant in VARIANTS ? this.data.variant : 'info';
  }

  private setVariant(variant: CalloutVariant): void {
    this.data.variant = variant;
    if (this.wrapper) this.wrapper.dataset.variant = variant;
    if (this.emojiEl) this.emojiEl.textContent = VARIANTS[variant].emoji;
    this.block?.dispatchChange();
  }

  render(): HTMLElement {
    const variant = this.variant;
    const wrapper = document.createElement('div');
    wrapper.className = 'block-callout';
    wrapper.dataset.variant = variant;

    const emoji = document.createElement('button');
    emoji.type = 'button';
    emoji.className = 'block-callout__emoji';
    emoji.textContent = VARIANTS[variant].emoji;
    emoji.title = t('blocks.calloutCycle');
    // Clicking the emoji cycles to the next variant — a quick alternative to
    // the block tunes menu. preventDefault keeps the caret out of the button.
    emoji.addEventListener('mousedown', (e) => e.preventDefault());
    emoji.addEventListener('click', () => {
      const next = ORDER[(ORDER.indexOf(this.variant) + 1) % ORDER.length];
      this.setVariant(next);
    });

    const body = makeEditable({
      className: 'block-callout__body',
      html: this.data.text ?? '',
      placeholder: t('blocks.calloutPlaceholder'),
    });

    wrapper.append(emoji, body);
    this.wrapper = wrapper;
    this.emojiEl = emoji;
    this.bodyEl = body;
    return wrapper;
  }

  renderSettings() {
    return ORDER.map((variant) => ({
      icon: `<span style="font-size:15px;line-height:1">${VARIANTS[variant].emoji}</span>`,
      title: t(VARIANTS[variant].labelKey),
      isActive: this.variant === variant,
      onActivate: () => this.setVariant(variant),
    }));
  }

  save(): CalloutData {
    return {variant: this.variant, text: this.bodyEl?.innerHTML ?? this.data.text ?? ''};
  }
}
