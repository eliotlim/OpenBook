import {describe, expect, it} from 'vitest';
import type {DatabasePropertyType, DatabaseSchema} from './database';
import {
  FORM_FIELD_BYTE_CAPS,
  FORM_FIELD_KINDS,
  FORM_FIELD_PROPERTY_TYPES,
  FORM_FILES_MAX_ITEMS,
  FORM_MULTISELECT_MAX_ITEMS,
  FORM_PATTERN_INPUT_MAX_LENGTH,
  FORM_PATTERN_MAX_LENGTH,
  planColumnCreation,
  submissionToRowInput,
  validateSubmission,
  type CoercedSubmission,
  type FormField,
  type FormFieldKind,
  type FormSchema,
  type FormValidationErrorCode,
  type SubmissionValidationResult,
} from './formSchema';

const schemaWith = (fields: FormField[]): FormSchema => ({
  formId: 'contact',
  fields,
  confirmation: {message: 'received'},
  submissionKey: 'submission-key',
  enabled: true,
  databaseId: 'db_contacts',
  maxSubmissions: 500,
  retention: {enabled: true, days: 30, basis: 'created'},
});

const makeField = (kind: FormFieldKind, overrides: Partial<FormField> = {}): FormField => ({
  id: kind,
  kind,
  label: kind,
  required: false,
  ...overrides,
});

function expectOk(result: SubmissionValidationResult): CoercedSubmission {
  expect(result).toHaveProperty('ok', true);
  if (!('ok' in result) || !result.ok) throw new Error('expected valid submission');
  return result.coerced;
}

function expectError(result: SubmissionValidationResult, fieldId: string, code: FormValidationErrorCode): void {
  expect(result).toHaveProperty('ok', false);
  if (!('ok' in result) || result.ok) throw new Error('expected invalid submission');
  expect(result.errors).toContainEqual({fieldId, code});
}

interface KindCase {
  kind: FormFieldKind;
  field?: Partial<FormField>;
  valid: unknown;
  invalidType: unknown;
  boundary: unknown;
}

const kindCases: KindCase[] = [
  {
    kind: 'text',
    valid: 'Ada',
    invalidType: ['Ada'],
    boundary: 'é'.repeat(FORM_FIELD_BYTE_CAPS.text / 2),
  },
  {
    kind: 'longtext',
    valid: 'A useful paragraph.\nWith a second line.',
    invalidType: {text: 'boxed'},
    boundary: 'x'.repeat(FORM_FIELD_BYTE_CAPS.longtext),
  },
  {
    kind: 'number',
    field: {validation: {min: -10, max: 10}},
    valid: 1.25,
    invalidType: '1.25',
    boundary: -10,
  },
  {
    kind: 'select',
    field: {options: [{id: 'red', label: 'Red'}, {id: 'blue', label: 'Blue'}]},
    valid: 'red',
    invalidType: ['red'],
    boundary: 'blue',
  },
  {
    kind: 'multiselect',
    valid: ['red', 'blue'],
    invalidType: 'red',
    boundary: Array.from({length: FORM_MULTISELECT_MAX_ITEMS}, (_, index) => `option-${index}`),
  },
  {
    kind: 'checkbox',
    valid: false,
    invalidType: 0,
    boundary: true,
  },
  {
    kind: 'date',
    valid: '2026-08-12T09:30:45.123+08:00',
    invalidType: new Date('2026-08-12'),
    boundary: '2024-02-29',
  },
  {
    kind: 'email',
    valid: 'person@example.com',
    invalidType: {address: 'person@example.com'},
    boundary: 'a@b.co',
  },
  {
    kind: 'phone',
    valid: '+65 6123 4567',
    invalidType: 6561234567,
    boundary: '1234567',
  },
  {
    kind: 'url',
    valid: 'https://book.dev/forms?q=1',
    invalidType: ['https://book.dev'],
    boundary: 'http://a.co',
  },
  {
    kind: 'rating',
    valid: 3,
    invalidType: '3',
    boundary: 5,
  },
  {
    kind: 'files',
    valid: ['https://cdn.example/a.png', 'asset:document-1'],
    invalidType: 'https://cdn.example/a.png',
    boundary: Array.from({length: FORM_FILES_MAX_ITEMS}, (_, index) => `asset:${index}`),
  },
];

