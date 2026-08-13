# Forms × Databases contract spike (F-1)

Status: normative interface contract for F-2 (form-view builder), F-3
(standalone form block), and F-4 (public fill route). This spike defines shared
types and pure validation only; it does not implement those features.

## 1. Product invariants

Forms and databases are two views of the same rows and columns.

- A database may own zero, one, or many `DatabaseView` values with
  `type: 'form'`. Each form view has independent field order, inclusion, copy,
  required flags, response state, publication, and capability.
- A form field always projects a current `DatabaseProperty`. Adding or retyping
  a field therefore creates or updates a database column; there is no second
  field schema to drift from the database schema.
- A form view remains available in the database view switcher. A standalone
  `form` block stores a `DatabaseFormReference` (`databaseId`, `viewId`) and
  renders that same view; it must not copy field definitions into block props.
- Publishing a page as a form is a form-only render mode. It MUST NOT reveal the
  database toolbar, view switcher, schema, existing rows, or an editable grid.
  Publishing the underlying database is a separate, explicit action with its
  own access decision. Publishing either one never implicitly publishes the
  other.
- Public fill and form-only fields are in v1.

## 2. Persisted SDK shape

`DatabaseViewType` includes `'form'`. A form view uses the existing
`visiblePropertyIds` as its canonical ordered field mapping and adds:

```ts
interface DatabaseView {
  // existing fields omitted
  type: DatabaseViewType;
  visiblePropertyIds?: string[];
  formFields?: Record<string, {
    label?: string;
    help?: string;
    required?: boolean;
    placeholder?: string;
  }>;
  formConfig?: {
    title?: string;
    description?: string;
    submitLabel?: string;
    confirmationMessage?: string;
    acceptingResponses?: boolean;
  };
}
```

For a form view, `visiblePropertyIds` is deliberately stricter than its legacy
meaning on row layouts: only explicitly listed property ids are fields, and
their array order is display and validation order. Missing or empty means no
fields, not all columns. `defaultView('form', ...)` writes an explicit list of
all current v1-writable, non-reserved properties, an empty `formFields`, and
`acceptingResponses: true`.

`formFields` is presentation/required metadata only. An entry not present in
`visiblePropertyIds`, not present in the current schema, or no longer writable
is ignored. Property name, type, options, date configuration, and number/rating
configuration are always read live from `DatabaseProperty`. An optional
`formFields[id].label` is a deliberate display override; without it, a column
rename immediately renames the form field. A retype immediately changes both
the builder control and server validation.

Display defaults are `view.name` for `formConfig.title`, `Submit` for
`submitLabel`, and a product-standard success message for
`confirmationMessage`. Only `acceptingResponses === true` accepts a public
fill; this is fail-closed for malformed/hand-authored persisted data. Setting it
false closes the form but does not unpublish it or revoke read access.

## 3. Field creation, mapping, and cleanup

F-2 must apply the following mutations atomically in one database-schema update.

Mapping an existing column appends its property id to the form view's
`visiblePropertyIds` (or inserts it at the chosen index) and optionally creates
its `formFields[id]` metadata. The property itself remains the source of truth.

Creating a form-only field mints an ordinary collision-free `DatabaseProperty`
with a normal property id, the requested v1-writable type/options, and
`pageHidden: true`; appends it to `schema.properties`; and maps it into this
form. `pageHidden` hides the field from the opened row's page-property panel. It
does not make a secret column and does not override another database view's
explicit column selection.

Unmapping a field from one form removes its id and that view's metadata but does
not delete the database column or any row values. A `pageHidden` column mapped
by no remaining form is a cleanup candidate: the builder may offer an explicit
"delete unused column" action, but must not auto-delete it. This avoids data
loss and avoids treating a user-hidden ordinary column as disposable. Deleting
an entire form view follows the same rule.

Deleting a column explicitly goes through the shared `removeProperty`. It
removes the id from every view's `visiblePropertyIds` and scrubs every
`formFields[id]` entry. Existing row JSON values under the deleted id are kept as
orphaned/archive data, consistent with current database column deletion; the
form and validator can no longer address them. Re-adding a same-named column
with a new id does not resurrect those values.

## 4. Publicly writable property types

