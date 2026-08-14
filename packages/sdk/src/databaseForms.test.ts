import {describe, expect, it} from 'vitest';
import {
  FORM_PROPERTY_TYPE_WRITABILITY,
  FORM_ROW_VALIDATION_ERROR_CODES,
  KNOWN_DATABASE_VIEW_TYPES,
  TITLE_PROPERTY_ID,
  defaultView,
  isDatabaseViewType,
  isFormWritablePropertyType,
  projectDatabaseFormDescriptor,
  removeProperty,
  validateRowAgainstForm,
  type DatabaseProperty,
  type DatabasePropertyType,
  type DatabaseSchema,
  type DatabaseView,
} from './database';

const formView = (overrides: Partial<DatabaseView> = {}): DatabaseView => ({
  id: 'view_form',
  name: 'Intake',
  type: 'form',
  filters: [],
  sorts: [],
  visiblePropertyIds: [],
  ...overrides,
});

const schemaWith = (properties: DatabaseProperty[], view = formView()): DatabaseSchema => ({
  properties,
  views: [view],
});

describe('database form view contract', () => {
  it('keeps the runtime view guard aligned with the view-type union', () => {
    expect(KNOWN_DATABASE_VIEW_TYPES).toContain('form');
    expect(isDatabaseViewType('form')).toBe(true);
    expect(isDatabaseViewType('from-a-newer-client')).toBe(false);
    expect(isDatabaseViewType(null)).toBe(false);
  });

  it('enumerates every property type and fails closed for managed/reference types', () => {
    const exhaustive: Record<DatabasePropertyType, boolean> = FORM_PROPERTY_TYPE_WRITABILITY;
    expect(exhaustive).toEqual({
      text: true,
      number: true,
      rating: true,
      select: true,
      multi_select: true,
      status: true,
      checkbox: true,
      date: true,
      url: true,
      email: true,
      phone: true,
      location: true,
      files: true,
      relation: false,
      dependency: false,
      rollup: false,
      created_time: false,
      last_edited_time: false,
      unique_id: false,
      expr: false,
      formula: false,
      person: false,
      verification: false,
      backlinks: false,
    });
    expect(isFormWritablePropertyType('status')).toBe(true);
    expect(isFormWritablePropertyType('formula')).toBe(false);
  });

  it('fails closed for inherited and unknown runtime property types', () => {
    const hostileTypes = ['__proto__', 'constructor', 'unknown'];
    const hostileProperties = hostileTypes.map((type) => ({id: type, name: type, type})) as unknown as DatabaseProperty[];
    for (const type of hostileTypes) expect(isFormWritablePropertyType(type as DatabasePropertyType)).toBe(false);

    expect(defaultView('form', 'Hostile', hostileProperties).visiblePropertyIds).toEqual([TITLE_PROPERTY_ID]);

    const view = formView({visiblePropertyIds: hostileTypes});
    expect(validateRowAgainstForm(
      schemaWith(hostileProperties, view),
      view,
      Object.fromEntries(hostileTypes.map((type) => [type, 'blocked'])),
    )).toEqual({
      ok: false,
      errors: hostileTypes.map((propertyId) => ({propertyId, code: 'unknown_field'})),
    });
  });

  it('creates a form with an explicit writable field mapping', () => {
    const properties: DatabaseProperty[] = [
      {id: 'name', name: 'Name', type: 'text'},
      {id: 'total', name: 'Total', type: 'formula'},
      {id: 'owner', name: 'Owner', type: 'person'},
      {id: 'sys_internal', name: 'Internal', type: 'text'},
      {id: 'email', name: 'Email', type: 'email'},
    ];
    const view = defaultView('form', 'Intake', properties);
    expect(view.visiblePropertyIds).toEqual([TITLE_PROPERTY_ID, 'name', 'email']);
    expect(view.formFields).toEqual({});
    expect(view.formConfig).toEqual({acceptingResponses: true});
  });

  it('projects a frozen public descriptor without leaking unmapped columns or options', () => {
    const privateOptions = [{id: 'classified', label: 'Classified', color: 'red'}];
    const publicOptions = [{id: 'general', label: 'General', color: 'blue'}];
    const view = formView({
      visiblePropertyIds: [TITLE_PROPERTY_ID, 'category', 'when', 'score'],
      formFields: {
        [TITLE_PROPERTY_ID]: {
          label: 'Your name',
          required: true,
          multiline: true,
          validation: {minLength: 2, maxLength: 80, pattern: '^[A-Z]'},
        },
        category: {help: 'Choose one', placeholder: 'Pick', validation: {minLength: 1}},
        score: {validation: {min: 0, max: 100}},
      },
      formConfig: {
        title: 'Public intake',
        description: 'Tell us about it',
        submitLabel: 'Send',
        confirmation: {type: 'message', message: 'Received'},
        acceptingResponses: false,
        closedMessage: 'Back soon',
        maxResponses: 25,
      },
    });
    const schema = schemaWith([
      {id: 'category', name: 'Category', type: 'select', options: publicOptions, description: 'internal column copy'},
      {id: 'when', name: 'When', type: 'date', includeTime: true, dateRange: false, dateDisplay: 'relative'},
      {id: 'score', name: 'Score', type: 'number', numberTarget: 100, numberFormat: 'percent'},
      {id: 'private', name: 'Private', type: 'select', options: privateOptions},
      {id: 'formula', name: 'Formula', type: 'formula', formula: 'prop("Private")'},
    ], view);

    const descriptor = projectDatabaseFormDescriptor(schema, view);
    expect(descriptor).toEqual({
      title: 'Public intake',
      description: 'Tell us about it',
      submitLabel: 'Send',
      acceptingResponses: false,
      closedMessage: 'Back soon',
      fields: [
        {
          propertyId: TITLE_PROPERTY_ID,
          type: 'text',
          label: 'Your name',
          help: '',
          required: true,
          placeholder: '',
          multiline: true,
          validation: {minLength: 2, maxLength: 80},
        },
        {
          propertyId: 'category',
          type: 'select',
          label: 'Category',
          help: 'Choose one',
          required: false,
          placeholder: 'Pick',
          validation: {minLength: 1},
          options: publicOptions,
        },
        {
          propertyId: 'when',
          type: 'date',
          label: 'When',
          help: '',
          required: false,
          placeholder: '',
          includeTime: true,
          dateRange: false,
        },
        {
          propertyId: 'score',
          type: 'number',
          label: 'Score',
          help: '',
          required: false,
          placeholder: '',
          validation: {min: 0, max: 100},
          numberTarget: 100,
        },
      ],
    });
    expect(JSON.stringify(descriptor)).not.toContain('Classified');
    expect(JSON.stringify(descriptor)).not.toContain('internal column copy');
    expect(JSON.stringify(descriptor)).not.toContain('^[A-Z]');
    expect(JSON.stringify(descriptor)).not.toContain('pattern');
    expect(descriptor?.fields[1].options).not.toBe(publicOptions);
    expect(projectDatabaseFormDescriptor(schema, {...view, type: 'table'})).toBeNull();
  });

  it('omits closed copy while a form is accepting responses', () => {
    const view = formView({formConfig: {acceptingResponses: true, closedMessage: 'Not public while open'}});
    expect(projectDatabaseFormDescriptor(schemaWith([], view), view)).toEqual({
      title: 'Intake',
      description: '',
      submitLabel: 'Submit',
      acceptingResponses: true,
      fields: [],
    });
  });
});

