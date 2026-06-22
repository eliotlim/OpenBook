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

Then register the binary with your MCP client. `OPENBOOK_URL` points at the workspace (defaults to `http://127.0.0.1:4319`, the desktop app's local server).

Claude Code:

```sh
claude mcp add openbook --env OPENBOOK_URL=http://127.0.0.1:4319 -- node <repo>/packages/mcp/dist/bin.js
```

Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "openbook": {
      "command": "node",
      "args": ["<repo>/packages/mcp/dist/bin.js"],
      "env": {"OPENBOOK_URL": "http://127.0.0.1:4319"}
    }
  }
}
```

The server exits with a clear message if no OpenBook server is reachable at startup.

## Development

```sh
pnpm --filter @book.dev/mcp test:e2e   # handshake + every tool against a real embedded server
pnpm --filter @book.dev/mcp typecheck
```

The integration test (`scripts/e2e.mts`) boots an embedded-PGlite OpenBook server, seeds pages and a database, then drives `src/bin.ts` over stdio as a real MCP client — including the failure modes (missing page, duplicate title, the collaborative-editor append guard).

## Design notes

- Tool implementations share the SDK's content helpers (`snapshotText`, `textSnapshot`, `appendTextToSnapshot`) with the in-app agent harness, so both surfaces read and write pages by the same rules.
- Results are plain text formatted for models (`- [id] title: snippet` lines); errors return `isError: true` with a human-readable reason rather than throwing.
