import {act} from 'react';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {
  FormSubmissionError,
  type DataClient,
  type FormField,
  type FormSchema,
  type FormSubmissionResult,
} from '@book.dev/sdk';
import {cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {showToast} from '@/components/ui/toast';
import {
  FormSubmissionView,
  mintFormIdempotencyKey,
  safeFormRedirect,
  stripReservedFormValues,
} from '../FormSubmissionView';

vi.mock('@/components/ui/toast', () => ({showToast: vi.fn()}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const makeField = (kind: FormField['kind'], over: Partial<FormField> = {}): FormField => ({
  id: kind,
  kind,
  label: kind,
  required: false,
  ...over,
});

const schemaWith = (fields: FormField[], confirmation: FormSchema['confirmation'] = {message: 'Received'}): FormSchema => ({
  formId: 'contact',
  submissionKey: 'short-and-long-keys-are-both-accepted',
  enabled: true,
  databaseId: 'contacts',
  fields,
  confirmation,
});

type SubmitForm = NonNullable<DataClient['submitForm']>;

const submitClient = (submitForm: SubmitForm): DataClient & Required<Pick<DataClient, 'submitForm'>> => ({
  submitForm,
} as unknown as DataClient & Required<Pick<DataClient, 'submitForm'>>);

describe('FormSubmissionView fields and validation', () => {
  it('renders every field kind as a live control and hides the skipped honeypot', () => {
    const fields: FormField[] = [
      makeField('text'),
      makeField('longtext'),
      makeField('number'),
      makeField('select', {options: [{id: 'red', label: 'Red'}]}),
      makeField('multiselect', {options: [{id: 'blue', label: 'Blue'}]}),
      makeField('checkbox'),
      makeField('date'),
      makeField('email'),
      makeField('phone'),
      makeField('url'),
      makeField('rating'),
      makeField('files'),
      makeField('text', {id: 'website', label: 'Website', honeypot: true}),
    ];
    const {container} = render(
      <FormSubmissionView schema={schemaWith(fields)} pageId="page-1" client={submitClient(vi.fn())} />,
    );

    expect(container.querySelector('[data-form-field-kind="text"] input[type="text"]')).toBeTruthy();
    expect(container.querySelector('[data-form-field-kind="longtext"] textarea')).toBeTruthy();
    expect(container.querySelector('[data-form-field-kind="number"] input[type="number"]')).toBeTruthy();
    expect(container.querySelector('[data-form-field-kind="select"] select:not([multiple])')).toBeTruthy();
    expect(container.querySelector('[data-form-field-kind="multiselect"] select[multiple]')).toBeTruthy();
    expect(container.querySelector('[data-form-field-kind="checkbox"] input[type="checkbox"]')).toBeTruthy();
    expect(container.querySelector('[data-form-field-kind="date"] input[type="date"]')).toBeTruthy();
    expect(container.querySelector('[data-form-field-kind="email"] input[type="email"]')).toBeTruthy();
    expect(container.querySelector('[data-form-field-kind="phone"] input[type="tel"]')).toBeTruthy();
    expect(container.querySelector('[data-form-field-kind="url"] input[type="url"]')).toBeTruthy();
    expect(container.querySelector('[data-form-field-kind="rating"] input[type="range"]')).toBeTruthy();
    expect(container.querySelector('[data-form-field-kind="files"] input[type="file"]')).toBeTruthy();
    const honeypot = container.querySelector<HTMLInputElement>('.obe-sr-only input');
    expect(honeypot?.tabIndex).toBe(-1);
    expect(honeypot?.disabled).toBe(false);
  });

  it('validates on blur and submit with linked inline errors', async () => {
    const submitForm = vi.fn();
    render(
      <FormSubmissionView
        schema={schemaWith([
          makeField('text', {id: 'name', label: 'Name', required: true}),
          makeField('email', {id: 'email', label: 'Email', required: true}),
        ])}
        pageId="page-1"
        client={submitClient(submitForm)}
      />,
    );

    const name = screen.getByRole('textbox', {name: /Name/});
    fireEvent.blur(name);
    expect(name.getAttribute('aria-invalid')).toBe('true');
    expect(name.getAttribute('aria-describedby')).toBeTruthy();
    expect(screen.getByText('This field is required.')).toBeTruthy();

    fireEvent.change(name, {target: {value: 'Ada'}});
    fireEvent.change(screen.getByRole('textbox', {name: /Email/}), {target: {value: 'not-an-email'}});
    fireEvent.click(screen.getByRole('button', {name: 'Submit'}));
    expect(await screen.findByText('Enter a valid email address.')).toBeTruthy();
    expect(submitForm).not.toHaveBeenCalled();
  });

  it('maps server 400 field errors back into the matching error slot', async () => {
    const submitForm = vi.fn().mockRejectedValue(
      new FormSubmissionError(400, [{fieldId: 'email', code: 'maxLength'}]),
    );
    render(
      <FormSubmissionView
        schema={schemaWith([makeField('email', {id: 'email', label: 'Email'})])}
        pageId="page-1"
        client={submitClient(submitForm)}
      />,
    );
    fireEvent.change(screen.getByRole('textbox', {name: 'Email'}), {target: {value: 'ada@example.com'}});
    fireEvent.click(screen.getByRole('button', {name: 'Submit'}));
    expect(await screen.findByText('The response is too long.')).toBeTruthy();
    expect(screen.getByRole('textbox', {name: 'Email'}).getAttribute('aria-invalid')).toBe('true');
  });
});

describe('FormSubmissionView submission states', () => {
  it('guards a double submit, strips sys_* values, and safely renders confirmation text', async () => {
    let resolveSubmit!: () => void;
    const submitForm = vi.fn<SubmitForm>(() => new Promise<FormSubmissionResult>((resolve) => {
      resolveSubmit = () => resolve({rowId: 'row-1', submittedAt: '2026-08-12T00:00:00.000Z'});
    }));
    const {container} = render(
      <FormSubmissionView
        schema={schemaWith([
          makeField('text', {id: 'name', label: 'Name'}),
          makeField('text', {id: 'sys_secret', label: 'Reserved'}),
        ], {message: '<script>unsafe()</script>'})}
        pageId="page-1"
        client={submitClient(submitForm)}
      />,
    );
    fireEvent.change(screen.getByRole('textbox', {name: 'Name'}), {target: {value: 'Ada'}});
    fireEvent.change(screen.getByRole('textbox', {name: 'Reserved'}), {target: {value: 'must-not-leave'}});
    const button = screen.getByRole('button', {name: 'Submit'});
    fireEvent.click(button);
    fireEvent.click(button);

    expect(submitForm).toHaveBeenCalledTimes(1);
    expect(submitForm.mock.calls[0][2].values).toEqual({name: 'Ada'});
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.textContent).toBe('Submitting…');

    await act(async () => resolveSubmit());
    expect(await screen.findByText('<script>unsafe()</script>')).toBeTruthy();
    expect(container.querySelector('script')).toBeNull();
  });

  it.each([
    [404, 'unavailable', 'This form is unavailable.'],
    [413, 'too-large', 'This response is too large to submit.'],
  ] as const)('maps status %i to the %s terminal state', async (status, state, message) => {
    const submitForm = vi.fn<SubmitForm>().mockRejectedValue(new FormSubmissionError(status));
    const {container} = render(
      <FormSubmissionView schema={schemaWith([])} pageId="page-1" client={submitClient(submitForm)} />,
    );
    fireEvent.click(screen.getByRole('button', {name: 'Submit'}));
    expect(await screen.findByText(message)).toBeTruthy();
    expect(container.querySelector(`[data-form-state="${state}"]`)).toBeTruthy();
  });

  it('offers a toast retry after a network failure and reuses the per-render idempotency key', async () => {
    const submitForm = vi.fn<SubmitForm>()
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValueOnce({rowId: 'row-1', submittedAt: '2026-08-12T00:00:00.000Z'});
    render(<FormSubmissionView schema={schemaWith([])} pageId="page-1" client={submitClient(submitForm)} />);
    fireEvent.click(screen.getByRole('button', {name: 'Submit'}));

    await waitFor(() => expect(showToast).toHaveBeenCalledTimes(1));
    const firstKey = submitForm.mock.calls[0][2].idempotencyKey;
    const toast = vi.mocked(showToast).mock.calls[0][0];
    expect(toast.actionLabel).toBe('Retry');
    await act(async () => toast.onAction?.());
    await waitFor(() => expect(submitForm).toHaveBeenCalledTimes(2));
    expect(submitForm.mock.calls[1][2].idempotencyKey).toBe(firstKey);
    expect(await screen.findByText('Received')).toBeTruthy();
  });
});

describe('form submission safety helpers', () => {
  it('allows only effective HTTP(S) redirects', () => {
    expect(safeFormRedirect('https://example.test/thanks')).toBe('https://example.test/thanks');
    expect(safeFormRedirect('/thanks', 'https://example.test/form')).toBe('https://example.test/thanks');
    expect(safeFormRedirect('javascript:alert(1)', 'https://example.test/form')).toBeNull();
    expect(safeFormRedirect('data:text/html,boom', 'https://example.test/form')).toBeNull();
    expect(safeFormRedirect('mailto:hi@example.test', 'https://example.test/form')).toBeNull();
  });

  it('strips reserved ids and mints random idempotency keys', () => {
    expect(stripReservedFormValues({name: 'Ada', sys_owner: '<b>owner</b>', sys_hidden: true})).toEqual({name: 'Ada'});
    expect(mintFormIdempotencyKey()).not.toBe(mintFormIdempotencyKey());
  });
});
