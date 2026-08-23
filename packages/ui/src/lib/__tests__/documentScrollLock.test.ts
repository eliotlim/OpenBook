import {describe, expect, it} from 'vitest';
// @ts-expect-error -- Vitest runs in Node; the browser package omits Node ambient types.
import {readFileSync} from 'node:fs';

const CSS = readFileSync('src/index.css', 'utf8');

describe('document scroll lock', () => {
  const documentRules = CSS.match(/html,\s*body\s*\{[^}]+\}[\s\S]*?html\.ob-app[^}]+\}/)?.[0];
  expect(documentRules).toBeTruthy();

  function mountDocument({app = false, id}: {app?: boolean; id?: '__next' | 'root'} = {}) {
    document.documentElement.className = app ? 'ob-app' : '';

    const style = document.createElement('style');
    style.textContent = documentRules;
    document.head.append(style);

    const root = id ? document.createElement('div') : undefined;
    if (root && id) {
      root.id = id;
      document.body.append(root);
    }

    return {
      cleanup: () => {
        root?.remove();
        style.remove();
        document.documentElement.className = '';
      },
    };
  }

  function expectDocumentToBeLocked(locked: boolean) {
    expect(getComputedStyle(document.documentElement).height).toBe('100%');
    expect(getComputedStyle(document.body).height).toBe('100%');
    expect(getComputedStyle(document.documentElement).overflow).toBe(locked ? 'hidden' : '');
    expect(getComputedStyle(document.body).overflow).toBe(locked ? 'hidden' : '');
  }

  it.each(['__next', 'root'] as const)('locks an ob-app document with #%s', (id) => {
    const {cleanup} = mountDocument({app: true, id});

    expectDocumentToBeLocked(true);

    cleanup();
  });

  it('leaves a Vite-style embedder host with #root free to scroll', () => {
    const {cleanup} = mountDocument({id: 'root'});

    expectDocumentToBeLocked(false);

    cleanup();
  });

  it('leaves a bare document without mount ids free to scroll', () => {
    const {cleanup} = mountDocument();

    expectDocumentToBeLocked(false);

    cleanup();
  });
});
