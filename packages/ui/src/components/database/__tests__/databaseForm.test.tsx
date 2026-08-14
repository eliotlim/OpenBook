import {afterEach, describe, expect, it, vi} from 'vitest';
import {cleanup, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {
  removeProperty,
  safeFormRedirectUrl,
  TITLE_PROPERTY_ID,
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
  formConfig: {acceptingResponses: true, confirmation: {type: 'message', message: 'Received.'}},
} as DatabaseView;

const actions = () => ({
  onUpdateView: vi.fn().mockResolvedValue(undefined),
  onCreateProperty: vi.fn().mockResolvedValue('p-new'),
  onAddOption: vi.fn().mockResolvedValue(null),
  onSubmit: vi.fn().mockResolvedValue('row-1'),
});

const renderFill = (
  view: DatabaseView = formView,
  properties: DatabaseProperty[] = [email],
  props = actions(),
) => {
  const rendered = render(<DatabaseForm view={view} properties={properties} canEdit {...props} />);
  fireEvent.click(screen.getByRole('button', {name: 'Fill'}));
  return {props, rendered};
};
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
  it('shows and consumes the one-time deleted-column archive notice', async () => {
    const props = {
      ...actions(),
      removedFieldNotice: ['Email'],
      onConsumeRemovedFieldNotice: vi.fn(),
    };
    render(<DatabaseForm view={formView} properties={[email]} canEdit {...props} />);

    expect(screen.getByText(/Deleted database fields were removed from this form: Email/)).toBeTruthy();
    await waitFor(() => expect(props.onConsumeRemovedFieldNotice).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', {name: 'Close'}));
    expect(screen.queryByText(/Deleted database fields were removed/)).toBeNull();
  });

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

  it('reviews every public field, calls out choices, and requires the untitled acknowledgement', async () => {
    const select: DatabaseProperty = {
      id: 'p-select',
      name: 'Plan',
      type: 'select',
      options: [
        {id: 'free', label: 'Free', color: 'blue'},
        {id: 'pro', label: 'Pro', color: 'green'},
        {id: 'team', label: 'Team', color: 'purple'},
        {id: 'enterprise', label: 'Enterprise', color: 'gray'},
      ],
    };
    const multi: DatabaseProperty = {
      id: 'p-multi',
      name: 'Topics',
      type: 'multi_select',
      options: [{id: 'forms', label: 'Forms', color: 'blue'}],
    };
    const status: DatabaseProperty = {
      id: 'p-status',
      name: 'Stage',
      type: 'status',
      options: [{id: 'new', label: 'New', color: 'gray'}],
    };
    const checkbox: DatabaseProperty = {id: 'p-checkbox', name: 'Consent', type: 'checkbox'};
    const view = {
      ...formView,
      visiblePropertyIds: [email.id, select.id, multi.id, status.id, checkbox.id],
      formFields: {[email.id]: {required: true}, [select.id]: {}, [multi.id]: {}, [status.id]: {}, [checkbox.id]: {}},
    } as DatabaseView;
    const props = {
      ...actions(),
      getPublication: vi.fn().mockResolvedValue({published: false, responseCount: 2, maxResponses: 25}),
      onPublish: vi.fn().mockResolvedValue({
        url: '/?form=database-id&view=v-form#capability=one-time-secret',
      }),
      onRevoke: vi.fn().mockResolvedValue(true),
    };
    render(<DatabaseForm view={view} properties={[email, select, multi, status, checkbox]} canEdit {...props} />);

    const openReview = await screen.findByRole('button', {name: 'Publish form'});
    await waitFor(() => expect(openReview.hasAttribute('disabled')).toBe(false));
    expect(screen.getByText('2 of 25 responses')).toBeTruthy();
    fireEvent.click(openReview);
    const review = await screen.findByRole('dialog');
    for (const [id, label] of [[email.id, 'Email'], [select.id, 'Plan'], [multi.id, 'Topics'], [status.id, 'Stage'], [checkbox.id, 'Consent']]) {
      expect(review.querySelector(`[data-publish-review-field="${id}"]`)?.textContent).toContain(label);
    }
    expect(review.querySelector(`[data-publish-review-field="${email.id}"]`)?.textContent).toContain('Required');
    expect(review.querySelector(`[data-publish-review-field="${select.id}"]`)?.textContent).toContain('Free, Pro, Team, +1 more');
    expect(within(review).getAllByText('Public choice')).toHaveLength(4);
    expect(within(review).getByText(/Select, multi-select, status, and checkbox fields are publicly writable/)).toBeTruthy();
    const untitledAcknowledgement = within(review).getByRole('checkbox', {
      name: /Responses will be untitled/,
    });

    const confirm = within(review).getByRole('button', {name: 'Publish form'});
    expect(confirm.hasAttribute('disabled')).toBe(true);
    fireEvent.click(untitledAcknowledgement);
    expect(confirm.hasAttribute('disabled')).toBe(false);
    fireEvent.click(confirm);

    await waitFor(() => expect(props.onPublish).toHaveBeenCalledTimes(1));
    const link = await screen.findByRole('link', {name: /capability=one-time-secret/});
    expect(link.getAttribute('href')).toContain('#capability=one-time-secret');
    expect(screen.getByText('Copy your public fill URL now')).toBeTruthy();
    expect(screen.getByText(/only time the full link is shown/)).toBeTruthy();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {configurable: true, value: {writeText}});
    fireEvent.click(screen.getByRole('button', {name: 'Copy public fill URL'}));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(expect.stringContaining('#capability=one-time-secret')));
    expect(screen.getByRole('button', {name: 'Copied'})).toBeTruthy();
    fireEvent.click(screen.getByRole('button', {name: 'Done'}));
    expect(screen.queryByText(/capability=one-time-secret/)).toBeNull();
  });

  it('warns before replacing or revoking every distributed link', async () => {
    const props = {
      ...actions(),
      getPublication: vi.fn().mockResolvedValue({published: true, responseCount: 7, maxResponses: 100}),
      onPublish: vi.fn().mockResolvedValue({url: '/#capability=replacement-secret'}),
      onRevoke: vi.fn().mockResolvedValue(true),
    };
    const rendered = render(<DatabaseForm view={formView} properties={[email]} canEdit {...props} />);

    const rotate = await screen.findByRole('button', {name: 'Rotate link'});
    fireEvent.click(rotate);
    const review = await screen.findByRole('dialog');
    expect(within(review).getByText(/disables every copy of the existing link/)).toBeTruthy();
    expect(within(review).getByRole('button', {name: 'Replace public link'})).toBeTruthy();
    fireEvent.click(within(review).getByRole('button', {name: 'Cancel'}));

    fireEvent.click(screen.getByRole('button', {name: 'Revoke'}));
    const revokeDialog = await screen.findByRole('dialog');
    expect(within(revokeDialog).getByText(/Every distributed copy/)).toBeTruthy();
    expect(props.onRevoke).not.toHaveBeenCalled();
    fireEvent.click(within(revokeDialog).getByRole('button', {name: 'Revoke public form'}));
    await waitFor(() => expect(props.onRevoke).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('Not published')).toBeTruthy();
    rendered.unmount();
  });

  it('blocks empty-row publication and hides lifecycle controls without manage authority', async () => {
    const props = {
      ...actions(),
      getPublication: vi.fn().mockResolvedValue({published: false, responseCount: 0, maxResponses: 10_000}),
      onPublish: vi.fn().mockResolvedValue({url: '/#capability=unused'}),
      onRevoke: vi.fn().mockResolvedValue(true),
    };
    const emptyView = {...formView, visiblePropertyIds: [], formFields: {}} as DatabaseView;
    const rendered = render(<DatabaseForm view={emptyView} properties={[]} canEdit {...props} />);
    const publishButton = await screen.findByRole('button', {name: 'Publish form'});
    expect(publishButton.hasAttribute('disabled')).toBe(true);
    fireEvent.click(publishButton);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(props.onPublish).not.toHaveBeenCalled();
    rendered.unmount();

    render(<DatabaseForm view={formView} properties={[email]} canEdit canManagePublication={false} {...props} />);
    expect(screen.queryByText('Public form')).toBeNull();
  });

  it('resolves a one-time fill path against the app origin', async () => {
    const withTitle = {
      ...formView,
      visiblePropertyIds: [TITLE_PROPERTY_ID, email.id],
      formFields: {[TITLE_PROPERTY_ID]: {}, [email.id]: {}},
    } as DatabaseView;
    const props = {
      ...actions(),
      getPublication: vi.fn().mockResolvedValue({published: false, responseCount: 0, maxResponses: 10_000}),
      onPublish: vi.fn().mockResolvedValue({url: '/?form=db&view=v-form#capability=remote-secret'}),
      onRevoke: vi.fn().mockResolvedValue(true),
    };
    render(<DatabaseForm view={withTitle} properties={[email]} canEdit {...props} />);
    const publishButton = await screen.findByRole('button', {name: 'Publish form'});
    fireEvent.click(publishButton);
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', {name: 'Publish form'}));

    const link = await screen.findByRole('link', {name: /remote-secret/});
    expect(link.getAttribute('href')).toBe(
      new URL('/?form=db&view=v-form#capability=remote-secret', window.location.href).toString(),
    );
  });

  it('rejects unsafe patterns while authoring and blocks a hand-authored unsafe pattern at review', async () => {
    const note: DatabaseProperty = {id: 'p-note', name: 'Note', type: 'text'};
    const props = {
      ...actions(),
      getPublication: vi.fn().mockResolvedValue({published: false, responseCount: 0, maxResponses: 10_000}),
      onPublish: vi.fn().mockResolvedValue({url: '/#capability=should-not-exist'}),
      onRevoke: vi.fn().mockResolvedValue(true),
    };
    const safeView = {
      ...formView,
      visiblePropertyIds: [TITLE_PROPERTY_ID, note.id],
      formFields: {[TITLE_PROPERTY_ID]: {}, [note.id]: {}},
    } as DatabaseView;
    const renderResult = render(<DatabaseForm view={safeView} properties={[note]} canEdit {...props} />);
    await screen.findByText('Not published');
    const patternInputs = screen.getAllByLabelText('Pattern');
    const pattern = patternInputs[patternInputs.length - 1];
    fireEvent.change(pattern, {target: {value: '(a+)+$'}});
    fireEvent.blur(pattern);
    expect(screen.getByText('Enter a valid, safe regular expression.')).toBeTruthy();
    expect(props.onUpdateView).not.toHaveBeenCalled();

    renderResult.unmount();
    const unsafeView = {
      ...safeView,
      formFields: {[TITLE_PROPERTY_ID]: {}, [note.id]: {validation: {pattern: '(a+)+$'}}},
    } as DatabaseView;
    render(<DatabaseForm view={unsafeView} properties={[note]} canEdit {...props} />);
    const openReview = await screen.findByRole('button', {name: 'Publish form'});
    await waitFor(() => expect(openReview.hasAttribute('disabled')).toBe(false));
    fireEvent.click(openReview);
    const review = await screen.findByRole('dialog');
    expect(within(review).getByText('Fix every invalid or unsafe validation pattern before publishing.')).toBeTruthy();
    expect(within(review).getByRole('button', {name: 'Publish form'}).hasAttribute('disabled')).toBe(true);
    expect(props.onPublish).not.toHaveBeenCalled();
  });

  it('explains failed new-field creation when the target is no longer a form', async () => {
    const props = {...actions(), onCreateProperty: vi.fn().mockResolvedValue(undefined)};
    render(<DatabaseForm view={formView} properties={[email]} canEdit {...props} />);

    fireEvent.pointerDown(screen.getByRole('button', {name: 'Add field'}), {button: 0, ctrlKey: false});
    fireEvent.click(await screen.findByRole('menuitem', {name: 'New field'}));
    expect(screen.getByText('Creates a new column in this database and adds it to this form.')).toBeTruthy();
    const nameInput = screen.getByLabelText('Field name');
    expect(nameInput.className).toContain('shadow-[var(--ring-field)]');
    fireEvent.change(nameInput, {target: {value: 'Follow-up'}});
    fireEvent.click(screen.getByRole('button', {name: 'Create field'}));

    expect((await screen.findByRole('alert')).textContent).toBe('This field could not be added because this view is no longer a form.');
  });

  it('states remove semantics once and uses the amber note idiom for unsupported columns', () => {
    const computed: DatabaseProperty = {id: 'p-formula', name: 'Computed', type: 'formula'};
    const view = {...formView, visiblePropertyIds: [computed.id], formFields: {[computed.id]: {}}} as DatabaseView;
    render(<DatabaseForm view={view} properties={[computed]} canEdit {...actions()} />);

    expect(screen.getByText(/Removing a field from the form keeps its database column and existing values/)).toBeTruthy();
    expect(screen.queryByText('The database column and its existing values are kept.')).toBeNull();
    expect(screen.getByRole('button', {name: 'Remove from form: Computed'}).getAttribute('title'))
      .toBe('The database column and its existing values are kept.');
    const note = screen.getByRole('note');
    expect(note.className).toContain('border-amber-500/40');
    expect(note.className).toContain('text-foreground');
  });
});

