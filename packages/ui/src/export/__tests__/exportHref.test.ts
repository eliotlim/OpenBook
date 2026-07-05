import {describe, it, expect} from 'vitest';
import type {PageSnapshot} from '@book.dev/sdk';
import {toHtml} from '../toHtml';
import {blocksToHtml} from '../../blockeditor/exportBlocks';

/**
 * Security (Sasha, adjacent to #94): every anchor `href` rendered into a static
 * export was `escapeHtml`'d but NOT scheme-checked, so a `javascript:`/`data:`
 * link stayed live+clickable in the standalone file (a `file://`-origin XSS).
 * Every href sink now scheme-allowlists via the sdk `isSafeHref`; a rejected
 * href degrades to inert text / a non-link span. Benign links are unchanged.
 */

const snapshot = (blocks: unknown[]): PageSnapshot => ({editorjs: {blocks}, values: [], names: []});

describe('toHtml — inline link href is scheme-gated', () => {
  it('drops a javascript: inline link to inert text; keeps a benign one', () => {
    const evil = toHtml(snapshot([{type: 'paragraph', data: {text: '<a href="javascript:alert(1)">x</a>'}}]), 'T', '');
    expect(evil).not.toMatch(/<a\b[^>]*href="javascript:/i);
    expect(evil).not.toContain('href="javascript:');
    expect(evil).toContain('x'); // text survives, unlinked

    const ok = toHtml(snapshot([{type: 'paragraph', data: {text: '<a href="https://x.y/z">x</a>'}}]), 'T', '');
    expect(ok).toContain('<a href="https://x.y/z">x</a>');
  });
});

describe('toHtml — button + kit-button href are scheme-gated', () => {
  it('renders a hostile button url as the inert is-empty span', () => {
    const evil = toHtml(snapshot([{type: 'button', data: {url: 'javascript:alert(1)', label: 'Go'}}]), 'T', '');
    expect(evil).not.toContain('href="javascript:');
    expect(evil).toContain('<span class="button is-empty">Go</span>');
    const ok = toHtml(snapshot([{type: 'button', data: {url: 'https://x.y', label: 'Go'}}]), 'T', '');
    expect(ok).toContain('<a class="button" href="https://x.y"');
  });

  it('renders a hostile kit-button url as an inert labelled span', () => {
    const evil = toHtml(snapshot([{type: 'kitbutton', data: {action: 'link', url: 'data:text/html,<script>1</script>', label: 'Open'}}]), 'T', '');
    expect(evil).not.toContain('href="data:');
    expect(evil).toContain('<span class="kit-btn is-empty">Open</span>');
    const ok = toHtml(snapshot([{type: 'kitbutton', data: {action: 'link', url: 'https://x.y', label: 'Open'}}]), 'T', '');
    expect(ok).toContain('<a class="kit-btn" href="https://x.y"');
  });
});

describe('blocksToHtml (clipboard/export runs) — run link href is scheme-gated', () => {
  it('drops a javascript: run link to inert text; keeps a benign one', () => {
    const evil = blocksToHtml([{id: 'p', type: 'paragraph', text: [{t: 'x', a: {a: 'javascript:alert(1)'}}]}]);
    expect(evil).not.toContain('href="javascript:');
    expect(evil).not.toMatch(/<a\b/);
    expect(evil).toContain('x');
    const ok = blocksToHtml([{id: 'p', type: 'paragraph', text: [{t: 'x', a: {a: 'https://x.y'}}]}]);
    expect(ok).toContain('<a href="https://x.y">x</a>');
  });
});
