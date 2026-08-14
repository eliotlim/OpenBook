import {afterEach, describe, expect, it, vi} from 'vitest';
import {cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {
  DatabaseFormRequestError,
  type DataClient,
  type DatabaseFormDescriptor,
} from '@book.dev/sdk';
import {PublicDatabaseForm} from '../PublicDatabaseForm';

vi.mock('@/providers', async () => {
  const {t} = await import('@/i18n');
  return {useTranslation: () => ({t})};
});

afterEach(cleanup);

const descriptor: DatabaseFormDescriptor = {
  title: 'Public intake',
  description: 'Only this descriptor is public.',
  submitLabel: 'Send response',
  acceptingResponses: true,
  fields: [
    {
      propertyId: 'title',
      type: 'text',
      label: 'Your name',
      help: '',
      required: true,
      placeholder: 'Ada Lovelace',
    },
    {
      propertyId: 'consent',
      type: 'checkbox',
      label: 'Consent',
      help: '',
      required: false,
      placeholder: '',
    },
  ],
};

type PublicClient = Pick<DataClient, 'getPublicDatabaseForm' | 'submitDatabaseForm' | 'uploadDatabaseFormFile'>;

function client(over: Partial<PublicClient> = {}): PublicClient {
  return {
    getPublicDatabaseForm: vi.fn().mockResolvedValue(descriptor),
    submitDatabaseForm: vi.fn().mockResolvedValue({rowId: 'row-1', submittedAt: '2026-08-13T00:00:00.000Z'}),
    uploadDatabaseFormFile: vi.fn(),
    ...over,
  };
}

const renderPublic = (publicClient: PublicClient) => render(
  <PublicDatabaseForm
    client={publicClient}
    databaseId="database-id"
    viewId="view-id"
    capability="fragment-secret"
  />,
);

describe('public database form surface', () => {
  it('renders only descriptor fields and submits the fragment capability', async () => {
    const publicClient = client();
    const {container} = renderPublic(publicClient);

    expect(await screen.findByText('Public intake')).toBeTruthy();
    expect(screen.getByText('Only this descriptor is public.')).toBeTruthy();
    expect(container.querySelector('[data-public-database-form-surface]')).toBeTruthy();
    expect(container.querySelector('nav')).toBeNull();
    expect(container.querySelector('[data-database-view]')).toBeNull();
    expect(screen.queryByText('Private host title')).toBeNull();
    expect(screen.queryByPlaceholderText(/Search pages/)).toBeNull();
    expect(screen.getByRole('textbox', {name: 'Your name'}).getAttribute('aria-required')).toBe('true');
    expect(screen.getByRole('textbox', {name: 'Your name'}).hasAttribute('aria-describedby')).toBe(false);

    fireEvent.change(screen.getByRole('textbox', {name: 'Your name'}), {target: {value: 'Ada Lovelace'}});
    fireEvent.click(screen.getByRole('checkbox', {name: 'Consent'}));
    fireEvent.click(screen.getByRole('button', {name: 'Send response'}));

    await waitFor(() => expect(publicClient.submitDatabaseForm).toHaveBeenCalledWith(
      'database-id',
      'view-id',
      {
        capability: 'fragment-secret',
        fields: {title: 'Ada Lovelace', consent: true},
        idempotencyKey: expect.any(String),
      },
    ));
    expect(await screen.findByText('Thanks — your response has been recorded.')).toBeTruthy();
  });

  it('renders the post-submit message returned by the server', async () => {
    renderPublic(client({
      submitDatabaseForm: vi.fn().mockResolvedValue({
        rowId: 'row-message',
        submittedAt: '2026-08-13T00:00:00.000Z',
        confirmation: {type: 'message', message: 'We received your application.'},
      }),
    }));
    await screen.findByText('Public intake');
    fireEvent.change(screen.getByRole('textbox', {name: 'Your name'}), {target: {value: 'Ada Lovelace'}});
    fireEvent.click(screen.getByRole('button', {name: 'Send response'}));

    expect(await screen.findByText('We received your application.')).toBeTruthy();
    expect(screen.getByRole('button', {name: 'Submit another response'})).toBeTruthy();
  });

  it('renders a no-auto-redirect Continue action returned by the server', async () => {
    renderPublic(client({
      submitDatabaseForm: vi.fn().mockResolvedValue({
        rowId: 'row-redirect',
        submittedAt: '2026-08-13T00:00:00.000Z',
        confirmation: {type: 'redirect', redirectUrl: 'https://example.com/thanks'},
      }),
    }));
    await screen.findByText('Public intake');
    fireEvent.change(screen.getByRole('textbox', {name: 'Your name'}), {target: {value: 'Grace Hopper'}});
    fireEvent.click(screen.getByRole('button', {name: 'Send response'}));

    const continueLink = await screen.findByRole('link', {name: 'Continue'});
    expect(continueLink.getAttribute('href')).toBe('https://example.com/thanks');
    expect(screen.queryByRole('button', {name: 'Submit another response'})).toBeNull();
  });

  it('renders the descriptor closed message without a submission control', async () => {
    renderPublic(client({
      getPublicDatabaseForm: vi.fn().mockResolvedValue({
        ...descriptor,
        acceptingResponses: false,
        closedMessage: 'Responses reopen Monday.',
      }),
    }));

    expect(await screen.findByText('Responses reopen Monday.')).toBeTruthy();
    expect(screen.queryByRole('button', {name: 'Send response'})).toBeNull();
    expect(document.querySelector('[data-public-form-closed]')).toBeTruthy();
  });

  it('shows an existence-hiding 404 surface for an invalid or revoked link', async () => {
    renderPublic(client({
      getPublicDatabaseForm: vi.fn().mockRejectedValue(new DatabaseFormRequestError(404, 'form not found')),
    }));

    expect(await screen.findByText('Form not found')).toBeTruthy();
    expect(screen.getByText('This link is invalid, expired, or has been revoked.')).toBeTruthy();
    expect(document.querySelector('[data-public-form-not-found]')).toBeTruthy();
  });

  it('keeps transport failures distinct from existence-hiding denials', async () => {
    renderPublic(client({
      getPublicDatabaseForm: vi.fn().mockRejectedValue(new TypeError('network unavailable')),
    }));

    expect(await screen.findByText('Form unavailable')).toBeTruthy();
    expect(screen.getByText('The form could not be loaded. Try again later.')).toBeTruthy();
    expect(document.querySelector('[data-public-form-not-found]')).toBeNull();
  });

  it('replaces the form with the exhausted surface after the response ceiling returns 429', async () => {
    renderPublic(client({
      submitDatabaseForm: vi.fn().mockRejectedValue(
        new DatabaseFormRequestError(429, 'response limit reached'),
      ),
    }));
    await screen.findByText('Public intake');
    fireEvent.change(screen.getByRole('textbox', {name: 'Your name'}), {target: {value: 'Grace Hopper'}});
    fireEvent.click(screen.getByRole('button', {name: 'Send response'}));

    expect(await screen.findByText('This form has received the maximum number of responses.')).toBeTruthy();
    expect(document.querySelector('[data-public-form-exhausted]')).toBeTruthy();
    expect(screen.queryByRole('button', {name: 'Send response'})).toBeNull();
  });

  it('renders a stale option rejection as the canonical per-field validation error', async () => {
    const submitDatabaseForm = vi.fn().mockRejectedValue(new DatabaseFormRequestError(
      400,
      undefined,
      [{propertyId: 'notes', code: 'option'}],
    ));
    renderPublic(client({
      getPublicDatabaseForm: vi.fn().mockResolvedValue({
        ...descriptor,
        fields: [{
          propertyId: 'notes',
          type: 'text',
          label: 'Notes',
          help: '',
          required: false,
          placeholder: '',
        }],
      }),
      submitDatabaseForm,
    }));

    const notes = await screen.findByRole('textbox', {name: 'Notes'});
    fireEvent.change(notes, {target: {value: 'stale after retype'}});
    fireEvent.click(screen.getByRole('button', {name: 'Send response'}));

    expect(await screen.findByText('Choose one of the available options.')).toBeTruthy();
    expect(notes.getAttribute('aria-invalid')).toBe('true');
    expect(notes.closest('[data-public-form-field]')?.textContent).toContain('Choose one of the available options.');
    expect(document.querySelector('[data-public-form-confirmation]')).toBeNull();
  });

  it('kills an already-loaded form when revocation is observed during submit', async () => {
    renderPublic(client({
      submitDatabaseForm: vi.fn().mockRejectedValue(new DatabaseFormRequestError(404, 'form not found')),
    }));
    await screen.findByText('Public intake');
    fireEvent.change(screen.getByRole('textbox', {name: 'Your name'}), {target: {value: 'Katherine Johnson'}});
    fireEvent.click(screen.getByRole('button', {name: 'Send response'}));

    expect(await screen.findByText('Form not found')).toBeTruthy();
    expect(document.querySelector('[data-public-form]')).toBeNull();
  });
});
