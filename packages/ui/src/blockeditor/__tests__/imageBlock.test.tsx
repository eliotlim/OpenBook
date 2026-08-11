import {describe, it, expect, afterEach, vi} from 'vitest';
import {render, screen, cleanup, fireEvent, waitFor} from '@testing-library/react';
import {createDoc, decodeSnapshot, docToJSON, encodeSnapshot, rootBlocks} from '../model';
import {BlockEditor} from '../BlockEditor';
import {PresentBlocks} from '../PresentBlocks';
import {SLASH_ITEMS} from '../SlashMenu';
import {projectBlocksForExport, blocksToHtml, blocksToMarkdown} from '../exportBlocks';
import {
  IMAGE_BLOCK_TYPE,
  MAX_IMAGE_DATA_URL_BYTES,
  altFromFileName,
  imageBlockFromFile,
  isImageFile,
  type ImageBlockProps,
} from '../imageBlock';
import {editorFilesFromTransfer} from '../htmlArtifactBlock';
import {copyRenderedImage} from '../ImageBlockView';
import * as pageActions from '@/lib/pageActions';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  cleanup();
});

// A minimal valid 1×1 transparent PNG as a data URL (kept small so the render
// tests don't lean on the size cap).
const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const imgFile = (name = 'sunset_photo.png', type = 'image/png', body = 'hello'): File =>
  new File([body], name, {type});

describe('image block — copy rendered image', () => {
  it('copies the source URL as text when ClipboardItem is unavailable', async () => {
    vi.stubGlobal('ClipboardItem', undefined);
    const copyText = vi.spyOn(pageActions, 'copyText').mockResolvedValue(true);
    const image = document.createElement('img');

    await expect(copyRenderedImage(image, 'https://images.test/cat.png')).resolves.toBe('url');
    expect(copyText).toHaveBeenCalledWith('https://images.test/cat.png');
  });

  it('falls back to copying the source URL when canvas.toBlob throws', async () => {
    vi.stubGlobal('ClipboardItem', class ClipboardItem {});
    vi.stubGlobal('navigator', {clipboard: {write: vi.fn()}});
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(() => {
      throw new Error('encoding failed');
    });
    const copyText = vi.spyOn(pageActions, 'copyText').mockResolvedValue(true);

    await expect(copyRenderedImage(document.createElement('img'), 'https://images.test/cat.png')).resolves.toBe(
      'url',
    );
    expect(copyText).toHaveBeenCalledWith('https://images.test/cat.png');
  });

  it('refuses blob and oversized data URL fallbacks but uses an original URL when available', async () => {
    vi.stubGlobal('ClipboardItem', undefined);
    const copyText = vi.spyOn(pageActions, 'copyText').mockResolvedValue(true);
    const image = document.createElement('img');
    const hugeDataUrl = `data:image/png;base64,${'a'.repeat(MAX_IMAGE_DATA_URL_BYTES)}`;

    await expect(copyRenderedImage(image, 'blob:temporary')).resolves.toBe('failed');
    await expect(copyRenderedImage(image, hugeDataUrl)).resolves.toBe('failed');
    await expect(copyRenderedImage(image, 'blob:temporary', 'https://images.test/original.png')).resolves.toBe('url');
    expect(copyText).toHaveBeenCalledTimes(1);
    expect(copyText).toHaveBeenCalledWith('https://images.test/original.png');
  });
});

/**
 * Native image block (Assets A0, data-URL phase-1): model round-trip, the three
 * ingest paths, the size cap, present/read-only chrome, and export safety.
 */
describe('image block — model + snapshot round-trip', () => {
  it('round-trips src/alt/caption/width through encode → decode → JSON', () => {
    const doc = createDoc([
      {id: 'img', type: 'image', props: {src: TINY_PNG, alt: 'A sunset', caption: 'Golden hour', width: '60%'}},
    ]);
    const restored = decodeSnapshot(encodeSnapshot(doc));
    const json = docToJSON(restored);
    const block = json.find((b) => b.id === 'img');
    expect(block).toBeTruthy();
    expect(block!.type).toBe('image');
    expect(block!.props).toMatchObject({src: TINY_PNG, alt: 'A sunset', caption: 'Golden hour', width: '60%'});
    // A leaf block — no text, no children.
    expect(block!.text).toBeUndefined();
    expect(block!.children).toBeUndefined();
  });
});