describe('form field kind contract', () => {
  it('maps every field kind exhaustively to its database property type', () => {
    const compileTimeMap: Record<FormFieldKind, DatabasePropertyType> = FORM_FIELD_PROPERTY_TYPES;
    expect(Object.keys(compileTimeMap)).toEqual(FORM_FIELD_KINDS);
    expect(compileTimeMap).toEqual({
      text: 'text',
      longtext: 'text',
      number: 'number',
      select: 'select',
      multiselect: 'multi_select',
      checkbox: 'checkbox',
      date: 'date',
      email: 'email',
      phone: 'phone',
      url: 'url',
      rating: 'rating',
      files: 'files',
    });
  });

  for (const testCase of kindCases) {
    describe(testCase.kind, () => {
      const field = makeField(testCase.kind, testCase.field);

      it('accepts and preserves a valid value', () => {
        const coerced = expectOk(validateSubmission(schemaWith([field]), {[field.id]: testCase.valid}));
        expect(coerced[field.id]).toEqual(testCase.valid);
      });

      it('rejects type confusion', () => {
        expectError(validateSubmission(schemaWith([field]), {[field.id]: testCase.invalidType}), field.id, 'type');
      });

      it('accepts its inclusive or hard boundary', () => {
        const coerced = expectOk(validateSubmission(schemaWith([field]), {[field.id]: testCase.boundary}));
        expect(coerced[field.id]).toEqual(testCase.boundary);
      });
    });
  }
});

describe('required and optional fields', () => {
  it('omits absent optional values and reports absent required values', () => {
    const optional = makeField('text', {id: 'optional'});
    const required = makeField('number', {id: 'required', required: true});
    const result = validateSubmission(schemaWith([optional, required]), {});
    expectError(result, 'required', 'required');
    if ('ok' in result && !result.ok) expect(result.errors).toHaveLength(1);
  });

  it('treats whitespace strings, empty arrays, and false required checkboxes as empty', () => {
    const fields = [
      makeField('text', {id: 'text', required: true}),
      makeField('multiselect', {id: 'choices', required: true}),
      makeField('checkbox', {id: 'consent', required: true}),
    ];
    const result = validateSubmission(schemaWith(fields), {text: '  ', choices: [], consent: false});
    expect(result).toEqual({
      ok: false,
      errors: [
        {fieldId: 'text', code: 'required'},
        {fieldId: 'choices', code: 'required'},
        {fieldId: 'consent', code: 'required'},
      ],
    });
  });

  it('does not mistake wrong-shaped empty values for optional emptiness', () => {
    expectError(validateSubmission(schemaWith([makeField('text')]), {text: []}), 'text', 'type');
    expectError(validateSubmission(schemaWith([makeField('number')]), {number: ''}), 'number', 'type');
  });
});

describe('honeypot semantics', () => {
  const schema = schemaWith([
    makeField('text', {id: 'website', honeypot: true}),
    makeField('text', {id: 'name', required: true}),
  ]);

  it('returns the distinguished silent-success signal for any non-empty trap value', () => {
    expect(validateSubmission(schema, {website: 'bot', name: ''})).toEqual({honeypot: true});
    expect(validateSubmission(schema, {website: false, name: 'Ada'})).toEqual({honeypot: true});
    expect(validateSubmission(schema, {website: {bot: true}, unknown: 'also ignored'})).toEqual({honeypot: true});
  });

  it('treats whitespace as non-empty but ignores an absent or exactly empty trap', () => {
    expect(validateSubmission(schema, {website: '  ', name: 'Ada'})).toEqual({honeypot: true});
    expect(expectOk(validateSubmission(schema, {website: '', name: 'Ada'}))).toEqual({name: 'Ada'});
    expect(expectOk(validateSubmission(schema, {name: 'Grace'}))).toEqual({name: 'Grace'});
  });
});

