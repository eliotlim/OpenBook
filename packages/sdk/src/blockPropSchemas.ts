import {z} from 'zod';

export type BlockPropsJsonSchema = {
  type: 'object';
  properties: Record<string, unknown>;
  additionalProperties: false;
};

type Field = {schema: z.ZodTypeAny; json: Record<string, unknown>};
const string = (description?: string, constraints: Record<string, unknown> = {}): Field => ({
  schema: z.string(), json: {type: 'string', ...constraints, ...(description ? {description} : {})},
});
const number = (description?: string, minimum?: number, maximum?: number): Field => ({
  schema: z.number().finite().refine((n) => minimum === undefined || n >= minimum).refine((n) => maximum === undefined || n <= maximum),
  json: {type: 'number', ...(minimum === undefined ? {} : {minimum}), ...(maximum === undefined ? {} : {maximum}), ...(description ? {description} : {})},
});
const boolean = (description?: string): Field => ({schema: z.boolean(), json: {type: 'boolean', ...(description ? {description} : {})}});
const enumeration = (values: readonly [string, ...string[]], description?: string): Field => ({
  schema: z.enum(values), json: {type: 'string', enum: [...values], ...(description ? {description} : {})},
});
const array = (item: Field, description?: string): Field => ({
  schema: z.array(item.schema), json: {type: 'array', items: item.json, ...(description ? {description} : {})},
});
const object = (fields: Record<string, Field>, description?: string, required: readonly string[] = []): Field => ({
  schema: z.object(Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, required.includes(k) ? v.schema : v.schema.optional()]))).strict(),
  json: {type: 'object', properties: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v.json])), ...(required.length ? {required: [...required]} : {}), additionalProperties: false, ...(description ? {description} : {})},
});
const freeObject: Field = {schema: z.record(z.unknown()), json: {type: 'object', additionalProperties: true}};

const expression = (description: string): Field => ({
  schema: z.string().trim().min(1).max(4_096),
  json: {type: 'string', minLength: 1, maxLength: 4096, format: 'openbook-expression', description},
});
const id = string('Stable identifier.', {minLength: 1, maxLength: 512});
const text = string(undefined, {maxLength: 16_384});
const selected = array(string('Option value/id.', {minLength: 1, maxLength: 512}), 'Selected option value IDs.');
const option = object({label: string('Reader-facing label.', {minLength: 1, maxLength: 512}), value: string('Published value; defaults to a slug of label.', {maxLength: 512}), image: text, icon: text, color: text}, 'A selectable option.', ['label']);
const opts = array(option, 'Structured selectable options.');
const attrs = object({b: boolean(), i: boolean(), u: boolean(), s: boolean(), c: boolean(), a: string('Safe http, https, or mailto link.')});
const run = object({t: string('Run text.'), a: attrs}, 'One rich-text run.', ['t']);
const runs = array(run, 'Rich-text runs.');
const common = {bg: text};
const frame = {name: text, label: text, description: text, compact: boolean(), interactive: boolean()};
const inputText = {...frame, value: text, placeholder: text};
const optionsBase = {...frame, value: text, opts, options: text};

const fields = {
  paragraph: {}, heading: {level: number('Heading level.', 1, 3)}, list: {kind: enumeration(['bullet', 'number'])},
  todo: {checked: boolean()}, quote: {}, callout: {variant: enumeration(['info', 'warn', 'success'])},
  code: {language: text, live: boolean(), name: text, collapsed: boolean()}, notes: {}, divider: {},
  image: {assetId: id, src: text, alt: text, width: number('Rendered width in CSS pixels.', 1, 4096)},
  htmlArtifact: {assetId: id, name: text, height: number('Sandbox height in CSS pixels.', 80, 4096)},
  columns: {}, column: {span: number('Grid columns.', 1, 12)}, table: {}, row: {header: boolean()}, cell: {},
  group: {name: text, locked: boolean()}, tabs: {}, tab: {label: text}, accordion: {name: text, gated: boolean()}, accordionsection: {label: text, collapsed: boolean()},
  slider: {...frame, value: number(), min: number(), max: number(), step: number(undefined, 0)},
  number: {...frame, value: number(), min: number(), max: number(), step: number(undefined, 0)},
  textfield: inputText, longtext: inputText, richtext: {...frame, placeholder: text, runs}, toggle: {...frame, value: boolean()},
  radio: optionsBase, dropdown: optionsBase, checklist: {...optionsBase, selected},
  choicecards: {...optionsBase, selected, multi: boolean()},
  searchselect: {...optionsBase, selected, multi: boolean(), dynamic: expression('Expression returning an array or comma-separated string.')},
  tagfield: {...frame, selected, opts, options: text, dynamic: expression('Expression returning tag suggestions.'), freeEntry: boolean()},
  location: {...frame, labeltext: text, lat: number('Latitude.', -90, 90), lng: number('Longitude.', -180, 180)},
  actionbutton: {...frame, btnlabel: text, action: enumeration(['increment', 'set', 'toggle', 'link']), target: text, amount: number(), url: text},
  kitchart: {...frame, kind: enumeration(['line', 'area', 'bar', 'pie', 'donut', 'scatter', 'funnel']), title: text, labels: expression('Expression or comma-separated labels.'), source: expression('Expression producing chart data.'), sourceMode: enumeration(['expression', 'database']), dbId: text, dbGroupBy: text, dbAggProp: text, dbAggType: text, dbFilterProp: text, dbFilterInput: text},
  statuslight: {...frame, source: expression('Condition/value expression.'), okAt: number(), warnAt: number()},
  progressbar: {...frame, source: expression('Numeric expression.'), max: number(undefined, 0), format: text},
  formula: {...frame, source: expression('Expression evaluated over the reactive scope.')},
  linkcard: {title: text, url: text, description: text}, tooltipcard: {term: text, tip: text},
  dbview: {pageId: id}, dbform: {databaseId: id, viewId: id},
  form: {formId: id, submissionKey: text, enabled: boolean(), databaseId: id, schema: freeObject, label: text, description: text},
} satisfies Record<string, Record<string, Field>>;

export type CataloguedSchemaType = keyof typeof fields;

const makeEntry = (own: Record<string, Field>): {schema: z.ZodObject<z.ZodRawShape>; jsonSchema: BlockPropsJsonSchema} => {
  const all = {...common, ...own};
  return {
    // Patches are optional and nullable: null removes the prop. Strictness keeps
    // misspellings from silently becoming inert document data.
    schema: z.object(Object.fromEntries(Object.entries(all).map(([k, v]) => [k, v.schema.nullish()]))).strict(),
    jsonSchema: {type: 'object', properties: Object.fromEntries(Object.entries(all).map(([k, v]) => [k, {...v.json, nullable: true}])), additionalProperties: false},
  };
};

export const BLOCK_PROP_SCHEMAS: Readonly<Record<CataloguedSchemaType, z.ZodObject<z.ZodRawShape>>> = Object.fromEntries(
  Object.entries(fields).map(([type, shape]) => [type, makeEntry(shape).schema]),
) as Record<CataloguedSchemaType, z.ZodObject<z.ZodRawShape>>;

export const BLOCK_PROP_JSON_SCHEMAS: Readonly<Record<CataloguedSchemaType, BlockPropsJsonSchema>> = Object.fromEntries(
  Object.entries(fields).map(([type, shape]) => [type, makeEntry(shape).jsonSchema]),
) as Record<CataloguedSchemaType, BlockPropsJsonSchema>;
