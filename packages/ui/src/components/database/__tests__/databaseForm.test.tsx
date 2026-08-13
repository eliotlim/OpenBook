import {afterEach, describe, expect, it, vi} from 'vitest';
import {cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {
  removeProperty,
  type DatabaseProperty,
  type DatabaseSchema,
  type DatabaseView,
} from '@book.dev/sdk';
import {DatabaseForm, projectDatabaseFormFields, reorderFormFieldIds} from '../databaseForm';

const formSources = import.meta.glob('../databaseForm.tsx', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

vi.mock('@/providers', async () => {
  const {t} = await import('@/i18n');
  return {useTranslation: () => ({t})};
});

afterEach(cleanup);

const email: DatabaseProperty = {id: 'p-email', name: 'Email', type: 'email'};
const formView = {
  id: 'v-form',
  name: 'Contact form',
  type: 'form',
  filters: [],
  sorts: [],
  visiblePropertyIds: [email.id],
  formFields: {[email.id]: {required: true, help: 'We will reply here'}},
  formConfig: {acceptingResponses: true, confirmationMessage: 'Received.'},
} as DatabaseView;

const actions = () => ({
  onUpdateView: vi.fn().mockResolvedValue(undefined),
  onCreateProperty: vi.fn().mockResolvedValue('p-new'),
  onAddOption: vi.fn().mockResolvedValue(null),
  onSubmit: vi.fn().mockResolvedValue('row-1'),
});

describe('database form live projection', () => {
  it('reads renamed and retyped columns live without copied schema fields', () => {
    expect(projectDatabaseFormFields([email], formView)[0]).toMatchObject({
      label: 'Email',
      writable: true,
      property: {type: 'email'},
    });

    const changed: DatabaseProperty = {...email, name: 'Reply address', type: 'number'};
    expect(projectDatabaseFormFields([changed], formView)[0]).toMatchObject({
      label: 'Reply address',
      writable: true,
      property: {type: 'number'},
    });
  });

  it('drops a deleted column after the shared schema scrub', () => {
    const schema: DatabaseSchema = {properties: [email], views: [formView]};
    const next = removeProperty(schema, email.id);

    expect(next.views[0].visiblePropertyIds).toEqual([]);
    expect(next.views[0].formFields).toEqual({});
    expect(projectDatabaseFormFields(next.properties, next.views[0])).toEqual([]);
  });

  it('reorders only the explicit field-id list', () => {
    expect(reorderFormFieldIds(['one', 'two', 'three'], 'one', 'three')).toEqual(['two', 'three', 'one']);
  });
});

describe('database form fill renderer', () => {
  it('blocks invalid submissions with SDK validation', async () => {
    const props = actions();
    render(<DatabaseForm view={formView} properties={[email]} canEdit={false} {...props} />);

    const input = screen.getByRole('textbox', {name: 'email'});
    fireEvent.change(input, {target: {value: 'not-an-email'}});
    fireEvent.blur(input);
    fireEvent.click(screen.getByRole('button', {name: 'Submit'}));

    expect(await screen.findByText('Enter a valid email address.')).toBeTruthy();
    expect(props.onSubmit).not.toHaveBeenCalled();
  });

  it('creates one allowlisted row and enters confirmation state', async () => {
    const props = actions();
    render(<DatabaseForm view={formView} properties={[email]} canEdit={false} {...props} />);

    const input = screen.getByRole('textbox', {name: 'email'});
    fireEvent.change(input, {target: {value: 'reader@example.com'}});
    fireEvent.blur(input);
    fireEvent.click(screen.getByRole('button', {name: 'Submit'}));

    await waitFor(() => expect(props.onSubmit).toHaveBeenCalledWith({[email.id]: 'reader@example.com'}));
    expect(await screen.findByText('Received.')).toBeTruthy();
    expect(screen.queryByText('We will reply here')).toBeNull();
  });

  it('never imports or reads the database row projection', () => {
    const source = Object.values(formSources)[0];
    expect(source).not.toContain('visibleRows');
    expect(source).not.toContain('DatabaseRow');
  });
});
