# Sidecar binaries

Tauri bundles the OpenBook server (`@open-book/server`) as a sidecar executable
named `openbook-server-<target-triple>` (Tauri's naming convention). These are
build artifacts, not committed.

Build the sidecar for the host platform (requires [Bun](https://bun.sh)):

```sh
pnpm --filter @open-book/server build:sidecar
# or for a specific target:
pnpm --filter @open-book/server build:sidecar x86_64-pc-windows-msvc
```

This must be run before `pnpm --filter @open-book/app tauri build`. In
development (`pnpm dev` / `tauri dev`) the sidecar is **not** used — the server
is run directly via `tsx` on the same port.
