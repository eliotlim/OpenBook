import type {BlockTool, BlockToolConstructorOptions, BlockToolData, ToolboxConfig} from '@editorjs/editorjs';
import {t} from '@/i18n';
import {icon} from './shared';

interface ButtonData extends BlockToolData {
  label?: string;
  url?: string;
}

const isExternal = (url: string): boolean => /^https?:\/\//i.test(url);

/**
 * A call-to-action button linking to a URL. In the editor it shows a label + URL
 * field and a live preview; the preview is a real anchor so it can be followed.
 * The native inputs bubble `input` events to the editor holder, so edits
 * autosave like any other typing.
 */
export class ButtonBlock implements BlockTool {
  private data: ButtonData;
  private wrapper: HTMLDivElement | null = null;
  private labelInput: HTMLInputElement | null = null;
  private urlInput: HTMLInputElement | null = null;
  private preview: HTMLAnchorElement | null = null;

  constructor({data}: BlockToolConstructorOptions<ButtonData>) {
    this.data = data ?? {};
  }

  static get toolbox(): ToolboxConfig {
    return {
      title: t('blocks.button'),
      icon: icon('<rect x="3" y="8" width="18" height="8" rx="2"/><line x1="7" y1="12" x2="17" y2="12"/>'),
    };
  }

  static get sanitize() {
    return {label: false, url: false};
  }

  private syncPreview(): void {
    if (!this.preview) return;
    const label = this.labelInput?.value.trim() || t('blocks.buttonDefault');
    const url = this.urlInput?.value.trim() ?? '';
    this.preview.textContent = label;
    this.preview.href = url || '#';
    this.preview.classList.toggle('is-empty', !url);
    this.wrapper?.classList.toggle('block-button--configured', !!url);
    if (url && isExternal(url)) {
      this.preview.target = '_blank';
      this.preview.rel = 'noreferrer noopener';
    } else {
      this.preview.removeAttribute('target');
      this.preview.removeAttribute('rel');
    }
  }

  /** Show/hide the label + URL fields (a configured button reads as just the CTA). */
  private setEditing(on: boolean): void {
    this.wrapper?.classList.toggle('block-button--editing', on);
    if (on) {
      this.labelInput?.focus();
      this.labelInput?.select();
    }
  }

  render(): HTMLElement {
    const wrapper = document.createElement('div');
    wrapper.className = 'block-button';

    const fields = document.createElement('div');
    fields.className = 'block-button__fields';

    const label = document.createElement('input');
    label.type = 'text';
    label.className = 'block-button__input';
    label.placeholder = t('blocks.buttonLabelPlaceholder');
    label.value = this.data.label ?? '';
    // Verbatim inputs: no autocorrect/capitalise (matches the app's other URL fields).
    label.autocomplete = 'off';

    const url = document.createElement('input');
    url.type = 'text';
    url.className = 'block-button__input';
    url.placeholder = t('blocks.buttonUrlPlaceholder');
    url.value = this.data.url ?? '';
    url.autocomplete = 'off';
    url.setAttribute('autocapitalize', 'off');
    url.setAttribute('autocorrect', 'off');
    url.spellcheck = false;

    const preview = document.createElement('a');
    preview.className = 'block-button__cta';
    // Follow the link on click even though we're in an editor.
    preview.addEventListener('click', (e) => {
      if (!this.urlInput?.value.trim()) e.preventDefault();
    });

    label.addEventListener('input', () => this.syncPreview());
    url.addEventListener('input', () => this.syncPreview());

    fields.append(label, url);
    // CTA first: the fields tuck in *below* it while editing, so the button
    // itself never jumps as they appear.
    wrapper.append(preview, fields);

    // Once configured, leaving the block folds the fields away; the block
    // settings menu ("Edit button") brings them back.
    wrapper.addEventListener('focusout', (e) => {
      if (!wrapper.contains(e.relatedTarget as Node) && this.urlInput?.value.trim()) {
        this.setEditing(false);
      }
    });

    this.wrapper = wrapper;
    this.labelInput = label;
    this.urlInput = url;
    this.preview = preview;
    this.syncPreview();
    // A fresh / unconfigured button opens ready to edit.
    if (!(this.data.url ?? '').trim()) wrapper.classList.add('block-button--editing');
    return wrapper;
  }

  renderSettings() {
    return [
      {
        icon: icon('<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>'),
        title: t('blocks.buttonEdit'),
        onActivate: () => this.setEditing(true),
        closeOnActivate: true,
      },
    ];
  }

  save(): ButtonData {
    return {
      label: this.labelInput?.value.trim() ?? this.data.label ?? '',
      url: this.urlInput?.value.trim() ?? this.data.url ?? '',
    };
  }
}
