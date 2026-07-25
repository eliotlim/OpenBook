import {afterAll, afterEach, beforeAll, describe, expect, it} from 'vitest';
import {act, cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {createDoc, rootBlocks} from '../model';
import {BlockEditor} from '../BlockEditor';
import {PresentBlocks} from '../PresentBlocks';
import ImageLightbox from '@/components/ImageLightbox';
import {I18nProvider} from '@/providers/I18nProvider';
import {closeLightbox, getLightbox, openLightbox, useImageLightbox} from '@/lib/imageLightbox';

/**
 * The image lightbox (LBX-1): the module store + focus return, the block-view
 * triggers (Expand button in edit mode, click on a read-only / present image,
 * plain click inert while editing), and the overlay itself (image + caption,
 * a11y label, Esc / scrim / close-button dismissal).
 */

const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

afterEach(() => {
  act(() => closeLightbox());
  cleanup();
});

// A tiny probe that reflects the current store state into the DOM.
const Probe = () => {
  const s = useImageLightbox();
  return <div data-testid="probe" data-open={s ? 'yes' : 'no'} data-src={s?.src ?? ''} data-alt={s?.alt ?? ''} />;
};

describe('imageLightbox store', () => {
  it('opens, exposes the payload, and closes', () => {
    render(<Probe />);
    expect(screen.getByTestId('probe').dataset.open).toBe('no');
    act(() => openLightbox({src: TINY_PNG, alt: 'A cat', trigger: null}));
    const p = screen.getByTestId('probe');
    expect(p.dataset.open).toBe('yes');
    expect(p.dataset.src).toBe(TINY_PNG);
    expect(p.dataset.alt).toBe('A cat');
    act(() => closeLightbox());
    expect(screen.getByTestId('probe').dataset.open).toBe('no');
  });

  it('returns focus to the trigger element on close', async () => {
    const btn = document.createElement('button');
    document.body.appendChild(btn);
    act(() => openLightbox({src: TINY_PNG, alt: '', trigger: btn}));
    act(() => closeLightbox());
    await waitFor(() => expect(document.activeElement).toBe(btn));
    btn.remove();
  });
});

describe('imageLightbox triggers (block view)', () => {
  it('edit mode: the hover toolbar gains an Expand button that opens the overlay; a plain image click does not', () => {
    const doc = createDoc([{id: 'img', type: 'image', props: {src: TINY_PNG, alt: 'A cat'}}]);
    const {container} = render(<BlockEditor doc={doc} />);

    // A plain click on the picture does NOT open the lightbox while editing.
    const img = container.querySelector('img.obe-image-img') as HTMLImageElement;
    fireEvent.click(img);
    expect(getLightbox()).toBeNull();
    // The editable image is not a button (selection / drag-resize unaffected).
    expect(img.getAttribute('role')).toBeNull();

    // The Expand button opens it.
    act(() => fireEvent.click(screen.getByLabelText('Open full size')));
    const s = getLightbox();
    expect(s?.src).toBe(TINY_PNG);
    expect(s?.alt).toBe('A cat');
  });

  it('read-only: the image is a labelled button with a zoom cursor and opens the overlay on click', () => {
    const doc = createDoc([{id: 'img', type: 'image', props: {src: TINY_PNG, alt: 'A cat'}}]);
    const {container} = render(<BlockEditor doc={doc} readOnly />);
    const img = container.querySelector('img.obe-image-img') as HTMLImageElement;
    expect(img.classList.contains('obe-image-img-zoom')).toBe(true);
    expect(img.getAttribute('role')).toBe('button');
    // Alt-aware accessible name: the trigger announces which picture it opens.
    expect(img.getAttribute('aria-label')).toBe('View image full size: A cat');
    act(() => fireEvent.click(img));
    expect(getLightbox()?.src).toBe(TINY_PNG);
  });

  it('present mode: clicking the image opens the overlay', () => {
    const doc = createDoc([{id: 'img', type: 'image', props: {src: TINY_PNG, alt: 'A cat'}}]);
    const blocks = rootBlocks(doc).map((b) => b);
    const {container} = render(<PresentBlocks doc={doc} blocks={blocks} />);
    const img = container.querySelector('img.obe-image-img') as HTMLImageElement;
    expect(img.getAttribute('role')).toBe('button');
    act(() => fireEvent.click(img));
    expect(getLightbox()?.src).toBe(TINY_PNG);
  });
});

describe('ImageLightbox overlay', () => {
  const renderOverlay = () => render(
    <I18nProvider>
      <ImageLightbox />
    </I18nProvider>,
  );

  it('shows nothing when closed, then the image + caption + a11y label when open', () => {
    renderOverlay();
    expect(screen.queryByRole('dialog')).toBeNull();
    act(() => openLightbox({src: TINY_PNG, alt: 'A cat', trigger: null}));
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-label')).toBe('A cat'); // alt becomes the label
    const img = dialog.querySelector('img.obe-lightbox-img') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe(TINY_PNG);
    expect(dialog.querySelector('figcaption.obe-lightbox-caption')?.textContent).toBe('A cat');
    expect(screen.getByLabelText('Close')).toBeTruthy();
  });

  it('falls back to a generic label and no caption when alt is empty', () => {
    renderOverlay();
    act(() => openLightbox({src: TINY_PNG, alt: '', trigger: null}));
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-label')).toBe('Image viewer');
    expect(dialog.querySelector('figcaption.obe-lightbox-caption')).toBeNull();
  });

  it('the close button dismisses the overlay', async () => {
    renderOverlay();
    act(() => openLightbox({src: TINY_PNG, alt: 'A cat', trigger: null}));
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Close'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('Escape dismisses the overlay', async () => {
    renderOverlay();
    act(() => openLightbox({src: TINY_PNG, alt: 'A cat', trigger: null}));
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.keyDown(document, {key: 'Escape'});
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});

// The zoom/pan overlay (LBX-2). jsdom has no layout engine, so the geometry the
// overlay reads (offsetWidth/Height, naturalWidth, getBoundingClientRect) is
// stubbed to a known wide picture: natural 1600×900, fit-rendered 800×450 inside
// a 1000×700 stage → hundredScale 2 (100% = scale 2, fit reads as 50%).
describe('ImageLightbox overlay — zoom & pan (LBX-2)', () => {
  const geom: Array<() => void> = [];
  beforeAll(() => {
    const def = (proto: object, prop: string, get: () => number): void => {
      const prev = Object.getOwnPropertyDescriptor(proto, prop);
      Object.defineProperty(proto, prop, {configurable: true, get});
      geom.push(() => {
        if (prev) Object.defineProperty(proto, prop, prev);
        else delete (proto as Record<string, unknown>)[prop];
      });
    };
    def(HTMLImageElement.prototype, 'naturalWidth', () => 1600);
    def(HTMLImageElement.prototype, 'naturalHeight', () => 900);
    def(HTMLElement.prototype, 'offsetWidth', () => 800);
    def(HTMLElement.prototype, 'offsetHeight', () => 450);
    const rectFor = function (this: HTMLElement): DOMRect {
      // The stage is 1000×700; the picture reports its own transformed box, but
      // the overlay only reads the stage rect for the pivot, so a stable rect is
      // fine for both.
      return {x: 0, y: 0, left: 0, top: 0, right: 1000, bottom: 700, width: 1000, height: 700, toJSON: () => ({})} as DOMRect;
    };
    const prevRect = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = rectFor;
    geom.push(() => {
      HTMLElement.prototype.getBoundingClientRect = prevRect;
    });
  });
  afterAll(() => geom.forEach((r) => r()));

  const renderOverlay = () => render(
    <I18nProvider>
      <ImageLightbox />
    </I18nProvider>,
  );

  const openAndLoad = () => {
    act(() => openLightbox({src: TINY_PNG, alt: 'A cat', trigger: null}));
    const img = screen.getByRole('dialog').querySelector('img.obe-lightbox-img') as HTMLImageElement;
    act(() => fireEvent.load(img)); // marks the overlay 'ready' so chrome paints
    return img;
  };

  it('shows the zoom indicator once loaded (fit reads below 100% for a big picture)', () => {
    renderOverlay();
    openAndLoad();
    expect(screen.getByText('50%')).toBeTruthy(); // fit(1) / hundredScale(2)
  });

  it('double-click toggles fit ↔ 100% (indicator flips 50% ↔ 100%)', () => {
    renderOverlay();
    openAndLoad();
    const stage = screen.getByRole('dialog').querySelector('.obe-lightbox-stage') as HTMLElement;
    act(() => fireEvent.doubleClick(stage));
    expect(screen.getByText('100%')).toBeTruthy();
    act(() => fireEvent.doubleClick(stage));
    expect(screen.getByText('50%')).toBeTruthy();
  });

  it('keyboard +/- zoom and 0 resets to fit', () => {
    renderOverlay();
    openAndLoad();
    act(() => fireEvent.keyDown(document, {key: '+'}));
    expect(screen.getByText('63%')).toBeTruthy(); // 1.25 / 2 → 63%
    act(() => fireEvent.keyDown(document, {key: '0'}));
    expect(screen.getByText('50%')).toBeTruthy();
  });

  it('the reset control is disabled at fit and re-fits after zooming', () => {
    renderOverlay();
    openAndLoad();
    const reset = screen.getByLabelText('Reset zoom to fit') as HTMLButtonElement;
    expect(reset.disabled).toBe(true);
    act(() => fireEvent.keyDown(document, {key: '+'}));
    expect(reset.disabled).toBe(false);
    act(() => fireEvent.click(reset));
    expect(screen.getByText('50%')).toBeTruthy();
    expect((screen.getByLabelText('Reset zoom to fit') as HTMLButtonElement).disabled).toBe(true);
  });

  it('does NOT let Arrow/Space leak to a window keydown listener (PresentMode Deck)', () => {
    renderOverlay();
    openAndLoad();
    const deck: string[] = [];
    const spy = (e: KeyboardEvent): void => void deck.push(e.key);
    window.addEventListener('keydown', spy); // bubble-phase, like the Deck
    try {
      act(() => fireEvent.keyDown(document.body, {key: 'ArrowRight'}));
      act(() => fireEvent.keyDown(document.body, {key: ' '}));
      act(() => fireEvent.keyDown(document.body, {key: 'ArrowLeft'}));
      expect(deck).toEqual([]); // swallowed by the capture-phase guard
      // Escape is deliberately NOT swallowed — Radix owns close.
      act(() => fireEvent.keyDown(document.body, {key: 'Escape'}));
      expect(deck).toEqual(['Escape']);
    } finally {
      window.removeEventListener('keydown', spy);
    }
  });

  it('closes gracefully if the image source errors (objectURL revoked mid-view)', async () => {
    renderOverlay();
    const img = openAndLoad();
    expect(screen.getByRole('dialog')).toBeTruthy();
    act(() => fireEvent.error(img));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