describe('database form fill renderer', () => {
  it('shows read-only members a friendly access state instead of a submit control', () => {
    const {container} = render(<DatabaseForm view={formView} properties={[email]} canEdit={false} {...actions()} />);

    expect(screen.getByText('You don\'t have access to submit this form.')).toBeTruthy();
    expect(container.querySelector('[data-database-form-readonly]')?.getAttribute('role')).toBe('note');
    expect(container.querySelector('[data-database-form-fill]')).toBeNull();
    expect(screen.queryByRole('button', {name: 'Submit'})).toBeNull();
  });

  it('omits aria-describedby when no help or error is rendered', () => {
    const view = {
      ...formView,
      formFields: {[email.id]: {required: true}},
    } as DatabaseView;
    renderFill(view);

    expect(screen.getByRole('textbox', {name: 'Email (required)'}).hasAttribute('aria-describedby')).toBe(false);
  });

  it('blocks invalid submissions with SDK validation', async () => {
    const {props} = renderFill();

    const input = screen.getByRole('textbox', {name: 'Email (required)'});
    expect(input.getAttribute('aria-required')).toBe('true');
    expect(input.getAttribute('aria-describedby')).toBe(`${email.id}-help`);
    fireEvent.change(input, {target: {value: 'not-an-email'}});
    fireEvent.blur(input);
    fireEvent.click(screen.getByRole('button', {name: 'Submit'}));

    expect(await screen.findByText('Enter a valid email address.')).toBeTruthy();
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-describedby')).toBe(`${email.id}-help ${email.id}-error`);
    expect(document.getElementById(`${email.id}-help`)?.textContent).toBe('We will reply here');
    expect(document.getElementById(`${email.id}-error`)?.textContent).toBe('Enter a valid email address.');
    expect(props.onSubmit).not.toHaveBeenCalled();
  });

  it('creates one allowlisted row and enters confirmation state', async () => {
    const {props} = renderFill();

    const input = screen.getByRole('textbox', {name: 'Email (required)'});
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
    const {rendered: {container}} = renderFill(view, [note], props);

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
    const {rendered: closedRender} = renderFill(closed);
    expect(screen.getByText('Responses reopen Monday.')).toBeTruthy();
    closedRender.unmount();

    const {rendered: defaultClosedRender} = renderFill(
      {...closed, formConfig: {acceptingResponses: false}} as DatabaseView,
    );
    expect(screen.getByText('This form is not accepting responses.')).toBeTruthy();
    defaultClosedRender.unmount();

    const redirect = {
      ...formView,
      formConfig: {acceptingResponses: true, confirmation: {type: 'redirect', redirectUrl: 'https://example.com/thanks'}},
    } as DatabaseView;
    renderFill(redirect);
    const input = screen.getByRole('textbox', {name: 'Email (required)'});
    fireEvent.change(input, {target: {value: 'reader@example.com'}});
    fireEvent.blur(input);
    fireEvent.click(screen.getByRole('button', {name: 'Submit'}));

    const link = await screen.findByRole('link', {name: 'Continue'});
    expect(link.getAttribute('href')).toBe('https://example.com/thanks');
    expect(safeFormRedirectUrl('javascript:alert(1)')).toBeNull();
    expect(safeFormRedirectUrl('/thanks')).toBe('/thanks');
  });

  it('remounts uncontrolled fields when starting another response', async () => {
    renderFill();
    const first = screen.getByRole('textbox', {name: 'Email (required)'}) as HTMLInputElement;
    fireEvent.change(first, {target: {value: 'reader@example.com'}});
    fireEvent.blur(first);
    fireEvent.click(screen.getByRole('button', {name: 'Submit'}));
    fireEvent.click(await screen.findByRole('button', {name: 'Submit another response'}));

    const restarted = screen.getByRole('textbox', {name: 'Email (required)'}) as HTMLInputElement;
    expect(restarted).not.toBe(first);
    expect(restarted.value).toBe('');
  });

  it('excludes mapped non-writable fields from fill mode', () => {
    const computed: DatabaseProperty = {id: 'p-formula', name: 'Computed', type: 'formula'};
    const view = {
      ...formView,
      visiblePropertyIds: [email.id, computed.id],
      formFields: {...formView.formFields, [computed.id]: {required: true}},
    } as DatabaseView;
    const {rendered: {container}} = renderFill(view, [email, computed]);

    expect(container.querySelector(`[data-form-input="${email.id}"]`)).toBeTruthy();
    expect(container.querySelector(`[data-form-input="${computed.id}"]`)).toBeNull();
  });
  it('never imports or reads the database row projection', () => {
    const source = Object.values(formSources)[0];
    expect(source).not.toContain('visibleRows');
    expect(source).not.toContain('DatabaseRow');
  });
});
