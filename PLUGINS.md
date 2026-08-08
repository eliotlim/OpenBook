# OpenBook Extensions

Extend OpenBook with plugins written in TypeScript: custom blocks for the
editor, commands for the palette, and integrations over the workspace API.
Think VS Code extensions, sized for a local-first notes app.

## Anatomy

A plugin is a **zip of TypeScript source** with a manifest:

```
my-plugin/
  openbook.json        ← the manifest
  src/index.ts         ← the entry (manifest.main)
  src/anything-else.ts
  signature.json       ← optional, added by a registry
```

```json
{
  "id": "acme.my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "description": "What it does, in a sentence.",
  "author": "Acme",
  "icon": "🧩",
  "main": "src/index.ts"
}
```

The entry default-exports `activate(api)`:

```ts
import {api} from '@book.dev/plugin-sdk';
import {MyBlock} from './block';

export default function activate(a: typeof api) {
  a.blocks.register({
    type: 'widget', // becomes "acme.my-plugin/widget"
    render: MyBlock, // a React component over CRDT block props
    slash: {label: 'My widget', hint: 'Inserted from the / menu', keywords: 'widget', make: () => ({type: 'acme.my-plugin/widget', props: {}})},
  });
  a.commands.register({id: 'do-thing', title: 'Do the thing', run: () => { /* … */ }});
  // a.pages.list/get/create — workspace access for integrations
  // a.databases.*           — typed database read/subscribe (see below)
  // a.assets.get/put        — content-addressed binary assets (see below)
  // a.storage.get/set       — plugin-scoped persistence
  // a.fetch                 — network access
}
```

Imports resolve **inside the zip** (relative paths, `.ts/.tsx/.js/.json`),
plus two host modules: `react` and `@book.dev/plugin-sdk`. Other bare
imports are refused — bundle what you need into the zip. Types are stripped
at load time (no typechecking); develop against your own `tsc`.

## Data access: databases & assets

Plugins get a **typed, read-only** view of library databases and the binary
asset store — the same data a plugin could always reach by hand-rolling
`api.fetch` calls, now with types. Access runs on the signed-in user's
ambient credentials, exactly like `pages.*` and `fetch`: no new privilege,
and every read gate still applies.

```ts
import {api} from '@book.dev/plugin-sdk';

export default function activate(a: typeof api) {
  a.commands.register({
    id: 'sum-first-column',
    title: 'Sum the current page database',
    run: async () => {
      const db = await a.databases.getByPage(somePageId); // or a.databases.get(databaseId)
      if (!db) return;
      const rows = await a.databases.listRows(db.id); // DatabaseRow[]: properties + exports

      // Live updates: returns unsubscribe, AND is torn down automatically
      // when the plugin is disabled/removed/reloaded — no leaked handlers.
      const stop = a.databases.subscribeRows(db.id, (rows) => console.log(rows.length));

      // Assets are content-addressed: the id IS the SHA-256 of the bytes, so
      // a byte-identical put dedups to the same id.
      const {id} = await a.assets.put(new TextEncoder().encode('hi'), 'text/plain', db.pageId);
      const asset = await a.assets.get(id); // {bytes, mime} | null (missing and unreadable answer alike)
      void asset;
      void stop;
    },
  });
}
```

There are deliberately **no row/schema writes** in this surface yet — write
APIs wait for a capability/permission model.

## The ledger: `api.ledger.*`

Plugins get the full typed client for the server-enforced double-entry
ledger — `info`/`init`, account CRUD, draft create/update/delete, atomic
`post`, `reverse`, cleared-state, all delegating over the same ambient
credentials as everything above. Invariant violations reject with the typed
`LedgerError` (import it from `@book.dev/plugin-sdk` to `instanceof`-match).
Amounts are **signed integer minor units** end to end: parse user text with
`parseAmount` and render with `formatAmount` — the money core is exported
from `@book.dev/plugin-sdk` too, so plugin and host share one grammar and
never touch floats. For live updates, subscribe to the seeded databases
(`(await api.ledger.info()).databases.accounts` etc.) with
`api.databases.subscribeRows` — automatically torn down with the plugin.

`examples/plugins/ledger` is the reference: the journal entry block (the
books' only human write surface), the two read-only report blocks (trial
balance and account register), and an idempotent "Ledger: set up books"
command.

Reports are **plugin-rendered**, not formula-driven: `expr`/rollup cannot
aggregate across database rows (`docs/ledger/platform-audit.md`), so the
plugin reads transactions through `api.ledger.listTransactions` and folds
them in JS. Keep that arithmetic in a pure, dependency-free module —
`src/reports.ts` is the pattern — and let the block render only what the fold
returns. That is what makes it unit-testable, and it is the only way the
money rule ("no `Number()`, `parseFloat`, `Math.*` or `+`/`-` on an amount
outside the fold") stays enforceable.

## API versioning

The plugin API carries a single integer version (`PLUGIN_API_VERSION`,
currently **2**: v1 was blocks/commands/pages/storage/fetch; v2 added
`databases.*` + `assets.*`). Declare the version your plugin needs in the
manifest:

```json
{ "id": "acme.my-plugin", "…": "…", "apiVersion": 2 }
```

The field is optional — omitting it means v1 is enough, and every existing
plugin keeps loading unchanged. A plugin declaring a **newer** version than
the host provides fails activation with a clear "update OpenBook" error
(shown in Settings → Extensions) instead of crashing on a missing surface.

## Installing

Settings → **Extensions** → *Install from .zip*. The plugin is stored
server-side, so every client of the workspace runs it. Disable or remove any
time; contributions tear down cleanly.

## Author a plugin in a page

A page can *be* a plugin — no toolchain required. Give code blocks a
**name** (the field next to the language in the block's footer) and each
named block becomes a file: name one `openbook.json` for the manifest,
another `index.ts` (or whatever `main` says) for the entry. Once the page
has an `openbook.json` block, **Page actions → Export → Plugin (.zip)**
produces the install-ready package — prose, headings, and *live* code
blocks stay out of it (a live block's name is a reactive output, not a
filename). Round-trip it straight back in through Settings → Extensions.

## Signing & registries

Registries vouch for plugins with an **Ed25519 signature** over a canonical
SHA-256 digest of the manifest + files. A package signed by a registry whose
key you trust shows a green **Verified** badge; anything else (unsigned,
unknown key, or content that doesn't match the signature) shows
**Unverified** but installs fine.

- The first-party **OpenBook Registry** key ships pinned in the app.
- A third-party registry is just another trusted key: add its name and
  base64 Ed25519 public key under **Settings → Extensions → Trusted
  registries**. Removing a key demotes its plugins to Unverified on the
  next sync.
- Pack and sign locally (signing always takes an explicit key; the committed
  test key is trusted nowhere by default — see `docs/plugin-signing.md`):
  `node scripts/pack-plugin.mjs examples/plugins/hello-openbook out.zip --sign --key scripts/test-registry-key.json`

**Trust model, plainly:** extensions run with the same privileges as your
documents' live code. A signature is provenance — *who published these exact
bytes* — not a sandbox.

## The example

`examples/plugins/hello-openbook` is the reference: a custom block with a
working counter (CRDT props through React) and a palette command, in
multi-file TypeScript. Pack it, install it, read it.
