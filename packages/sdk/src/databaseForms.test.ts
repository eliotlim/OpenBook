import {describe, expect, it} from 'vitest';
import {
  FORM_PROPERTY_TYPE_WRITABILITY,
  KNOWN_DATABASE_VIEW_TYPES,
  defaultView,
  isDatabaseViewType,
  isFormWritablePropertyType,
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
    expect(isFormWritablePropertyType('__proto__' as DatabasePropertyType)).toBe(false);
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
    expect(view.visiblePropertyIds).toEqual(['name', 'email']);
    expect(view.formFields).toEqual({});
    expect(view.formConfig).toEqual({acceptingResponses: true});
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
