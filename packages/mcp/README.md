# @book.dev/mcp

An [MCP](https://modelcontextprotocol.io) server that lets any MCP client — Claude Desktop, Claude Code, or your own agent — read and write an OpenBook workspace.

It speaks stdio and talks to a running OpenBook server over the same `@book.dev/sdk` HTTP contract the apps use, so it works against the desktop app's embedded server, a `pnpm dev` instance, or a headless deployment. No AI engine is required: `search_notes` falls back to keyword (BM25) ranking and upgrades to semantic ranking when the server has a model configured.

## Tools

| Tool | What it does |
| --- | --- |
| `list_pages` | List workspace pages (id + title), most recently updated first. |
| `read_page` | Read one page's title and full text. |
| `search_notes` | Ranked search with snippets over every page's content. |
| `create_page` | Create a page from a title and plain-text body. |
| `create_artifact_page` | BUILD an interactive page from kit blocks — named inputs (steppers, sliders, radios, checklists, toggles) feeding live charts, status lights, and formulas. The MCP-native way to make the calculators/dashboards an AI would otherwise hand-code. |
| `upload_asset` | Upload a raster image (or inert binary for `htmlArtifact`) and return its `assetId`. Requires direct-write policy; bytes never enter suggestions. |
| `append_to_page` | Append paragraphs to an existing page (refuses pages owned by the collaborative editor). |
| `inspect_page_structure` | Show a page's block TREE — ids, types, short text, props — including nested blocks. Read this before editing blocks. |
| `append_blocks` | Append typed blocks to a block-editor page. Blocks **nest**: a container carries its contents in `children`, so one call builds a whole table (`table → row → cell`) or a two-column layout (`columns → column`). Capped at 8 levels / 400 blocks per call. |
| `insert_blocks` | Insert recursive blocks at a precise root/container `index` or after a sibling id. The destination must accept children; insertion into `table` / `row` / `cell` is refused in favour of `table_*` tools. Uses the same 8-level / 400-block caps as `append_blocks`. |
| `move_block` | Reorder or reparent a block by destination `index` or sibling id. Refuses unknown ids, cycles, invalid containers, and every move into/out of/within `table` / `row` / `cell` (use `table_*` tools). |
| `update_block` | Replace one block's text (by id). |
| `update_block_props` | Shallow-merge one block's props (heading level, todo checked, callout variant, code language, image alt, a kit input's value/min/max). A `null` value **removes** that prop. Works on nested blocks. |
| `delete_block` | Remove one block and everything inside it, at any depth — including a table `row` or `cell`. |
| `inspect_table` | Show a table in **render order** — size, header flag, column ids, and every row/cell id with its text. Read this before any `table_*` call: the indices it prints are the coordinates those tools take, and the ids it prints are what they address. |
| `table_insert_row` / `table_delete_row` / `table_duplicate_row` | Row structure. Insert takes the position the new row should occupy; it is refused at position 0 on a table with a header row (rendering is positional, so the blank row would become the header). Deleting the last row removes the whole table. |
| `table_insert_column` / `table_delete_column` | Column structure. Deleting the last column removes the whole table. |
| `table_move_row` / `table_move_column` | Reorder by rewriting one order key — cells are untouched, so concurrent edits inside the moved line merge cleanly. `toIndex` counts positions with the moved line removed. |
| `table_set_cell` | Replace one cell's text, by row+column index or by cell id. |
| `table_set_row_color` / `table_set_column_color` | Tint a row or column (a palette token, or `null` to clear). A row tint wins over a column tint. |
| `list_database_rows` | List the rows of the database hosted on a page. |
| `create_database_row` | Add a row (title + property values) to a hosted database. |

### Images via MCP

1. On suggest-mode installs, call `request_edit_access` first; uploads apply immediately and cannot be queued as suggestions.
2. Call `upload_asset` with `pageId`, an image `mime`, and `base64` bytes.
3. Copy the returned `assetId`; the payload itself is never echoed.
4. Call `append_blocks` with `{"type":"image","props":{"assetId":"…","alt":"…","width":"60%"}}`.
5. Later use `update_block_props` to change `alt` or `width`.
6. For sandboxed HTML, upload as `application/octet-stream` and append `htmlArtifact` with `{assetId,name,height}`.

Table coordinates are **render order** (the sorted order you see), not positions in
the stored array — a reordered table's arrays are not in display order. Tables built
by `append_blocks` carry no order keys (a client cannot invent them), so
`inspect_table` reports them as *unmigrated*; the first `table_*` op assigns keys
deterministically, matching what the editor would have assigned, without changing
what you already saw. These tools are the only way to write those keys —
`update_block_props` refuses `ord` / `col:` / `colbg:`.

### Rich text input

Every block-text write (`update_block`, block `text` in `append_blocks` and
`insert_blocks`, and `table_set_cell`) accepts a string or explicit editor runs.
Strings use a small markdown subset: `**bold**`, `*italic*` or `_italic_`,
`` `code` ``, `~~strike~~`, and `[label](https://example.com)`. Backslash escapes
marker punctuation. Unbalanced/unknown markers stay literal. Links allow only
`https`, `http`, and `mailto`; `javascript:` and `data:` are rejected.

