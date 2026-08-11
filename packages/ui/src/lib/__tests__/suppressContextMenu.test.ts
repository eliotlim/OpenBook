import {afterEach, describe, expect, it} from 'vitest';
import {suppressContextMenu} from '../suppressContextMenu';

afterEach(() => document.body.replaceChildren());

const dispatchContextMenu = (target: Element): MouseEvent => {
  const event = new MouseEvent('contextmenu', {bubbles: true, cancelable: true});
  target.dispatchEvent(event);
  return event;
};

describe('suppressContextMenu', () => {
  it('prevents the native menu without stopping propagation on non-editable targets', () => {
    const surface = document.createElement('div');
    const child = document.createElement('span');
    surface.append(child);
    document.body.append(surface);
    surface.addEventListener('contextmenu', suppressContextMenu);

    let bubbled = 0;
    document.body.addEventListener('contextmenu', () => bubbled += 1, {once: true});
    const event = dispatchContextMenu(child);

    expect(event.defaultPrevented).toBe(true);
    expect(bubbled).toBe(1);
  });

  it('always preserves native menus for inputs, textareas, and editable content', () => {
    const surface = document.createElement('div');
    surface.innerHTML = [
      '<input>',
      '<textarea></textarea>',
      '<div contenteditable="true"><span data-editor-child>text</span></div>',
    ].join('');
    document.body.append(surface);
    surface.addEventListener('contextmenu', suppressContextMenu);

    for (const target of surface.querySelectorAll('input, textarea, [data-editor-child]')) {
      expect(dispatchContextMenu(target).defaultPrevented).toBe(false);
    }
  });

  it('suppresses a contenteditable=false island inside editable content', () => {
    const surface = document.createElement('div');
    surface.innerHTML = '<div contenteditable="true"><span contenteditable="false"><i>chrome</i></span></div>';
    document.body.append(surface);
    surface.addEventListener('contextmenu', suppressContextMenu);

    expect(dispatchContextMenu(surface.querySelector('i')!).defaultPrevented).toBe(true);
  });
});
