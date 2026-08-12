# Forms

A form is an interactive block that collects structured answers into an
OpenBook database. You build it on an ordinary page, publish that page, and
visitors fill it in from the locked (read-only) page without receiving general
edit access to your library.

## Build a form

Insert a **Form** from the slash menu. The builder has a field palette on the
left and the ordered form canvas on the right. Drag a field into the canvas, or
click it to append; drag existing fields to reorder them. Keyboard users can
move a focused field with Alt/Option or Command plus the arrow keys.

The available field kinds are short text, long text, number, select,
multi-select, checkbox, date, email, phone, URL, rating, and files. Each field
has a stable ID, a reader-facing label, required/optional state, and compatible
validation controls. Select fields also have stable option IDs. The **Advanced**
section can mark a hidden honeypot field for basic bot filtering.

Open the block settings to change the submit-button label, success message or
safe HTTP(S) redirect, and whether the form currently accepts responses. Turning
**Accept submissions** off leaves the form visible but closes it to new
responses.

## Bind responses to a database

Public submissions can write only to a database hosted by the same page as the
form. In the form settings, choose that page's **Submission database**, or use
**Create a new database** to add and bind one to the current page. This same-page
rule is a security boundary: changing form data cannot turn a public form into a
write path for an unrelated database.

For each field, choose a compatible database property. **Auto-create a
compatible column** previews the proposed property; **Save database changes**
creates the selected columns and records their IDs in the form. Fields without
a bound column are validated but are not written to the response row.

## Publish and control access

Open **Share** on the form's page and set **Who can access** to **Anyone with the
link**. On desktop, publish the library and make sure its address serves
**Published pages** (or is fully public). The Share dialog shows **This page
accepts public submissions** for an enabled form and explains whether signed-out
visitors can actually reach it.

The page remains locked for visitors: they can fill the live form but cannot
edit its blocks or database. Page access still wins over the form capability.
A restricted page is not anonymously submittable, and **Guest access: Off**
returns a 404 to signed-out visitors even when both the page and published
address are public.

The submission key is managed in the form's settings and is never shown in the
Share dialog or MCP reads. Regenerating it immediately stops the current public
link and existing embeds from accepting submissions, so rotate it only when you
intend to invalidate them.

For the exact capability and access-control contract, see
[§9 of the sharing/access contract amendment](sharing-access-contract-spike-OB-182.md#9-form-1--page-scoped-form-submission-capabilities).

## Receive submissions

Each accepted submission creates one row in the bound database. Open the
database footer on the form page to review, filter, or export responses like any
other database rows. Retries use an idempotency key, so replaying the same
request returns the original result instead of adding a duplicate row.

Validation runs in the browser for quick feedback and again on the server before
anything is stored. Invalid, disabled, full, inaccessible, or incorrectly bound
forms fail closed. A honeypot response gets an ordinary success screen but does
not create a row.

## File uploads and limits

A files field stages uploads before the row is submitted. An upload becomes a
normal retrievable OpenBook asset only when the successful submission claims
it; unused staged uploads expire and are cleaned up.

Current limits are:

- 5 MiB per file;
- 5 files per submission;
- 10 MiB of concurrently staged files per form;
- 50 MiB of retained submitted files per form; and
- 30 minutes before an unclaimed staged upload is eligible for cleanup.

The shared source of truth is
[`packages/sdk/src/forms.ts`](../packages/sdk/src/forms.ts). The server also
rate-limits upload and submit attempts together. File downloads are served with
safe attachment headers and remain subject to the page's read access.

## Edit forms with MCP

OpenBook's MCP server exposes `list_forms`, `get_form_schema`,
`update_form_field`, `set_form_settings`, and `list_form_submissions`. An agent
can discover forms, inspect ordered fields, add/update/remove/reorder fields,
change ordinary settings, and read response rows.

MCP follows the page's [agent-edits policy](agent-edits.md): the safe default is
to record a reviewable suggestion rather than mutate the form immediately.
Submission keys are recursively redacted from tool results, cannot be changed by
MCP, and remain an author-only UI action.