Explicit runs use the blockdoc shape `{"runs":[{"t":"bold","a":{"b":true}}]}`.
Allowed attributes are `b` (bold), `i` (italic), `u` (underline), `s` (strike),
`c` (code), and `a` (safe link URL). Unknown attributes are rejected and adjacent
equal-format runs are merged. Set `plain: true` beside `text` to store a string
literally, for example `{"text":"**not bold**","plain":true}`. `[[Page Title]]`
stays literal: mention runs need a page ID, which cannot be resolved from a title
without a database lookup.

## Setup

The in-app Settings card uses the HTTP transport; the stdio setup below is the source-checkout/development route and authenticates as an unauthenticated guest rather than with a scoped token.

Build once from the repo root:

```sh
pnpm install && pnpm build:libs && pnpm --filter @book.dev/mcp build
```

Then register the binary with your MCP client.

- `OPENBOOK_URL` points at the workspace. It defaults to `http://127.0.0.1:4319`, the desktop app's local server — but the packaged desktop app only opens that loopback port **while the local-MCP/agent toggle is ON** (Settings → Agents & AI admin → Enable agent API). With the toggle off the app is reachable only over its private IPC socket, and nothing of the app listens on 4319. Note the delta: unlike the FS-permissioned IPC socket, the loopback port — once the toggle is ON — is reachable by any local process, so it is a real added surface, which is why it is gated behind an explicit opt-in. Cross-origin BROWSER reachability is now closed (STAB-8): the sidecar reflects CORS `Access-Control-Allow-Origin` only for the app's own webview / loopback dev origins (a foreign web page gets no readable response), and an unauthenticated guest WRITE must carry the first-party `X-OpenBook-Client` header — which a cross-origin browser simple-request cannot attach — so a random web page can no longer read or write the local library. The MCP connector (like every first-party client) sends that header automatically via the sdk transport; you do not set it yourself.
- `OPENBOOK_INSTANCE_ID` (recommended) is this library's stable id. When set, the connector verifies the server it reached advertises the **same** id and refuses to adopt anything else — so a stray responder on port 4319 (a leftover `pnpm dev` with its own data dir, a different app) is rejected with a clear error instead of silently reporting your real pages as "nonexistent". Find a library's id at `GET /api/instance` (`instanceId`).

The connector always talks to your default local library, even if you switch libraries in the app.

Claude Code:

```sh
claude mcp add openbook \
  --env OPENBOOK_URL=http://127.0.0.1:4319 \
  --env OPENBOOK_INSTANCE_ID=<your-library-id> \
  -- node <repo>/packages/mcp/dist/bin.js
```

Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "openbook": {
      "command": "node",
      "args": ["<repo>/packages/mcp/dist/bin.js"],
      "env": {
        "OPENBOOK_URL": "http://127.0.0.1:4319",
        "OPENBOOK_INSTANCE_ID": "<your-library-id>"
      }
    }
  }
}
```

At startup the connector performs a single `GET /api/instance` handshake (guest-readable, leaks no secret). It exits with a clear message if no OpenBook server is reachable, or if the server at `OPENBOOK_URL` reports a different `OPENBOOK_INSTANCE_ID` than configured (a foreign responder / port conflict).

## Direct edits vs. reviewable suggestions

Whether a write tool (`append_to_page`, `append_blocks`, `insert_blocks`, `move_block`, `update_block`, `update_block_props`, `delete_block`, every `table_*` op, `set_kit_value`, `set_db_cell`) changes a page **immediately** or lands as a **reviewable suggestion** is decided per write by the library's agent-edits policy — not by the connector. The policy ships as **Suggest** (safe: nothing lands until a human accepts it in the review pane) and is changed in the app under **Settings → Agents & AI admin**, with a per-page override in the page's **Customise** pane. Creating a page or a database row is non-destructive and always applies. See [`docs/agent-edits.md`](../../docs/agent-edits.md) for the full model.

The server is the authoritative gate: a suggest-mode direct write is refused at the REST layer regardless of what the tool attempts, and every direct write an agent token makes is attributed to that token in the page's edit log. The library default governs remote tokens too: a page pinned to **Direct** applies remote MCP writes immediately, and a page that inherits the library default follows that default — so with the library set to Direct, a remote token writes an inheriting page directly. The connector reads the server-resolved effective mode from the per-page agent-edits route, so it never needs the privileged instance setting.

## Development

```sh
pnpm --filter @book.dev/mcp test:e2e   # handshake + every tool against a real embedded server
pnpm --filter @book.dev/mcp typecheck
```

The integration test (`scripts/e2e.mts`) boots an embedded-PGlite OpenBook server, seeds pages and a database, then drives `src/bin.ts` over stdio as a real MCP client — including the failure modes (missing page, duplicate title, the collaborative-editor append guard).

## Design notes

- Tool implementations share the SDK's content helpers (`snapshotText`, `textSnapshot`, `appendTextToSnapshot`) with the in-app agent harness, so both surfaces read and write pages by the same rules.
- Results are plain text formatted for models (`- [id] title: snippet` lines); errors return `isError: true` with a human-readable reason rather than throwing.