describe('image block — ingest (paste / drop / slash all use imageBlockFromFile)', () => {
  it('produces an image block with a data-URL src and an alt seeded from the file name', async () => {
    // No pageId / asset backend here (no bridge installed) → the fallback inline
    // data-URL path (the assetId upload path is covered in imageBlockAssets.test).
    const res = await imageBlockFromFile(imgFile('sunset_photo.png'));
    expect('block' in res).toBe(true);
    if (!('block' in res)) return;
    expect(res.block.type).toBe(IMAGE_BLOCK_TYPE);
    const props = res.block.props as unknown as ImageBlockProps;
    expect(props.src?.startsWith('data:image/png')).toBe(true);
    expect(props.alt).toBe('sunset photo'); // underscores → spaces, extension stripped
  });

  it('altFromFileName cleans names', () => {
    expect(altFromFileName('my-cat_pic.jpeg')).toBe('my cat pic');
    expect(altFromFileName('IMG_1234.PNG')).toBe('IMG 1234');
  });

  it('extracts image files from a paste/drop transfer (files first, items fallback, filter)', () => {
    // The one mixed funnel (editorFilesFromTransfer) handles the image cases the
    // old image-only extractor covered.
    const file = imgFile();
    // Paste/drop usually expose `.files`.
    expect(editorFilesFromTransfer({files: [file], items: []} as unknown as DataTransfer)).toEqual([file]);
    // Some clipboard pastes only expose the image via `.items`.
    const viaItems = editorFilesFromTransfer({
      files: [],
      items: [{kind: 'file', getAsFile: () => file}],
    } as unknown as DataTransfer);
    expect(viaItems).toEqual([file]);
    // Non-ingestible files are ignored.
    const text = new File(['x'], 'notes.txt', {type: 'text/plain'});
    expect(editorFilesFromTransfer({files: [text], items: []} as unknown as DataTransfer)).toEqual([]);
  });

  it('isImageFile narrows correctly', () => {
    expect(isImageFile(imgFile())).toBe(true);
    expect(isImageFile(new File(['x'], 'a.txt', {type: 'text/plain'}))).toBe(false);
    expect(isImageFile(null)).toBe(false);
  });

  it('the /Image slash command exists and lands on an upload placeholder', () => {
    // Path (c): the slash command inserts an empty image block, whose
    // placeholder opens the file picker (which routes through imageBlockFromFile).
    const item = SLASH_ITEMS.find((s) => s.id === 'image');
    expect(item).toBeTruthy();
    const doc = createDoc([{id: 'img', type: 'image'}]);
    render(<BlockEditor doc={doc} />);
    expect(screen.getByLabelText('Upload an image')).toBeTruthy();
    expect(screen.getByLabelText('Choose an image file')).toBeTruthy();
  });
});

describe('image block — size cap', () => {
  it('rejects an over-cap image with a friendly message (no throw)', async () => {
    // ~900 KiB of body → ~1.2 MiB base64 data URL, over the 1 MiB cap.
    const big = new File(['a'.repeat(900 * 1024)], 'huge.png', {type: 'image/png'});
    const res = await imageBlockFromFile(big);
    expect('error' in res).toBe(true);
    if ('error' in res) expect(res.error.toLowerCase()).toContain('asset store');
  });

  it('rejects a non-image file gracefully', async () => {
    const res = await imageBlockFromFile(new File(['x'], 'a.txt', {type: 'text/plain'}));
    expect('error' in res).toBe(true);
  });

  it('the cap is ~1 MiB', () => {
    expect(MAX_IMAGE_DATA_URL_BYTES).toBe(1024 * 1024);
  });

  it('renders the size-cap notice in a muted tone, a bad file in the destructive tone', async () => {
    const doc = createDoc([{id: 'img', type: 'image'}]);
    const {container} = render(<BlockEditor doc={doc} />);
    const input = screen.getByLabelText('Choose an image file');

    // Over-cap image → soft, muted notice (not destructive red).
    fireEvent.change(input, {target: {files: [new File(['a'.repeat(900 * 1024)], 'huge.png', {type: 'image/png'})]}});
    await waitFor(() => expect(container.querySelector('.obe-image-notice')).toBeTruthy());
    expect(container.querySelector('.obe-image-error')).toBeNull();

    // A non-image → hard, destructive error.
    fireEvent.change(input, {target: {files: [new File(['x'], 'notes.txt', {type: 'text/plain'})]}});
    await waitFor(() => expect(container.querySelector('.obe-image-error')).toBeTruthy());
    expect(container.querySelector('.obe-image-notice')).toBeNull();
  });
});

