# Forms × Databases contract spike (F-1)

Status: normative interface contract for F-2 (form-view builder), F-3
(database-form embedding), and F-4 (public fill route). This spike defines shared
types and pure validation only; it does not implement those features.

## 1. Product invariants

Forms and databases are two views of the same rows and columns.

- A database may own zero, one, or many `DatabaseView` values with
  `type: 'form'`. Each form view has independent field order, inclusion, copy,
  required flags, response state, publication, and capability.
- A form field projects a current `DatabaseProperty`, except for the explicit
  virtual `TITLE_PROPERTY_ID` mapping to the row page name. Adding or retyping
  any other field therefore creates or updates a database column; there is no
  second property schema to drift from the database schema.
- A form view remains available in the database view switcher. F-3 is the path
  for a new embedding block: it stores only a `DatabaseFormReference`
  (`databaseId`, `viewId`) and renders that same view, without copying field
  definitions into block props.
- The already-shipped legacy standalone `form` block (`FormSchema`,
  `FormBuilder`, and `formAccess.ts`) and database-view forms coexist in
  parallel. This contract does not migrate or reinterpret legacy blocks;
  migration is explicitly deferred.
- Publishing a database-view form is a form-only action and render mode. It MUST
  NOT reveal the database toolbar, view switcher, schema, existing rows, or an
  editable grid. Form publication and its single active capability belong to
  `(databaseId, viewId)`, independently of page or database publication state.
  Publishing or unpublishing any one of the form, page, or database never
  implicitly changes either of the other two.
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
    multiline?: boolean;
    validation?: {
      min?: number;
      max?: number;
      minLength?: number;
      maxLength?: number;
      pattern?: string;
    };
  }>;
  formConfig?: {
    title?: string;
    description?: string;
    submitLabel?: string;
    confirmation?:
      | {type: 'message'; message: string}
      | {type: 'redirect'; redirectUrl: string};
    acceptingResponses?: boolean;
    closedMessage?: string;
    maxResponses?: number;
  };
}
```

For a form view, `visiblePropertyIds` is deliberately stricter than its legacy
meaning on row layouts: only explicitly listed property ids are fields, and
their array order is display and validation order. Missing or empty means no
fields, not all columns. `defaultView('form', ...)` writes an explicit list of
`TITLE_PROPERTY_ID` first, followed by all current v1-writable, non-reserved
properties, plus an empty `formFields` and `acceptingResponses: true`.

`TITLE_PROPERTY_ID` (`'title'`) is the one virtual field: it is not present in
`schema.properties`, but it is explicitly mapped first in new form views so
out-of-the-box submissions create titled rows. F-2 may reorder/remove it and
configure ordinary text-field metadata for it. When mapped, the validator
treats it as text and returns it as the row `name`; it never appears in the
validated property record.

`formFields` is presentation/validation metadata only. An entry not present in
`visiblePropertyIds`, not the title, not present in the current schema, or no
longer writable is ignored. Property name, type, options, date configuration,
and number/rating configuration are always read live from `DatabaseProperty`.
An optional `formFields[id].label` is a deliberate display override; without
it, a column rename immediately renames the form field. A retype immediately
changes both the builder control and server validation. `multiline` applies to
text controls. `validation` has parity with the legacy standalone field shape
and its min/max, length, and safe-pattern constraints are enforced server-side,
not only in F-2/F-3 clients.

Display defaults are `view.name` for `formConfig.title`, `Submit` for
`submitLabel`, and a product-standard message confirmation for `confirmation`.
Only `acceptingResponses === true` accepts a public fill; this is fail-closed
for malformed/hand-authored persisted data. Setting it false closes the form
but does not unpublish it or revoke read access. `maxResponses` is a per-view
ceiling; when absent it resolves to the shipped legacy
`FORM_SUBMISSION_DEFAULT_MAX_SUBMISSIONS` default (currently 10,000), keeping
one abuse ceiling across both form systems.

The capability-gated public response is frozen as the strict
`DatabaseFormDescriptor` projection below:

```ts
interface DatabaseFormDescriptor {
  title: string;
  description: string;
  submitLabel: string;
  acceptingResponses: boolean;
  closedMessage?: string;
  fields: Array<{
    propertyId: string;
    type: FormWritablePropertyType;
    label: string;
    help: string;
    required: boolean;
    placeholder: string;
    multiline?: boolean;
    validation?: {
      min?: number;
      max?: number;
      minLength?: number;
      maxLength?: number;
    };
    options?: DatabaseSelectOption[];
    includeTime?: boolean;
    dateRange?: boolean;
    numberTarget?: number;
  }>;
}
```

`projectDatabaseFormDescriptor(schema, view)` is the only SDK projection path.
It returns `null` for a non-form view, follows only the explicit live writable
mapping (including the virtual title), defensively copies mapped options, and
returns exactly the keys above. `multiline` lets the public renderer select a
textarea. Only the display-safe validation subset (`min`, `max`, `minLength`,
and `maxLength`) is projected. `pattern` remains server-enforced but is withheld
to avoid advertising the regex; validation failures still report the stable
`pattern` error code. The projection MUST NOT serialize `DatabaseSchema`, an
unmapped column or its options, filters, sorts, formulas, internal column copy,
the server-only pattern, confirmation/cap state, response counts, or any other
schema/view data. `closedMessage` is included only when the form is closed and
custom closed copy exists.

## 3. Field creation, mapping, and cleanup

F-2 must apply the following mutations atomically in one database-schema update.

Mapping an existing column appends its property id to the form view's
`visiblePropertyIds` (or inserts it at the chosen index) and optionally creates
its `formFields[id]` metadata. The property itself remains the source of truth.
Mapping `TITLE_PROPERTY_ID` follows the same operation but does not create a
`DatabaseProperty`; it targets the row page name.

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

The virtual `TITLE_PROPERTY_ID` mapping is additionally writable as `text`; it
is not a 25th `DatabasePropertyType` and does not change the exhaustive map.

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
  ∩ (
      TITLE_PROPERTY_ID as text
      ∪ (current schema.properties ids ∩ v1 form-writable types)
    )
  − reserved sys_* ids
```

