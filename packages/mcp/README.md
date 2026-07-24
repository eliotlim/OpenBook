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
| `append_to_page` | Append paragraphs to an existing page (refuses pages owned by the collaborative editor). |
| `list_database_rows` | List the rows of the database hosted on a page. |
| `create_database_row` | Add a row (title + property values) to a hosted database. |

## Setup

Build once from the repo root:

```sh
pnpm install && pnpm build:libs && pnpm --filter @book.dev/mcp build
```

Then register the binary with your MCP client.

- `OPENBOOK_URL` points at the workspace. It defaults to `http://127.0.0.1:4319`, the desktop app's local server — but the packaged desktop app only opens that loopback port **while the local-MCP/agent toggle is ON** (Settings → Agents & AI admin → Enable agent API). With the toggle off the app is reachable only over its private IPC socket, and nothing of the app listens on 4319. Note the delta: unlike the FS-permissioned IPC socket, the loopback port — once the toggle is ON — is reachable by any local process AND by any web origin the browser will POST to (the sidecar serves wildcard CORS and guestAccess defaults to `write`), so it is a real added surface. That is why it is gated behind an explicit opt-in; browser-reachability hardening is tracked separately.
- `OPENBOOK_INSTANCE_ID` (recommended) is this library's stable id. When set, the connector verifies the server it reached advertises the **same** id and refuses to adopt anything else — so a stray responder on port 4319 (a leftover `pnpm dev` with its own data dir, a different app) is rejected with a clear error instead of silently reporting your real pages as "nonexistent". The desktop app shows the exact snippet, id included, in the same settings panel. Find a library's id at `GET /api/instance` (`instanceId`).

The connector follows your **default local library**. If you switch libraries inside the app (an in-webview override), the out-of-process connector keeps talking to the default local server — it does not follow the switch.

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

Whether a write tool (`append_to_page`, `update_block`, `set_kit_value`, `set_db_cell`) changes a page **immediately** or lands as a **reviewable suggestion** is decided per write by the library's agent-edits policy — not by the connector. The policy ships as **Suggest** (safe: nothing lands until a human accepts it in the review pane) and is changed in the app under **Settings → Agents & AI admin**, with a per-page override in the page's **Customise** pane. Creating a page or a database row is non-destructive and always applies. See [`docs/agent-edits.md`](../../docs/agent-edits.md) for the full model.

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
