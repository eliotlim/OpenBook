import {afterEach, describe, expect, it} from 'vitest';
import {cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {t} from '@/i18n';
import {Command, CommandEmpty, CommandInput, CommandItem, CommandList} from '../command';
import {EmptyState} from '../empty-state';

afterEach(() => cleanup());

describe('EmptyState', () => {
  it('renders overlay content with compact overlay padding', () => {
    render(
      <EmptyState
        data-testid="empty"
        variant="overlay"
        icon={<span>Search icon</span>}
        title="No results"
        hint="Try another query."
        action={<button type="button">Clear search</button>}
      />,
    );

    const root = screen.getByTestId('empty');
    expect(root.className).toContain('py-6');
    expect(root.className).toContain('text-sm');
    expect(screen.getByText('Search icon')).toBeTruthy();
    expect(screen.getByText('No results')).toBeTruthy();
    expect(screen.getByText('Try another query.')).toBeTruthy();
    expect(screen.getByRole('button', {name: 'Clear search'})).toBeTruthy();
  });

  it('renders panel content with centered panel padding', () => {
    render(
      <EmptyState
        data-testid="empty"
        variant="panel"
        icon={<span>Panel icon</span>}
        title="Nothing here"
        hint="Create the first item."
        action={<button type="button">Create</button>}
      />,
    );

    const root = screen.getByTestId('empty');
    expect(root.className).toContain('py-8');
    expect(root.className).toContain('items-center');
    expect(root.className).toContain('text-center');
    expect(screen.getByText('Panel icon')).toBeTruthy();
    expect(screen.getByText('Nothing here').className).toContain('text-sm');
    expect(screen.getByText('Create the first item.').className).toContain('text-xs');
    expect(screen.getByRole('button', {name: 'Create'})).toBeTruthy();
  });
});

describe('CommandEmpty', () => {
  it('shows the localized empty state only when the query has no matches', async () => {
    render(
      <Command>
        <CommandInput aria-label="Search commands" />
        <CommandList>
          <CommandEmpty>{t('common.noOptions')}</CommandEmpty>
          <CommandItem value="Alpha">Alpha</CommandItem>
        </CommandList>
      </Command>,
    );

    const input = screen.getByRole('combobox');
    fireEvent.change(input, {target: {value: 'Missing'}});
    expect(await screen.findByText(t('common.noOptions'))).toBeTruthy();

    fireEvent.change(input, {target: {value: 'Alpha'}});
    await waitFor(() => expect(screen.queryByText(t('common.noOptions'))).toBeNull());
  });
});