describe('validateRowAgainstForm', () => {
  const properties: DatabaseProperty[] = [
    {id: 'text', name: 'Text', type: 'text'},
    {id: 'number', name: 'Number', type: 'number'},
    {id: 'rating', name: 'Rating', type: 'rating', numberTarget: 7},
    {id: 'select', name: 'Select', type: 'select', options: [{id: 'one', label: 'One'}]},
    {id: 'multi', name: 'Multi', type: 'multi_select', options: [{id: 'one', label: 'One'}, {id: 'two', label: 'Two'}]},
    {id: 'status', name: 'Status', type: 'status', options: [{id: 'open', label: 'Open'}]},
    {id: 'checked', name: 'Checked', type: 'checkbox'},
    {id: 'date', name: 'Date', type: 'date'},
    {id: 'url', name: 'URL', type: 'url'},
    {id: 'email', name: 'Email', type: 'email'},
    {id: 'phone', name: 'Phone', type: 'phone'},
    {id: 'location', name: 'Location', type: 'location'},
    {id: 'files', name: 'Files', type: 'files'},
  ];
  const view = formView({visiblePropertyIds: properties.map((property) => property.id)});
  const schema = schemaWith(properties, view);

  it('accepts values for every v1-writable type and returns a defensive projection', () => {
    const fields = {
      text: 'Ada',
      number: 42.5,
      rating: 7,
      select: 'one',
      multi: ['one', 'two'],
      status: 'open',
      checked: false,
      date: '2026-08-13',
      url: 'https://book.dev/forms',
      email: 'ada@example.com',
      phone: '+65 6123 4567',
      location: {lat: 1.3521, lng: 103.8198, label: 'Singapore'},
      files: ['asset:staged-file'],
    };
    const result = validateRowAgainstForm(schema, view, fields);
    expect(result).toEqual({ok: true, fields});
    if (!result.ok) throw new Error('expected valid form row');
    expect(result.fields).not.toBe(fields);
    expect(result.fields.multi).not.toBe(fields.multi);
    expect(result.fields.location).not.toBe(fields.location);
  });

  it('uses only explicit visible ids and rejects deleted, hidden, computed, and system fields', () => {
    const restrictedProperties: DatabaseProperty[] = [
      {id: 'allowed', name: 'Allowed', type: 'text'},
      {id: 'hidden', name: 'Hidden', type: 'text'},
      {id: 'computed', name: 'Computed', type: 'formula'},
      {id: 'sys_internal', name: 'Internal', type: 'text'},
    ];
    const restrictedView = formView({
      visiblePropertyIds: ['allowed', 'computed', 'sys_internal', 'deleted'],
      formFields: {allowed: {required: true}, hidden: {required: true}},
    });
    const result = validateRowAgainstForm(
      schemaWith(restrictedProperties, restrictedView),
      restrictedView,
      {allowed: 'yes', hidden: 'no', computed: 2, sys_internal: 'no', deleted: 'no'},
    );
    expect(result).toEqual({
      ok: false,
      errors: [
        {propertyId: 'hidden', code: 'unknown_field'},
        {propertyId: 'computed', code: 'unknown_field'},
        {propertyId: 'sys_internal', code: 'unknown_field'},
        {propertyId: 'deleted', code: 'unknown_field'},
      ],
    });
  });

  it('enforces required fields without treating false or zero as empty', () => {
    const requiredProperties: DatabaseProperty[] = [
      {id: 'name', name: 'Name', type: 'text'},
      {id: 'count', name: 'Count', type: 'number'},
      {id: 'consent', name: 'Consent', type: 'checkbox'},
    ];
    const requiredView = formView({
      visiblePropertyIds: ['name', 'count', 'consent'],
      formFields: {name: {required: true}, count: {required: true}, consent: {required: true}},
    });
    const requiredSchema = schemaWith(requiredProperties, requiredView);
    expect(validateRowAgainstForm(requiredSchema, requiredView, {name: ' ', count: 0, consent: false})).toEqual({
      ok: false,
      errors: [{propertyId: 'name', code: 'required'}],
    });
  });

  it('maps the reserved title as text and returns it separately as the row name', () => {
    const titleView = formView({
      visiblePropertyIds: [TITLE_PROPERTY_ID, 'notes'],
      formFields: {[TITLE_PROPERTY_ID]: {required: true}},
    });
    const titleSchema = schemaWith([{id: 'notes', name: 'Notes', type: 'text'}], titleView);

    expect(validateRowAgainstForm(titleSchema, titleView, {[TITLE_PROPERTY_ID]: '', notes: 'Hello'})).toEqual({
      ok: false,
      errors: [{propertyId: TITLE_PROPERTY_ID, code: 'required'}],
    });
    expect(validateRowAgainstForm(titleSchema, titleView, {[TITLE_PROPERTY_ID]: 42})).toEqual({
      ok: false,
      errors: [{propertyId: TITLE_PROPERTY_ID, code: 'type'}],
    });
    expect(validateRowAgainstForm(titleSchema, titleView, {[TITLE_PROPERTY_ID]: 'Ada', notes: 'Hello'})).toEqual({
      ok: true,
      name: 'Ada',
      fields: {notes: 'Hello'},
    });

    const optionalTitleView = {...titleView, formFields: {}};
    expect(validateRowAgainstForm(titleSchema, optionalTitleView, {})).toEqual({ok: true, name: '', fields: {}});
    expect(validateRowAgainstForm(titleSchema, formView({visiblePropertyIds: ['notes']}), {[TITLE_PROPERTY_ID]: 'Ada'})).toEqual({
      ok: false,
      errors: [{propertyId: TITLE_PROPERTY_ID, code: 'unknown_field'}],
    });
  });

  it('treats a blank string as empty for every property type before type validation', () => {
    const blankProperties: DatabaseProperty[] = [
      {id: 'count', name: 'Count', type: 'number'},
      {id: 'consent', name: 'Consent', type: 'checkbox'},
      {id: 'place', name: 'Place', type: 'location'},
    ];
    const blankView = formView({
      visiblePropertyIds: blankProperties.map((property) => property.id),
      formFields: {
        count: {required: true},
        consent: {required: true},
        place: {required: true},
      },
    });
    expect(validateRowAgainstForm(schemaWith(blankProperties, blankView), blankView, {
      count: '',
      consent: '',
      place: '',
    })).toEqual({
      ok: false,
      errors: [
        {propertyId: 'count', code: 'required'},
        {propertyId: 'consent', code: 'required'},
        {propertyId: 'place', code: 'required'},
      ],
    });
  });

  it('enforces multiline field validation metadata server-side', () => {
    const constrainedProperties: DatabaseProperty[] = [
      {id: 'bio', name: 'Bio', type: 'text'},
      {id: 'age', name: 'Age', type: 'number'},
    ];
    const constrainedView = formView({
      visiblePropertyIds: ['bio', 'age'],
      formFields: {
        bio: {
          multiline: true,
          validation: {minLength: 4, maxLength: 12, pattern: '^[A-Z]'},
        },
        age: {validation: {min: 18, max: 120}},
      },
    });
    const constrainedSchema = schemaWith(constrainedProperties, constrainedView);

    expect(validateRowAgainstForm(constrainedSchema, constrainedView, {bio: 'ada', age: 121})).toEqual({
      ok: false,
      errors: [
        {propertyId: 'bio', code: 'minLength'},
        {propertyId: 'bio', code: 'pattern'},
        {propertyId: 'age', code: 'max'},
      ],
    });
    expect(validateRowAgainstForm(constrainedSchema, constrainedView, {bio: 'Ada Lovelace', age: 36})).toEqual({
      ok: true,
      fields: {bio: 'Ada Lovelace', age: 36},
    });
  });

  it('exports the step-3 size-limit validation code', () => {
    expect(FORM_ROW_VALIDATION_ERROR_CODES).toContain('too_large');
  });

  it('validates against the current property type after a retype', () => {
    const numberProperty: DatabaseProperty = {id: 'answer', name: 'Answer', type: 'number'};
    const currentView = formView({visiblePropertyIds: ['answer']});
    expect(validateRowAgainstForm(schemaWith([numberProperty], currentView), currentView, {answer: 7})).toEqual({
      ok: true,
      fields: {answer: 7},
    });

    const retyped: DatabaseProperty = {...numberProperty, type: 'text'};
    expect(validateRowAgainstForm(schemaWith([retyped], currentView), currentView, {answer: 7})).toEqual({
      ok: false,
      errors: [{propertyId: 'answer', code: 'type'}],
    });
    expect(validateRowAgainstForm(schemaWith([retyped], currentView), currentView, {answer: 'seven'})).toEqual({
      ok: true,
      fields: {answer: 'seven'},
    });

    const textProperty: DatabaseProperty = {id: 'choice', name: 'Choice', type: 'text'};
    const choiceView = formView({visiblePropertyIds: ['choice']});
    expect(validateRowAgainstForm(schemaWith([textProperty], choiceView), choiceView, {choice: 'stale'})).toEqual({
      ok: true,
      fields: {choice: 'stale'},
    });

    const selectProperty: DatabaseProperty = {
      ...textProperty,
      type: 'select',
      options: [{id: 'current', label: 'Current'}],
    };
    expect(validateRowAgainstForm(schemaWith([selectProperty], choiceView), choiceView, {choice: 'stale'})).toEqual({
      ok: false,
      errors: [{propertyId: 'choice', code: 'option'}],
    });
  });

  it('orders timed date ranges by instant across mixed timezone offsets', () => {
    const property: DatabaseProperty = {
      id: 'window',
      name: 'Window',
      type: 'date',
      dateRange: true,
      includeTime: true,
    };
    const currentView = formView({visiblePropertyIds: [property.id]});
    const currentSchema = schemaWith([property], currentView);

    // Lexically the end is earlier, but its -10:00 offset makes it almost a day
    // later than the +14:00 start.
    expect(validateRowAgainstForm(currentSchema, currentView, {
      window: {
        start: '2026-08-13T10:00:00+14:00',
        end: '2026-08-13T09:30:00-10:00',
      },
    })).toEqual({
      ok: true,
      fields: {
        window: {
          start: '2026-08-13T10:00:00+14:00',
          end: '2026-08-13T09:30:00-10:00',
        },
      },
    });

    // The inverse is lexically increasing but chronologically decreasing.
    expect(validateRowAgainstForm(currentSchema, currentView, {
      window: {
        start: '2026-08-13T09:30:00-10:00',
        end: '2026-08-13T10:00:00+14:00',
      },
    })).toEqual({
      ok: false,
      errors: [{propertyId: 'window', code: 'range'}],
    });
  });

  it('rejects malformed options, formats, ranges, and non-form views', () => {
    const invalid = validateRowAgainstForm(schema, view, {
      rating: 8,
      select: 'missing',
      multi: ['one', 'one'],
      date: '2026-02-30',
      url: 'javascript:alert(1)',
      email: 'not-an-email',
      phone: '12',
      location: {lat: 91, lng: 0},
      files: [''],
    });
    expect(invalid).toEqual({
      ok: false,
      errors: [
        {propertyId: 'rating', code: 'range'},
        {propertyId: 'select', code: 'option'},
        {propertyId: 'multi', code: 'option'},
        {propertyId: 'date', code: 'date_format'},
        {propertyId: 'url', code: 'url_format'},
        {propertyId: 'email', code: 'email_format'},
        {propertyId: 'phone', code: 'phone_format'},
        {propertyId: 'location', code: 'range'},
        {propertyId: 'files', code: 'type'},
      ],
    });
    expect(validateRowAgainstForm(schema, {...view, type: 'table'}, {})).toEqual({
      ok: false,
      errors: [{propertyId: '', code: 'view_type'}],
    });
  });
});

describe('removeProperty form cleanup', () => {
  it('removes the field mapping and metadata from every form view', () => {
    const view = formView({
      visiblePropertyIds: ['keep', 'remove'],
      formFields: {
        keep: {label: 'Keep'},
        remove: {label: 'Remove', required: true, help: 'Gone with the column'},
      },
    });
    const schema = schemaWith([
      {id: 'keep', name: 'Keep', type: 'text'},
      {id: 'remove', name: 'Remove', type: 'number'},
    ], view);
    const next = removeProperty(schema, 'remove');
    expect(next.views[0].visiblePropertyIds).toEqual(['keep']);
    expect(next.views[0].formFields).toEqual({keep: {label: 'Keep'}});
    expect(next.properties.map((property) => property.id)).toEqual(['keep']);
  });
});
