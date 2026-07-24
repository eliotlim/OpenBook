import {afterEach, describe, expect, it} from 'vitest';
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
const Probe = (): JSX.Element => {
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
    expect(img.getAttribute('aria-label')).toBe('View image full size');
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
