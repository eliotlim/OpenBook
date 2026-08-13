import {afterEach, describe, expect, it, vi} from 'vitest';
import {cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {
  removeProperty,
  TITLE_PROPERTY_ID,
  type DatabaseProperty,
  type DatabaseSchema,
  type DatabaseView,
} from '@book.dev/sdk';
import {DatabaseForm, projectDatabaseFormFields, reorderFormFieldIds, safeFormRedirectUrl} from '../databaseForm';

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
  formConfig: {acceptingResponses: true, confirmation: {type: 'message', message: 'Received.'}},
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

  it('projects the explicitly mapped virtual title as an ordinary text field', () => {
    const withTitle = {
      ...formView,
      visiblePropertyIds: [TITLE_PROPERTY_ID, email.id],
      formFields: {[TITLE_PROPERTY_ID]: {label: 'Your name'}, ...formView.formFields},
    } as DatabaseView;

    expect(projectDatabaseFormFields([email], withTitle)).toEqual([
      expect.objectContaining({label: 'Your name', writable: true, property: {id: TITLE_PROPERTY_ID, name: 'Title', type: 'text'}}),
      expect.objectContaining({property: email}),
    ]);
  });
});

describe('database form builder', () => {
  it('offers the virtual title explicitly without adding it by default', async () => {
    const props = actions();
    render(<DatabaseForm view={formView} properties={[email]} canEdit {...props} />);

    fireEvent.pointerDown(screen.getByRole('button', {name: 'Add field'}), {button: 0, ctrlKey: false});
    fireEvent.click(await screen.findByRole('menuitem', {name: /Row title/}));

    await waitFor(() => expect(props.onUpdateView).toHaveBeenCalledWith({
      visiblePropertyIds: [email.id, TITLE_PROPERTY_ID],
      formFields: {[email.id]: formView.formFields?.[email.id], [TITLE_PROPERTY_ID]: {}},
    }));
  });

  it('edits multiline, validation, confirmation, closed, and response-cap settings', () => {
    const note: DatabaseProperty = {id: 'p-note', name: 'Note', type: 'text'};
    const view = {
      ...formView,
      visiblePropertyIds: [note.id],
      formFields: {[note.id]: {}},
    } as DatabaseView;
    const props = actions();
    render(<DatabaseForm view={view} properties={[note]} canEdit {...props} />);

    fireEvent.click(screen.getByRole('switch', {name: 'Multi-line response: Note'}));
    expect(props.onUpdateView).toHaveBeenCalledWith({formFields: {[note.id]: {multiline: true}}});

    const minimumLength = screen.getByLabelText('Minimum length');
    fireEvent.change(minimumLength, {target: {value: '5'}});
    fireEvent.blur(minimumLength);
    expect(props.onUpdateView).toHaveBeenCalledWith({formFields: {[note.id]: {validation: {minLength: 5}}}});

    fireEvent.click(screen.getByLabelText('After submission'));
    fireEvent.click(screen.getByRole('option', {name: 'Open a link'}));
    expect(props.onUpdateView).toHaveBeenCalledWith({
      formConfig: {acceptingResponses: true, confirmation: {type: 'redirect', redirectUrl: ''}},
    });

    const closedMessage = screen.getByLabelText('Closed-form message');
    fireEvent.change(closedMessage, {target: {value: 'Back soon.'}});
    fireEvent.blur(closedMessage);
    expect(props.onUpdateView).toHaveBeenCalledWith({
      formConfig: {
        acceptingResponses: true,
        confirmation: {type: 'message', message: 'Received.'},
        closedMessage: 'Back soon.',
      },
    });

    const maxResponses = screen.getByLabelText('Maximum responses');
    expect(maxResponses.getAttribute('placeholder')).toBe('10,000');
    fireEvent.change(maxResponses, {target: {value: '250'}});
    fireEvent.blur(maxResponses);
    expect(props.onUpdateView).toHaveBeenCalledWith({
      formConfig: {
        acceptingResponses: true,
        confirmation: {type: 'message', message: 'Received.'},
        maxResponses: 250,
      },
    });
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

    await waitFor(() => expect(props.onSubmit).toHaveBeenCalledWith({[email.id]: 'reader@example.com'}, undefined));
    expect(await screen.findByText('Received.')).toBeTruthy();
    expect(screen.queryByText('We will reply here')).toBeNull();
  });

  it('submits a mapped title as the row name and enforces multiline validation', async () => {
    const note: DatabaseProperty = {id: 'p-note', name: 'Note', type: 'text'};
    const view = {
      ...formView,
      visiblePropertyIds: [TITLE_PROPERTY_ID, note.id],
      formFields: {
        [TITLE_PROPERTY_ID]: {required: true},
        [note.id]: {multiline: true, validation: {minLength: 5}},
      },
    } as DatabaseView;
    const props = actions();
    const {container} = render(<DatabaseForm view={view} properties={[note]} canEdit={false} {...props} />);

    const title = container.querySelector<HTMLInputElement>('[data-form-input="title"] input')!;
    fireEvent.change(title, {target: {value: 'Ada'}});
    fireEvent.blur(title);
    const noteInput = screen.getByRole('textbox', {name: 'Note'});
    expect(noteInput.tagName).toBe('TEXTAREA');
    fireEvent.change(noteInput, {target: {value: 'tiny'}});
    fireEvent.blur(noteInput);
    fireEvent.click(screen.getByRole('button', {name: 'Submit'}));

    expect(await screen.findByText('Enter a longer response.')).toBeTruthy();
    expect(props.onSubmit).not.toHaveBeenCalled();

    fireEvent.change(noteInput, {target: {value: 'long enough'}});
    fireEvent.blur(noteInput);
    fireEvent.click(screen.getByRole('button', {name: 'Submit'}));
    await waitFor(() => expect(props.onSubmit).toHaveBeenCalledWith({[note.id]: 'long enough'}, 'Ada'));
  });

  it('renders custom closed copy and a protocol-checked redirect confirmation', async () => {
    const closed = {
      ...formView,
      formConfig: {acceptingResponses: false, closedMessage: 'Responses reopen Monday.'},
    } as DatabaseView;
    const closedRender = render(<DatabaseForm view={closed} properties={[email]} canEdit={false} {...actions()} />);
    expect(screen.getByText('Responses reopen Monday.')).toBeTruthy();
    closedRender.unmount();

    const redirect = {
      ...formView,
      formConfig: {acceptingResponses: true, confirmation: {type: 'redirect', redirectUrl: 'https://example.com/thanks'}},
    } as DatabaseView;
    const props = actions();
    render(<DatabaseForm view={redirect} properties={[email]} canEdit={false} {...props} />);
    const input = screen.getByRole('textbox', {name: 'email'});
    fireEvent.change(input, {target: {value: 'reader@example.com'}});
    fireEvent.blur(input);
    fireEvent.click(screen.getByRole('button', {name: 'Submit'}));

    const link = await screen.findByRole('link', {name: 'Continue'});
    expect(link.getAttribute('href')).toBe('https://example.com/thanks');
    expect(safeFormRedirectUrl('javascript:alert(1)')).toBeNull();
    expect(safeFormRedirectUrl('/thanks')).toBe('/thanks');
  });

  it('never imports or reads the database row projection', () => {
    const source = Object.values(formSources)[0];
    expect(source).not.toContain('visibleRows');
    expect(source).not.toContain('DatabaseRow');
  });
});