The source-of-truth allowlist is the exhaustive SDK
`FORM_PROPERTY_TYPE_WRITABILITY` map and its
`isFormWritablePropertyType` guard. The current union has 24 members (the task
brief's count of 23 omits the computed `backlinks` member), so all 24 are frozen
here:

| Database property type | Public form v1 | Accepted value / reason |
| --- | --- | --- |
| `text` | yes | string |
| `number` | yes | finite number; no numeric-string coercion |
| `rating` | yes | integer 1 through the current UI target (default 5, capped at 10) |
| `select` | yes | one current option id |
| `multi_select` | yes | unique array of current option ids |
| `status` | yes | one current option id |
| `checkbox` | yes | boolean; `false` is a present value |
| `date` | yes | valid configured date/datetime, or configured `{start,end?}` range |
| `url` | yes | HTTP(S) URL string |
| `email` | yes | syntactically valid email string |
| `phone` | yes | 7–15 digits with the supported phone punctuation |
| `location` | yes | `{lat,lng,label?,address?}` with finite in-range coordinates |
| `files` | yes | non-empty string array; F-4 additionally claims staged upload tokens |
| `relation` | no | deferred: target-row visibility and referential integrity need an authority-aware picker/check |
| `dependency` | no | deferred: same-database row references need an authority-aware picker/check |
| `rollup` | no | computed |
| `created_time` | no | server managed |
| `last_edited_time` | no | server managed |
| `unique_id` | no | server managed |
| `expr` | no | computed from the row document |
| `formula` | no | computed |
| `person` | no | deferred: an anonymous filler cannot assert a trusted identity |
| `verification` | no | managed attestation; a filler cannot self-verify |
| `backlinks` | no | computed from the link graph |

This is a deliberate fail-closed v1 default. Adding support later requires
changing the exhaustive map, validator, builder control, public renderer, and
tests together.

## 5. Pure validation contract

F-4 must call the exported pure function against freshly loaded persisted data,
never a schema or field list supplied by the client:

```ts
validateRowAgainstForm(
  schema: DatabaseSchema,
  view: DatabaseView,
  fields: Record<string, unknown>,
): FormRowValidationResult
```

The effective allowlist is exactly:

```text
view.visiblePropertyIds
  ∩ current schema.properties ids
  ∩ v1 form-writable types
  − reserved sys_* ids
```

The function rejects a non-form view, a non-object payload, and every submitted
key outside that allowlist. It validates each allowed value against the current
property shape/options and returns either `{ok:true, fields}` with a fresh,
allowlisted record, or `{ok:false, errors}`. It never coerces numeric strings,
partially persists valid fields, or trusts `formFields` as a schema.

For required fields, absent, `null`, a blank string of the corresponding string
type, an empty choice/file array, and an empty configured date range are empty.
Numeric zero and checkbox `false` are valid present values. Optional empty
fields are omitted from successful output. Stable error codes are exported as
`FORM_ROW_VALIDATION_ERROR_CODES`; user-facing copy belongs to F-2/F-3.

File strings pass the pure shape check only. Before row creation, F-4 must bind
and atomically claim every token to this form capability using the existing
staged-upload rules, replace it with the retained asset URL, and reject an
unknown, expired, already-consumed, or cross-form token.

## 6. Fill capability and route (F-4)

The frozen endpoint is:

```text
POST /api/databases/:databaseId/views/:viewId/submissions
```

It is intentionally unauthenticated and is exposed in the SDK as
`API.databaseFormSubmissions(databaseId, viewId)`. Its JSON body is
`DatabaseFormSubmissionRequest`:

```ts
{
  capability: string;
  fields: Record<string, unknown>;
  idempotencyKey: string;
}
```

The capability grants only row creation through this exact form view. It grants
no database/page read, general database write, schema edit, or publish right.
It is a cryptographically random 256-bit unpadded base64url token. Publication
state owns it, not `DatabaseView`: persist only a SHA-256 digest keyed by
`(databaseId, viewId)`, compare in constant time, and return/expose the raw token
only as part of the form's public URL. The public URL should carry it in a URL
fragment (`#capability=...`) so it is not sent in navigation requests; the form
runtime copies it into the POST body. Do not place it in query strings, logs,
analytics, block props, or the database schema.

There is at most one active public-fill capability per form view. First publish
mints it; rotate/revoke replaces or removes the digest. Deleting a form view
revokes its record. Duplicating a form view creates a new `view.id` and MUST NOT
copy or alias publication state; publishing the duplicate mints a new
capability. Copying display configuration and field mappings is allowed.

The route order is normative:

1. Parse the bounded JSON envelope and require the existing non-simple client
   header/CSRF posture used by public forms.
2. Load `databaseId` and `viewId`; require a current form view, an ordinary
   non-managed database, `acceptingResponses === true`, an active matching
   capability, and the publication binding. Missing, deleted, stopped, managed,
   and wrong-token states return identical `404 {"error":"form not found"}`
   bytes so the route is not an existence oracle.
3. Apply the existing public-form rate, body, field-count, value-size, upload,
   and idempotency limits.
4. Run `validateRowAgainstForm(database.schema, view, body.fields)`. Validation
   failure returns `400` with the machine-readable errors and creates nothing.
5. Claim/resolve file tokens, then create exactly one row with the validated
   property record. The write principal is synthetic, with
   `subject: "form:<viewId>"`; it is attribution for this one operation, not a
   generally authorized guest principal.
6. Scope `idempotencyKey` to this capability/view. A replay returns the original
   `FormSubmissionResult` (`rowId`, `submittedAt`) with `201` and does not create
   another row.

Capability validation and current-schema validation occur on every request.
The client may render a stale builder snapshot, but the server result always
reflects the current database contract.

## 7. Mutation semantics

- **Rename:** property name changes flow live into every mapped form unless that
  form has an explicit label override.
- **Retype:** F-2 shows a builder warning when the current value/control changes
  or becomes unsupported. F-4 validates against the current type. A stale
  submission is rejected; it is never coerced using the former type.
- **Column delete:** `removeProperty` removes the field from all form mappings
  and metadata. Orphaned values already stored on rows remain archived.
- **Duplicate form view:** copy layout/config/mappings, assign a new view id, and
  mint a new capability on publish. Never copy publication/capability state.
- **Stop responses:** `acceptingResponses: false` makes the fill route fail
  closed without deleting submissions or field configuration.

## 8. Compatibility and F-2 handoff

Persisted view types cross version boundaries and must be decoded as untrusted
strings. Call `isDatabaseViewType`/consult `KNOWN_DATABASE_VIEW_TYPES` before
interpreting one. Any unknown type MUST render a non-editable "A newer client is
required" card. It MUST NEVER enter the table renderer or expose all columns as
an editable grid.

The F-1 UI compatibility stub gives `'form'` that same card and makes `'table'`
an explicit switch case, leaving the default fail-closed for genuinely unknown
future types. F-2 replaces only the known `'form'` case with the builder/preview
and preserves the unknown default.

Adding `'form'` also extends the two exhaustive UI maps that otherwise break
typecheck: the default-name map currently in
`packages/ui/src/components/database/useDatabase.ts` and the hint-key map in
`packages/ui/src/components/database/databaseMenus.tsx` (the task's cited line
numbers predate the former map's move). `VIEW_TYPES` gets a temporary Form item,
and `database.addView.hints.form` exists in en/de/ja/zh with the intentionally
plain placeholder `Form`. F-2 owns final icons and localized copy.

## 9. Explicit defaults and deferrals

- New form views explicitly map all current v1-writable, non-`sys_*` columns and accept
  responses, but are not public until separately published.
- Missing/invalid mapping, acceptance state, capability state, view type, or
  property type fails closed.
- Relation, dependency, person, and verification controls are deferred from
  public v1 for the authority reasons in the table; their columns can still be
  displayed in ordinary database views.
- Capability persistence is deliberately server publication state rather than
  schema/block data. F-4 owns the digest record and fill-route gate; F-2/F-3
  consume only the public URL and `DatabaseFormReference`.
- Removing a form field never auto-deletes its column. Destructive cleanup is an
  explicit column action routed through `removeProperty`.

## 10. Review gates for F-2/F-3/F-4

- F-2: field reorder/inclusion changes only `visiblePropertyIds`; field edits
  mutate `DatabaseProperty`; retype warnings and unknown-view fallback are
  covered by UI tests.
- F-3: a standalone block persists only `DatabaseFormReference`, renders no
  database surface in form-only publication mode, and does not expose a raw
  capability in page/block JSON.
- F-4: capability isolation/rotation/duplicate-view tests, oracle-equivalent
  404s, managed-database refusal, current-type race tests, strict allowlist and
  required-field tests, upload binding, synthetic author attribution, rate/body
  limits, and idempotent replay all pass before enabling the public route.
