# LAN-hosted web UI (STAB-7)

When you turn on **Local network access** in the desktop app (Settings → Sharing →
_Local network access (advanced)_), the OpenBook sidecar now serves the **full web
app**, not just its `/api`. Anyone on your network can open the address in a plain
browser — no OpenBook install needed:

```
http://<your-lan-ip>:4319/
```

The address is shown in that same panel (with a Copy button). The app it serves is
the ordinary OpenBook web UI, talking to the sidecar's same-origin `/api`, so every
browser on the LAN reads and writes the **one shared library** on your machine (not
a private per-browser copy).

## Access posture: guest-first, no shared secret

The served UI rides the library's **guest access** setting (Settings → Sharing →
_Default access_) — it adds no gate of its own:

| Default access | A LAN browser can… |
| -------------- | ------------------ |
| **Write** (default) | read and edit the shared library |
| **Read**   | read only — writes are refused (403) |
| **Off**    | nothing — reads are refused (401) |

There is **no access token on the LAN web bind** — this is enforced, not just the
default. A LAN publish is deliberately **tokenless**: publishing always serves the web
UI, and the shared-secret gate runs *before* the guest gate, so a token would `401`
every `/api` call the served shell makes and leave an empty page. The desktop never
mints or passes one on publish, and the server refuses to combine a served UI with an
access token at all (`createApp` throws — see `uiDir` × `accessToken` in `app.ts`). The
browser opens straight into the library at whatever your guest-access level allows.
Only turn Local network access on for networks you trust — the on-panel warning says
the same.

> Turning on Local network access requires a **claimed** instance (an owner), matching
> the existing exposure-safety rule for binding beyond loopback.

## Signing in over the LAN — not yet

Account sign-in over a **raw-IP LAN address** (`http://<ip>:4319/`) is **out of scope
for v1**. Browsers treat a plain-HTTP IP origin as an insecure context, which breaks
the identity-JWS flow the account sign-in relies on. Use the LAN UI as a guest; for
per-account identity, use the desktop app or a forwarded `✦.book.cloud` address
(Settings → Sharing → _Publish to the web_), which runs over HTTPS.

## Developing against it

The desktop bundle ships the UI as a Tauri resource and hands the sidecar its path
via `OPENBOOK_UI_DIR` **only while Local network access is on**. To exercise the same
serving path locally without a full desktop bundle:

```bash
# 1. Build the client-only static export and stage it (packages/web/out + the
#    Tauri resource dir). Sets NEXT_PUBLIC_OPENBOOK_SAMEORIGIN=1 for you.
pnpm run build:web-ui

# 2. Start the sidecar pointed straight at the export, on a spare port.
OPENBOOK_UI_DIR=packages/web/out \
  node packages/server/dist/bin.js --data-dir /tmp/ob-lan --host 127.0.0.1 --port 4319

# 3. Open it in any browser.
open http://127.0.0.1:4319/
```

`OPENBOOK_UI_DIR` is read by the server as the fallback for `AppOptions.uiDir`; when
it is unset the sidecar is API-only and every UI path 404s exactly as before. Note that
`uiDir` and `accessToken` (`--access-token` / `OPENBOOK_ACCESS_TOKEN`) are **mutually
exclusive** — `createApp` throws if both are set, since a token-gated bind can't serve
a tokenless UI without 401ing its own `/api` calls. Serve the UI, or gate with a token;
never both.

### How it fits together

- **`NEXT_PUBLIC_OPENBOOK_SAMEORIGIN=1`** flips `packages/web/next.config.js` to
  `output: 'export'` — a client-only static bundle that talks to the sidecar's
  same-origin `/api` (the same code path a forwarded site uses).
- **`scripts/build-web-ui.mjs`** (`pnpm run build:web-ui`) runs that export and
  stages `packages/web/out` → `packages/app/src-tauri/resources/web-ui`, wired into
  `bundle.resources` and Tauri's `beforeBuildCommand` alongside `build:sidecar`.
- **`packages/server/src/ui.ts`** (`mountUi`) is a `uiDir`-gated `GET *` catch-all,
  mounted **last** so it never shadows `/api`, `/health`, MCP, SSE, or plugin routes.
- **`packages/app/src-tauri/src/main.rs`** resolves the bundled `web-ui` resource and
  passes `OPENBOOK_UI_DIR` to the sidecar **only when published** on the LAN.