The function rejects a non-form view, a non-object payload, and every submitted
key outside that allowlist. It validates each allowed value against the current
property shape/options and the mapped server-side `validation` metadata. It
returns either `{ok:true, name?, fields}` with a fresh, allowlisted property
record, or `{ok:false, errors}`. When title is mapped, `name` is always populated
with its validated string or `''` for an optional empty title, and `fields`
never contains the title key. When title is not mapped, `name` is absent. The
function never coerces numeric strings, partially persists valid fields, or
trusts `formFields` as a property schema.

For required fields, absent, `null`, a blank string for any property type, an
empty choice/file array, and an empty configured date range are empty. This
ordering ensures a blank required number reports `required`, not `type`.
Numeric zero and checkbox `false` are valid present values. Optional empty
properties are omitted from successful `fields`; optional empty mapped title
becomes `name: ''`. Stable error codes are exported as
`FORM_ROW_VALIDATION_ERROR_CODES`, including `min`, `max`, `minLength`,
`maxLength`, `pattern`, and the route-limit code `too_large`; user-facing copy
belongs to F-2/F-3.

File strings pass the pure shape check only. Before row creation, F-4 must bind
and atomically claim every token to this form capability using the existing
staged-upload rules, replace it with the retained asset URL, and reject an
unknown, expired, already-consumed, or cross-form token.

`FORM_DATE_TIME_RE` permits offset-less datetimes, which parse in the host's
local timezone; mixed offset/no-offset ranges can therefore validate differently
in the client and server, so authors should include explicit offsets.

## 6. Fill capability and routes (F-4)

The frozen capability-carrying endpoints are:

```text
POST /api/databases/:databaseId/views/:viewId/form
POST /api/databases/:databaseId/views/:viewId/submissions
```

Both are intentionally unauthenticated. The descriptor endpoint is exposed as
`API.databaseForm(databaseId, viewId)` and takes a
`DatabaseFormDescriptorRequest` JSON body, never a query-string capability:

```ts
{capability: string}
```

It validates the capability and publication binding up front through the same
step-3 deny door as submission, then returns
`projectDatabaseFormDescriptor(database.schema, view)`. A valid capability can
therefore fetch a closed descriptor with `acceptingResponses: false` and its
optional `closedMessage`; a closed form is not treated as missing.