describe('constraints and syntax', () => {
  it('applies inclusive numeric min/max and the intrinsic integer 1..5 rating bounds', () => {
    const number = makeField('number', {validation: {min: 1, max: 2}});
    expectOk(validateSubmission(schemaWith([number]), {number: 1}));
    expectOk(validateSubmission(schemaWith([number]), {number: 2}));
    expectError(validateSubmission(schemaWith([number]), {number: 0}), 'number', 'min');
    expectError(validateSubmission(schemaWith([number]), {number: 3}), 'number', 'max');
    expectError(validateSubmission(schemaWith([makeField('rating')]), {rating: 0}), 'rating', 'min');
    expectError(validateSubmission(schemaWith([makeField('rating')]), {rating: 6}), 'rating', 'max');
    expectError(validateSubmission(schemaWith([makeField('rating')]), {rating: 2.5}), 'rating', 'type');
    expectError(validateSubmission(schemaWith([makeField('number')]), {number: Infinity}), 'number', 'type');
  });

  it('applies inclusive string and array minLength/maxLength', () => {
    const text = makeField('text', {validation: {minLength: 2, maxLength: 3}});
    expectOk(validateSubmission(schemaWith([text]), {text: 'ab'}));
    expectOk(validateSubmission(schemaWith([text]), {text: 'abc'}));
    expectError(validateSubmission(schemaWith([text]), {text: 'a'}), 'text', 'minLength');
    expectError(validateSubmission(schemaWith([text]), {text: 'abcd'}), 'text', 'maxLength');

    const files = makeField('files', {validation: {minLength: 1, maxLength: 2}});
    expectError(validateSubmission(schemaWith([files]), {files: ['a', 'b', 'c']}), 'files', 'maxLength');
  });

  it('enforces option ids when options are present and allows opaque ids when absent', () => {
    const options = [{id: 'red', label: 'Red'}, {id: 'blue', label: 'Blue'}];
    expectError(validateSubmission(schemaWith([makeField('select', {options})]), {select: 'green'}), 'select', 'option');
    expectError(
      validateSubmission(schemaWith([makeField('multiselect', {options})]), {multiselect: ['red', 'green']}),
      'multiselect',
      'option',
    );
    expectError(validateSubmission(schemaWith([makeField('select', {options: []})]), {select: 'red'}), 'select', 'option');
    expect(expectOk(validateSubmission(schemaWith([makeField('select')]), {select: 'server-owned-id'}))).toEqual({
      select: 'server-owned-id',
    });
  });

  it('accepts a strict ISO-8601 subset and rejects normalized or malformed dates', () => {
    for (const value of ['2026-08-12', '2026-08-12T09:30', '2026-08-12T09:30Z', '2026-08-12T09:30:59-04:00']) {
      expectOk(validateSubmission(schemaWith([makeField('date')]), {date: value}));
    }
    for (const value of ['08/12/2026', '2026-02-29', '2026-13-01', '2026-01-01T25:00', 'tomorrow']) {
      expectError(validateSubmission(schemaWith([makeField('date')]), {date: value}), 'date', 'date_format');
    }
  });

  it('checks and trims email, URL, and phone syntax without converting types', () => {
    const fields = [makeField('email'), makeField('url'), makeField('phone')];
    const coerced = expectOk(validateSubmission(schemaWith(fields), {
      email: ' person@example.com ',
      url: ' https://book.dev/path ',
      phone: ' +65 6123 4567 ',
    }));
    expect(coerced).toEqual({email: 'person@example.com', url: 'https://book.dev/path', phone: '+65 6123 4567'});
    expectError(validateSubmission(schemaWith([makeField('email')]), {email: 'not-an-email'}), 'email', 'email_format');
    expectError(validateSubmission(schemaWith([makeField('url')]), {url: 'javascript:alert(1)'}), 'url', 'url_format');
    expectError(validateSubmission(schemaWith([makeField('url')]), {url: 'book.dev'}), 'url', 'url_format');
    expectError(validateSubmission(schemaWith([makeField('phone')]), {phone: '+12 letters'}), 'phone', 'phone_format');
    expectError(validateSubmission(schemaWith([makeField('phone')]), {phone: '123456'}), 'phone', 'phone_format');
  });
});