describe('image block — render, resize, alt/caption', () => {
  it('shows the image with editable alt, caption, size presets and a resize handle when writable', () => {
    const doc = createDoc([{id: 'img', type: 'image', props: {src: TINY_PNG, alt: 'A cat'}}]);
    const {container} = render(<BlockEditor doc={doc} />);

    const img = container.querySelector('img.obe-image-img') as HTMLImageElement;
    expect(img).toBeTruthy();
    expect(img.getAttribute('src')).toBe(TINY_PNG);
    expect(img.getAttribute('alt')).toBe('A cat');

    // Editable alt + caption.
    expect(screen.getByLabelText('Alt text')).toBeTruthy();
    expect(screen.getByLabelText('Image caption')).toBeTruthy();

    // Resize handle + size presets.
    expect(screen.getByLabelText('Resize image')).toBeTruthy();
    expect(screen.getByLabelText('Small')).toBeTruthy();
    expect(screen.getByLabelText('Medium')).toBeTruthy();
    expect(screen.getByLabelText('Full width')).toBeTruthy();
  });

  it('a size preset persists width to props', () => {
    const doc = createDoc([{id: 'img', type: 'image', props: {src: TINY_PNG}}]);
    render(<BlockEditor doc={doc} />);
    fireEvent.click(screen.getByLabelText('Small'));
    const block = docToJSON(doc).find((b) => b.id === 'img');
    expect(block!.props?.width).toBe('30%');
  });

  it('editing the caption persists it to props', () => {
    const doc = createDoc([{id: 'img', type: 'image', props: {src: TINY_PNG}}]);
    render(<BlockEditor doc={doc} />);
    fireEvent.change(screen.getByLabelText('Image caption'), {target: {value: 'Hello caption'}});
    const block = docToJSON(doc).find((b) => b.id === 'img');
    expect(block!.props?.caption).toBe('Hello caption');
  });

  it('right-clicking the image opens its item-specific menu', () => {
    const doc = createDoc([{id: 'img', type: 'image', props: {src: TINY_PNG, alt: 'A cat'}}]);
    const {container} = render(<BlockEditor doc={doc} />);
    fireEvent.contextMenu(container.querySelector('img.obe-image-img')!);

    for (const label of [
      'Copy image',
      'Save image as…',
      'Open original',
      'Replace image…',
      'Set alt text…',
      'Image size',
      'Delete block',
    ]) {
      expect(screen.getByText(label), label).toBeTruthy();
    }
  });

  it('the image menu delete action removes that block', () => {
    const doc = createDoc([
      {id: 'img', type: 'image', props: {src: TINY_PNG}},
      {id: 'p', type: 'paragraph', text: [{t: 'Keep me'}]},
    ]);
    const {container} = render(<BlockEditor doc={doc} />);
    fireEvent.contextMenu(container.querySelector('img.obe-image-img')!);
    fireEvent.click(screen.getByText('Delete block'));

    expect(docToJSON(doc).map((block) => block.id)).toEqual(['p']);
  });

  it('does not expose the image menu on a non-image block', () => {
    const doc = createDoc([{id: 'p', type: 'paragraph', text: [{t: 'Plain text'}]}]);
    const {container} = render(<BlockEditor doc={doc} />);
    fireEvent.contextMenu(container.querySelector('[data-block-text="p"]')!);

    expect(screen.queryByText('Copy image')).toBeNull();
    expect(screen.queryByText('Open original')).toBeNull();
  });
});

describe('image block — present / read-only hides edit chrome', () => {
  it('renders the image + caption but no edit affordances to a viewer', () => {
    const doc = createDoc([
      {id: 'img', type: 'image', props: {src: TINY_PNG, alt: 'A cat', caption: 'Meow'}},
    ]);
    const {container} = render(<BlockEditor doc={doc} readOnly />);

    // Image and caption still show.
    expect(container.querySelector('img.obe-image-img')).toBeTruthy();
    expect(container.querySelector('figcaption.obe-image-caption')?.textContent).toBe('Meow');

    // No edit chrome anywhere.
    expect(screen.queryByLabelText('Alt text')).toBeNull();
    expect(screen.queryByLabelText('Image caption')).toBeNull();
    expect(screen.queryByLabelText('Resize image')).toBeNull();
    expect(screen.queryByLabelText('Small')).toBeNull();
    expect(screen.queryByLabelText('Replace image')).toBeNull();
    expect(screen.queryByLabelText('Choose an image file')).toBeNull();
  });

  it('an empty image block shows a static marker (no upload) to a viewer', () => {
    const doc = createDoc([{id: 'img', type: 'image'}]);
    render(<BlockEditor doc={doc} readOnly />);
    expect(screen.queryByLabelText('Upload an image')).toBeNull();
    expect(screen.queryByLabelText('Choose an image file')).toBeNull();
  });

  it('present mode (locked context, writable editor) also freezes the image chrome', () => {
    const doc = createDoc([{id: 'img', type: 'image', props: {src: TINY_PNG, alt: 'A cat', caption: 'Meow'}}]);
    const blocks = rootBlocks(doc).map((b) => b);
    const {container} = render(<PresentBlocks doc={doc} blocks={blocks} />);
    expect(container.querySelector('img.obe-image-img')).toBeTruthy();
    expect(container.querySelector('figcaption.obe-image-caption')?.textContent).toBe('Meow');
    expect(screen.queryByLabelText('Alt text')).toBeNull();
    expect(screen.queryByLabelText('Resize image')).toBeNull();
    expect(screen.queryByLabelText('Replace image')).toBeNull();
  });
});