The submission endpoint is exposed as
`API.databaseFormSubmissions(databaseId, viewId)`. Its JSON body is
`DatabaseFormSubmissionRequest`:

```ts
{
  capability: string;
  fields: Record<string, unknown>;
  idempotencyKey: string; // 128-bit shape: v4 UUID or ≥22 base64url chars
}
```

The capability grants descriptor read and row creation through this exact form
view only. It grants no database/page read, general database write, schema edit,
or publish right. It is a cryptographically random 256-bit unpadded base64url
token. Publication state owns it, not `DatabaseView`: persist only a SHA-256
digest keyed by `(databaseId, viewId)`, compare in constant time, and
return/expose the raw token only as part of the form's public URL. The public URL
should carry it in a URL fragment (`#capability=...`) so it is not sent in
navigation requests; the form runtime copies it into POST bodies. Do not place
it in query strings, logs, analytics, block props, or the database schema.

There is at most one active public-fill capability per `(databaseId, viewId)`.
First publish mints it; rotate/revoke replaces or removes the digest. Every F-3
embedding resolves the same publication record: an embedding block never mints
a capability and never stores or carries the raw token. Revoking the one active
capability disables every embedding and public URL that used it. Deleting a form
view revokes its record. Duplicating a form view creates a new `view.id` and MUST
NOT copy or alias publication state; publishing the duplicate mints a new
capability. Copying display configuration and field mappings is allowed.

Form publish is its own explicit action. It does not publish or unpublish the
host page or database, and page/database publish changes do not publish,
unpublish, rotate, or revoke the form. In particular, unpublishing a page does
not silently keep-or-kill a form link as a side effect: the link is independent,
and only explicit rotation/revocation of its form capability kills it.

The submission route order is normative:

1. Check the pre-authentication peer meter before parsing the body or matching
   the capability. An exhausted peer returns
   `429 {"error":"rate limit exceeded"}` before parse/auth. This supersedes the
   earlier rule that all rate limits run only after a valid capability match.
2. Parse the bounded JSON envelope and require the existing non-simple client
   header/CSRF posture used by public forms.
3. Load `databaseId` and `viewId`; require a current form view, an ordinary
   non-managed database, an active matching capability, and the publication
   binding. Missing or deleted database/view/publication, managed database, and
   wrong-token states for a non-exhausted peer return identical
   `404 {"error":"form not found"}` bytes so the route is not an existence
   oracle. The descriptor fetch uses this identical step before projecting any
   data.
4. Only after a valid capability match, reject
   `acceptingResponses !== true` with the distinct
   `403 {"error":"form_closed"}`. Then apply the capability-scoped rate,
   body, field-count, value-size, upload, and idempotency limits plus the
   per-view `maxResponses` ceiling. An absent ceiling uses
   `FORM_SUBMISSION_DEFAULT_MAX_SUBMISSIONS`; the count is derived from active
   rows whose durable form marker names this `viewId`. Exhaustion returns `429 {"error":"response limit reached"}`.
5. Run `validateRowAgainstForm(database.schema, view, body.fields)`. Validation
   failure returns `400` with the machine-readable errors and creates nothing.
6. Claim/resolve file tokens, then create exactly one row with
   `name: validation.name ?? ''` and the validated property record. In the
   existing reserved page-property convention, the same atomic create stamps
   `[FORM_SUBMISSION_PROPERTY_ID]: {submittedViaViewId: viewId, submittedAt}`.
   This marker is durable per-row provenance, not client-supplied data; F-2 uses
   it for per-form response counts and F-4 MUST NOT omit it. The write principal
   is synthetic, with `subject: "form:<viewId>"`; it is attribution for this one
   operation, not a generally authorized guest principal.
7. Scope `idempotencyKey` to this capability/view. A replay returns the original
   `FormSubmissionResult` (`rowId`, `submittedAt`) with `201` and does not create
   another row or restamp provenance.

`FORM_SUBMISSION_PROPERTY_ID` carries two distinct marker shapes. Legacy
standalone-form rows use `{formId, submittedAt}`; database-view form rows use the
exported `DatabaseFormSubmissionMarker` shape
`{submittedViaViewId, submittedAt}`. F-2's counter must accept only the latter
with a matching `submittedViaViewId`, and F-4's writer must stamp that same SDK
type, so legacy rows are never attributed to a database form view.