describe('bounded patterns and byte caps', () => {
  it('matches valid patterns and returns only stable pattern errors', () => {
    const field = makeField('text', {validation: {pattern: '^[A-Z]{2}-\\d{3}$'}});
    expectOk(validateSubmission(schemaWith([field]), {text: 'AB-123'}));
    expectError(validateSubmission(schemaWith([field]), {text: 'bad'}), 'text', 'pattern');
    expectError(
      validateSubmission(schemaWith([makeField('text', {validation: {pattern: '['}})]), {text: 'value'}),
      'text',
      'pattern',
    );
  });

  it('rejects oversized, backtracking-shaped, and over-input patterns without running them', () => {
    const tooLong = makeField('text', {validation: {pattern: 'x'.repeat(FORM_PATTERN_MAX_LENGTH + 1)}});
    expectError(validateSubmission(schemaWith([tooLong]), {text: 'x'}), 'text', 'pattern');

    const catastrophic = makeField('longtext', {validation: {pattern: '^(a+)+$'}});
    expectError(
      validateSubmission(schemaWith([catastrophic]), {longtext: `${'a'.repeat(1_000)}!`}),
      'longtext',
      'pattern',
    );

    const boundedInput = makeField('longtext', {validation: {pattern: '^x+$'}});
    expectError(
      validateSubmission(schemaWith([boundedInput]), {longtext: 'x'.repeat(FORM_PATTERN_INPUT_MAX_LENGTH + 1)}),
      'longtext',
      'pattern',
    );
  });

  const oversizedValues: Array<{kind: FormFieldKind; value: unknown}> = [
    {kind: 'text', value: 'x'.repeat(FORM_FIELD_BYTE_CAPS.text + 1)},
    {kind: 'longtext', value: 'x'.repeat(FORM_FIELD_BYTE_CAPS.longtext + 1)},
    {kind: 'select', value: 'x'.repeat(FORM_FIELD_BYTE_CAPS.select + 1)},
    {kind: 'multiselect', value: ['x'.repeat(FORM_FIELD_BYTE_CAPS.multiselect + 1)]},
    {kind: 'date', value: 'x'.repeat(FORM_FIELD_BYTE_CAPS.date + 1)},
    {kind: 'email', value: 'x'.repeat(FORM_FIELD_BYTE_CAPS.email + 1)},
    {kind: 'phone', value: '1'.repeat(FORM_FIELD_BYTE_CAPS.phone + 1)},
    {kind: 'url', value: 'x'.repeat(FORM_FIELD_BYTE_CAPS.url + 1)},
    {kind: 'files', value: ['x'.repeat(FORM_FIELD_BYTE_CAPS.files + 1)]},
  ];

  for (const testCase of oversizedValues) {
    it(`rejects ${testCase.kind} beyond its UTF-8 byte cap`, () => {
      expectError(
        validateSubmission(schemaWith([makeField(testCase.kind)]), {[testCase.kind]: testCase.value}),
        testCase.kind,
        'too_large',
      );
    });
  }

  it('counts UTF-8 bytes, not only JS string length', () => {
    expectOk(validateSubmission(schemaWith([makeField('text')]), {text: 'é'.repeat(512)}));
    expectError(validateSubmission(schemaWith([makeField('text')]), {text: 'é'.repeat(513)}), 'text', 'too_large');
  });
});

