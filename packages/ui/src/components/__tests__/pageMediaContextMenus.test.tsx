import {afterEach, describe, expect, it, vi} from 'vitest';
import {cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {PageCoverBanner} from '../PageCover';
import {PageHeader} from '@/screens/pageChrome';
import {I18nProvider} from '@/providers';
import {emojiPicker} from '@/lib/emojiPicker';
import {readPageCover, writePageCover} from '@/lib/pageCover';

const pageId = 'page-media-context-menu-test';

afterEach(() => {
  writePageCover(pageId, null);
  vi.restoreAllMocks();
  cleanup();
});

describe('page cover context menu', () => {
  const renderCover = () => {
    writePageCover(pageId, {kind: 'image', url: 'https://example.test/cover.jpg', position: 50});
    return render(
      <I18nProvider>
        <PageCoverBanner pageId={pageId} />
      </I18nProvider>,
    );
  };

  it('renders the cover actions and reuses the remove handler', async () => {
    const {container} = renderCover();
    fireEvent.contextMenu(container.querySelector('.ob-page-cover')!);

    const reposition = await screen.findByRole('menuitem', {name: 'Reposition'});
    expect(reposition.closest('[role="menu"]')?.classList.contains('w-52')).toBe(true);
    expect(screen.getByRole('menuitem', {name: 'Replace…'})).toBeTruthy();
    const remove = screen.getByRole('menuitem', {name: 'Remove'});
    expect(remove.previousElementSibling?.getAttribute('role')).toBe('separator');
    fireEvent.click(remove);
    expect(readPageCover(pageId)).toBeNull();
  });

  it('opens the existing cover picker from Replace', async () => {
    const {container} = renderCover();
    fireEvent.contextMenu(container.querySelector('.ob-page-cover')!);
    fireEvent.click(await screen.findByRole('menuitem', {name: 'Replace…'}));

    expect(await screen.findByText('Choose a cover')).toBeTruthy();
  });
});

describe('page icon context menu', () => {
  const renderHeader = (onIconChange = vi.fn()) => ({
    onIconChange,
    ...render(
      <I18nProvider>
        <PageHeader title="Menu test" icon="📘" onIconChange={onIconChange} />
      </I18nProvider>,
    ),
  });

  it('renders the icon actions and reuses the remove handler', async () => {
    const {onIconChange} = renderHeader();
    fireEvent.contextMenu(screen.getByLabelText('Change page icon'));

    const changeIcon = await screen.findByRole('menuitem', {name: 'Change icon…'});
    expect(changeIcon.closest('[role="menu"]')?.classList.contains('w-52')).toBe(true);
    fireEvent.click(screen.getByRole('menuitem', {name: 'Remove icon'}));
    expect(onIconChange).toHaveBeenCalledWith('');
  });

  it('opens the existing IconPicker from Change icon', async () => {
    const open = vi.spyOn(emojiPicker, 'open').mockImplementation(() => {});
    renderHeader();
    fireEvent.contextMenu(screen.getByLabelText('Change page icon'));
    fireEvent.click(await screen.findByRole('menuitem', {name: 'Change icon…'}));

    await waitFor(() => expect(open).toHaveBeenCalledTimes(1));
  });
});
