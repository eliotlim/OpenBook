import {afterEach, beforeAll, describe, expect, it} from 'vitest';
import {act, cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import EmojiPickerHost from '../EmojiPickerHost';
import {IconPicker} from '../IconPicker';
import {Popover, PopoverContent, PopoverTrigger} from '../ui/popover';
import {I18nProvider} from '@/providers';
import {emojiPicker} from '@/lib/emojiPicker';

beforeAll(() => {
  if (!('ResizeObserver' in globalThis)) {
    (globalThis as unknown as {ResizeObserver: unknown}).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
});

afterEach(() => {
  emojiPicker.close();
  cleanup();
});

describe('EmojiPickerHost in a parent popover', () => {
  it('keeps the parent open while opening and interacting with the portaled picker', async () => {
    render(
      <I18nProvider>
        <Popover defaultOpen>
          <PopoverTrigger>Settings</PopoverTrigger>
          <PopoverContent>
            <div>Page settings</div>
            <IconPicker value="📄" onPick={() => {}} ariaLabel="Change icon" />
          </PopoverContent>
        </Popover>
        <EmojiPickerHost />
      </I18nProvider>,
    );

    expect(screen.getByText('Page settings')).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole('button', {name: 'Change icon'})));

    const search = await screen.findByRole('textbox', {name: 'Search emoji'});
    expect(screen.getByText('Page settings')).toBeTruthy();

    fireEvent.pointerDown(search);
    fireEvent.click(search);
    await waitFor(() => expect(screen.getByText('Page settings')).toBeTruthy());
  });
});