describe('hostile payload shapes', () => {
  it('rejects unknown own fields, including JSON __proto__, without prototype mutation', () => {
    const values = JSON.parse('{"name":"Ada","__proto__":{"polluted":true}}') as Record<string, unknown>;
    const result = validateSubmission(schemaWith([makeField('text', {id: 'name'})]), values);
    expectError(result, '__proto__', 'unknown_field');
    expect((Object.prototype as {polluted?: boolean}).polluted).toBeUndefined();
  });

  it('can safely emit a schema-declared __proto__ field as an own property', () => {
    const values = JSON.parse('{"__proto__":"safe"}') as Record<string, unknown>;
    const coerced = expectOk(validateSubmission(schemaWith([makeField('text', {id: '__proto__'})]), values));
    expect(Object.prototype.hasOwnProperty.call(coerced, '__proto__')).toBe(true);
    expect(coerced.__proto__).toBe('safe');
    expect(Object.getPrototypeOf(coerced)).toBe(Object.prototype);
  });

  it('rejects huge arrays before walking their elements and rejects a huge top-level array', () => {
    const deepElement = {nested: {nested: {value: 'x'}}};
    const huge = new Array(100_000).fill(deepElement);
    expectError(validateSubmission(schemaWith([makeField('multiselect')]), {multiselect: huge}), 'multiselect', 'too_large');
    expectError(
      validateSubmission(schemaWith([makeField('text')]), huge as unknown as Record<string, unknown>),
      '',
      'type',
    );
  });

  it('rejects deeply nested and cyclic objects on shape without traversing or crashing', () => {
    let deep: Record<string, unknown> = {leaf: 'x'};
    for (let index = 0; index < 10_000; index += 1) deep = {nested: deep};
    expectError(validateSubmission(schemaWith([makeField('text')]), {text: deep}), 'text', 'type');

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expectError(validateSubmission(schemaWith([makeField('url')]), {url: cyclic}), 'url', 'type');
  });

  it('rejects boxed strings, NaN, mixed arrays, and empty array entries', () => {
    expectError(validateSubmission(schemaWith([makeField('text')]), {text: new String('boxed')}), 'text', 'type');
    expectError(validateSubmission(schemaWith([makeField('number')]), {number: NaN}), 'number', 'type');
    expectError(validateSubmission(schemaWith([makeField('files')]), {files: ['good', {url: 'bad'}]}), 'files', 'type');
    expectError(validateSubmission(schemaWith([makeField('multiselect')]), {multiselect: ['']}), 'multiselect', 'type');
  });
});

const realisticDbSchema: DatabaseSchema = {
  properties: [
    {id: 'p_text', name: 'Name', type: 'text'},
    {id: 'p_bio', name: 'Bio', type: 'text'},
    {id: 'p_age', name: 'Age', type: 'number'},
    {id: 'p_color', name: 'Color', type: 'select', options: [{id: 'blue', label: 'Blue'}]},
    {id: 'p_tags', name: 'Tags', type: 'multi_select', options: [{id: 'sdk', label: 'SDK'}]},
    {id: 'p_consent', name: 'Consent', type: 'checkbox'},
    {id: 'p_date', name: 'Date', type: 'date', includeTime: true},
    {id: 'p_email', name: 'Email', type: 'email'},
    {id: 'p_phone', name: 'Phone', type: 'phone'},
    {id: 'p_url', name: 'URL', type: 'url'},
    {id: 'p_rating', name: 'Rating', type: 'rating', numberTarget: 5},
    {id: 'p_files', name: 'Files', type: 'files'},
  ],
  views: [{id: 'v_table', name: 'All', type: 'table', filters: [], sorts: []}],
};