Capability validation and current-schema validation occur on every request.
The client may render a stale builder snapshot, but the server result always
reflects the current database contract.

**Row title (normative, v1):** when `TITLE_PROPERTY_ID` is mapped, F-4 validates
it as a normal text field (including required and validation metadata) and
passes the resulting `name` to `createRow`. When title is unmapped, the validator
does not accept a title key and F-4 creates the row with the explicit empty name
`''`; it never derives a title from another answer.

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
  with `403 {"error":"form_closed"}` after a valid capability match, without
  deleting submissions, field configuration, publication, or descriptor access.
  An exhausted pre-authentication peer still receives `429` before this check.
- **Concurrent schema edits:** the form builder and table-header controls each
  send a full schema blob. `updateDatabase` replaces that blob through SQL
  `COALESCE`, so overlapping saves are last-writer-wins: a builder field edit
  can clobber a concurrently saved header rename, or the rename can clobber the
  field edit. Refresh before reapplying the missing change. A schema-version
  guard is intentionally outside this contract.

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

- New form views explicitly map `TITLE_PROPERTY_ID` first, followed by all
  current v1-writable, non-`sys_*` columns, and accept responses; they are not
  public until separately published.
- That default mapping deliberately includes `pageHidden` columns created for
  other forms. `pageHidden` stores no creating-form provenance, so the builder
  cannot truthfully label only those fields “mapped from another form”; no hint
  chip is added. Authors can remove an unwanted mapping without deleting its
  shared column or archived values.
- Missing/invalid mapping, acceptance state, capability state, view type, or
  property type fails closed.
- A missing `maxResponses` uses
  `FORM_SUBMISSION_DEFAULT_MAX_SUBMISSIONS` (10,000); the counter is per form
  view and is backed by the durable `FORM_SUBMISSION_PROPERTY_ID` marker.
- Relation, dependency, person, and verification controls are deferred from
  public v1 for the authority reasons in the table; their columns can still be
  displayed in ordinary database views.
- Capability persistence is deliberately server publication state rather than
  schema/block data. F-4 owns the digest record and fill-route gate; F-2/F-3
  consume only the public URL and `DatabaseFormReference`.
- Removing a form field never auto-deletes its column. Destructive cleanup is an
  explicit column action routed through `removeProperty`.
- The legacy standalone form block remains supported alongside database-view
  forms. Migration is deferred; new embeds use the F-3 reference path.

## 10. Review gates for F-2/F-3/F-4/F-5

- F-2: field reorder/inclusion changes only `visiblePropertyIds`; field edits
  mutate `DatabaseProperty`; retype warnings and unknown-view fallback are
  covered by UI tests. Publishing MUST show an explicit review that enumerates
  every field becoming publicly writable and specifically calls out mapped
  `select`, `status`, and `checkbox` columns.
- F-2: the builder rejects syntactically invalid or `formPatternIsUnsafe`
  `validation.pattern` values at authoring time; respondents must never see
  author mistakes surfaced as `pattern` errors.
- F-2/F-3: if a mid-flight schema change produces `unknown_field`, the client
  re-fetches the capability-gated descriptor and preserves the filler's typed
  answers while reconciling the changed field mapping.
- F-3: a new embedding block persists only `DatabaseFormReference`, renders no
  database surface in form-only publication mode, never mints a capability, and
  does not expose or carry a raw capability in page/block JSON. This gate does
  not alter the legacy standalone form block.
- F-4: capability isolation/rotation/duplicate-view tests, oracle-equivalent
  404s, closed-form 403 after valid-capability tests, descriptor no-leak tests,
  managed-database refusal, current-type/title race tests, strict allowlist and
  required/validation tests, upload binding, durable view provenance, synthetic
  author attribution, response/rate/body limits, and idempotent replay all pass
  before enabling the public route.
- F-5: publication storage and the single active capability are keyed by
  `(databaseId, viewId)`; every embedding resolves that record. Publish, rotate,
  revoke, duplicate-view, and delete-view tests prove that blocks never mint or
  retain raw tokens, revocation disables all embeddings, and form/page/database
  publication states never mutate one another in either direction. A page
  unpublish must leave the independent form link unchanged until that form's
  capability is explicitly rotated or revoked.
