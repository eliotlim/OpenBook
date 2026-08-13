import {render, screen} from '@testing-library/react';
import {describe, expect, it, vi} from 'vitest';
import type {DatabaseProperty} from '@book.dev/sdk';
import {PropertyValueCell} from '../databaseCells';

vi.mock('@/providers', async () => {
  const {t} = await import('@/i18n');
  return {useTranslation: () => ({t})};
});

describe('database link cells', () => {
  it('names an email editor after its database property', () => {
    const property: DatabaseProperty = {
      id: 'p-contact-email',
      name: 'Contact email',
      type: 'email',
    };

    render(
      <PropertyValueCell
        property={property}
        value="reader@example.com"
        onChange={vi.fn()}
      />,
    );

    expect((screen.getByRole('textbox', {name: 'Contact email'}) as HTMLInputElement).value).toBe('reader@example.com');
  });
});