describe('image block — export is crash-safe (real image export is Assets A3)', () => {
  const blocks = [
    {id: 'h', type: 'heading', text: [{t: 'Title'}], props: {level: 1}},
    {id: 'img', type: 'image', props: {src: TINY_PNG, alt: 'A cat', caption: 'Meow'}},
    {id: 'p', type: 'paragraph', text: [{t: 'After'}]},
  ] as Parameters<typeof blocksToHtml>[0];

  it('HTML / Markdown / EditorJS exporters do not throw on an image block', () => {
    expect(() => blocksToHtml(blocks)).not.toThrow();
    expect(() => blocksToMarkdown(blocks)).not.toThrow();
    expect(() => projectBlocksForExport(blocks)).not.toThrow();
    // The surrounding blocks still export.
    expect(blocksToHtml(blocks)).toContain('Title');
    expect(blocksToMarkdown(blocks)).toContain('After');
  });
});

// A minimal mock DataTransfer for paste/drop events (happy-dom has no real one).
const fileDT = (files: File[], types: string[] = ['Files']): DataTransfer =>
  ({files, items: [], types, dropEffect: '', effectAllowed: '', getData: () => '', setData: () => {}}) as unknown as DataTransfer;
const textCD = (): DataTransfer =>
  ({files: [], items: [], types: ['text/plain'], getData: () => 'hello', setData: () => {}}) as unknown as DataTransfer;

const hasImageBlock = (doc: Parameters<typeof docToJSON>[0]): boolean =>
  docToJSON(doc).some((b) => b.type === 'image');

describe('image block — paste / drop event integration (regression guard)', () => {
  it('a text paste falls through; an image paste inserts an image block', async () => {
    const doc = createDoc([{id: 'p', type: 'paragraph', text: [{t: 'x'}]}]);
    const {container} = render(<BlockEditor doc={doc} />);
    const root = container.querySelector('.obe-root') as HTMLElement;

    // A plain text paste is not ours — it must not create an image block (and it
    // stays cancelable for the text block's own beforeinput handler).
    fireEvent.paste(root, {clipboardData: textCD()});
    expect(hasImageBlock(doc)).toBe(false);

    // An image paste → an image block (via the async FileReader ingest).
    fireEvent.paste(root, {clipboardData: fileDT([imgFile()])});
    await waitFor(() => expect(hasImageBlock(doc)).toBe(true));
  });

  it('a file drop is ignored during an internal block move, but handled otherwise', async () => {
    const doc = createDoc([
      {id: 'a', type: 'paragraph', text: [{t: 'A'}]},
      {id: 'b', type: 'paragraph', text: [{t: 'B'}]},
    ]);
    const {container} = render(<BlockEditor doc={doc} />);
    const root = container.querySelector('.obe-root') as HTMLElement;
    const handle = screen.getAllByLabelText('Drag to move, click for actions')[0];

    // Internal block-move drag active → an external file drop is NOT our drop.
    fireEvent.dragStart(handle, {dataTransfer: fileDT([], [])});
    fireEvent.drop(root, {dataTransfer: fileDT([imgFile()])});
    expect(hasImageBlock(doc)).toBe(false);
    fireEvent.dragEnd(handle);

    // No internal drag → the file drop is handled.
    fireEvent.dragOver(root, {dataTransfer: fileDT([imgFile()])});
    fireEvent.drop(root, {dataTransfer: fileDT([imgFile()])});
    await waitFor(() => expect(hasImageBlock(doc)).toBe(true));
  });

  it('dropping a NON-image file is prevented (no browser navigation) and inserts nothing', () => {
    const doc = createDoc([{id: 'p', type: 'paragraph', text: [{t: 'x'}]}]);
    const {container} = render(<BlockEditor doc={doc} />);
    const root = container.querySelector('.obe-root') as HTMLElement;
    const pdf = new File(['%PDF-1.4'], 'doc.pdf', {type: 'application/pdf'});

    fireEvent.dragOver(root, {dataTransfer: fileDT([pdf])});
    // fireEvent returns false when the event was default-prevented — which is
    // exactly the MEDIUM fix: we claim the drop so the browser can't navigate
    // away to open the file.
    const notPrevented = fireEvent.drop(root, {dataTransfer: fileDT([pdf])});
    expect(notPrevented).toBe(false);
    expect(hasImageBlock(doc)).toBe(false);
  });
});