describe('submissionToRowInput', () => {
  it('projects every field kind to the exact stored database-cell shape', () => {
    const fields: FormField[] = [
      makeField('text', {id: 'name', columnId: 'p_text'}),
      makeField('longtext', {id: 'bio', columnId: 'p_bio'}),
      makeField('number', {id: 'age', columnId: 'p_age'}),
      makeField('select', {id: 'color', columnId: 'p_color', options: [{id: 'blue', label: 'Blue'}]}),
      makeField('multiselect', {id: 'tags', columnId: 'p_tags', options: [{id: 'sdk', label: 'SDK'}]}),
      makeField('checkbox', {id: 'consent', columnId: 'p_consent'}),
      makeField('date', {id: 'date', columnId: 'p_date'}),
      makeField('email', {id: 'email', columnId: 'p_email'}),
      makeField('phone', {id: 'phone', columnId: 'p_phone'}),
      makeField('url', {id: 'url', columnId: 'p_url'}),
      makeField('rating', {id: 'rating', columnId: 'p_rating'}),
      makeField('files', {id: 'files', columnId: 'p_files'}),
    ];
    const values = {
      name: 'Ada',
      bio: 'First programmer',
      age: 36,
      color: 'blue',
      tags: ['sdk'],
      consent: true,
      date: '2026-08-12T09:30+08:00',
      email: 'ada@example.com',
      phone: '+65 6123 4567',
      url: 'https://book.dev',
      rating: 5,
      files: ['asset:portrait', 'https://cdn.example/resume.pdf'],
    };
    const coerced = expectOk(validateSubmission(schemaWith(fields), values));
    const projection = submissionToRowInput(schemaWith(fields), coerced, realisticDbSchema);
    expect(projection).toEqual({
      rowInput: {
        properties: {
          p_text: 'Ada',
          p_bio: 'First programmer',
          p_age: 36,
          p_color: 'blue',
          p_tags: ['sdk'],
          p_consent: true,
          p_date: '2026-08-12T09:30+08:00',
          p_email: 'ada@example.com',
          p_phone: '+65 6123 4567',
          p_url: 'https://book.dev',
          p_rating: 5,
          p_files: ['asset:portrait', 'https://cdn.example/resume.pdf'],
        },
      },
      warnings: [],
    });
    expect(projection.rowInput.properties?.p_tags).not.toBe(coerced.tags);
    expect(projection.rowInput.properties?.p_files).not.toBe(coerced.files);
  });

  it('drops unbound, missing, incompatible, absent, and honeypot fields safely', () => {
    const fields = [
      makeField('text', {id: 'unbound'}),
      makeField('number', {id: 'missing', columnId: 'p_missing'}),
      makeField('phone', {id: 'mismatch', columnId: 'p_text'}),
      makeField('text', {id: 'absent'}),
      makeField('text', {id: 'trap', honeypot: true}),
    ];
    const coerced: CoercedSubmission = {unbound: 'value', missing: 1, mismatch: '+65 6123 4567', trap: 'ignore'};
    expect(submissionToRowInput(schemaWith(fields), coerced, realisticDbSchema)).toEqual({
      rowInput: {properties: {}},
      warnings: [
        {fieldId: 'unbound', code: 'unbound_field'},
        {fieldId: 'missing', code: 'column_not_found'},
        {fieldId: 'mismatch', code: 'column_type_mismatch'},
      ],
    });
  });

  it('never projects reserved sys_* database properties', () => {
    const fields = [
      makeField('text', {id: 'safe', columnId: 'p_safe'}),
      makeField('text', {id: 'reserved', columnId: 'sys_form_submission'}),
    ];
    const dbSchema: DatabaseSchema = {
      properties: [
        {id: 'p_safe', name: 'Safe', type: 'text'},
        {id: 'sys_form_submission', name: 'Submission marker', type: 'text'},
      ],
      views: [],
    };

    expect(submissionToRowInput(schemaWith(fields), {safe: 'kept', reserved: 'discarded'}, dbSchema)).toEqual({
      rowInput: {properties: {p_safe: 'kept'}},
      warnings: [],
    });
  });
});

describe('planColumnCreation', () => {
  it('plans deterministic compatible columns only for unbound non-honeypot fields', () => {
    const options = [{id: 'one', label: 'One', color: 'blue'}];
    const fields = [
      makeField('text', {id: 'notes', label: 'Notes'}),
      makeField('select', {id: 'category', label: 'Category', options}),
      makeField('rating', {id: 'score', label: 'Score'}),
      makeField('email', {id: 'bound', columnId: 'p_email'}),
      makeField('text', {id: 'trap', honeypot: true}),
    ];
    const dbSchema: DatabaseSchema = {
      properties: [{id: 'form_notes', name: 'Existing', type: 'text'}],
      views: [],
    };
    const plan = planColumnCreation(schemaWith(fields), dbSchema);
    expect(plan.map(({field, proposedProperty}) => ({fieldId: field.id, proposedProperty}))).toEqual([
      {fieldId: 'notes', proposedProperty: {id: 'form_notes_2', name: 'Notes', type: 'text'}},
      {
        fieldId: 'category',
        proposedProperty: {id: 'form_category', name: 'Category', type: 'select', options},
      },
      {fieldId: 'score', proposedProperty: {id: 'form_score', name: 'Score', type: 'rating', numberTarget: 5}},
    ]);
    expect(plan[1].proposedProperty.options).not.toBe(options);
    expect(dbSchema.properties).toEqual([{id: 'form_notes', name: 'Existing', type: 'text'}]);
  });
});
