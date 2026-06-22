# @book.dev/sdk

The shared contract for OpenBook — imported by the server, the desktop app, and
the web shell so types and the HTTP API can never drift between them.

Exports:

- **Types** — `Page`/`StoredPage`, `PageMeta`, `PageInput`, `PageSnapshot`,
  `ServerInfo`, plus `emptyPageSnapshot()`.
- **`API`** — the route paths (`/api/pages`, `/api/pages/:id`, `/health`). The
  server's router and the client both build URLs from these.
- **`DataClient`** — the storage-agnostic interface the document UI depends on.
- **`HttpDataClient`** — an isomorphic `fetch`-based implementation. The desktop
  points it at its bundled local server; the web shell at a remote one.

No React or Node dependencies — safe to import from any layer.

```ts
import {HttpDataClient, type PageInput} from '@book.dev/sdk';

const client = new HttpDataClient('http://127.0.0.1:4319');
const page = await client.savePage({data: {editorjs: {blocks: []}, values: [], names: []}});
```
