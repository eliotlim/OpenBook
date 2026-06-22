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
  // a.storage.get/set      — plugin-scoped persistence
  // a.fetch                — network access
}
```

Imports resolve **inside the zip** (relative paths, `.ts/.tsx/.js/.json`),
plus two host modules: `react` and `@book.dev/plugin-sdk`. Other bare
imports are refused — bundle what you need into the zip. Types are stripped
at load time (no typechecking); develop against your own `tsc`.

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
- Pack and dev-sign locally:
  `node scripts/pack-plugin.mjs examples/plugins/hello-openbook out.zip --sign`

**Trust model, plainly:** extensions run with the same privileges as your
documents' live code. A signature is provenance — *who published these exact
bytes* — not a sandbox.

## The example

`examples/plugins/hello-openbook` is the reference: a custom block with a
working counter (CRDT props through React) and a palette command, in
multi-file TypeScript. Pack it, install it, read it.
