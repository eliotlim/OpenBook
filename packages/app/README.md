# OpenBook desktop app

`@book.dev/app` is the Tauri desktop shell for the OpenBook React UI.
From the workspace root, run it with `pnpm tauri dev`.
Create a desktop build with `pnpm build:desktop`.

## Sidecar supervision verification

The bundled sidecar is supervised only in a release build (`tauri dev` uses the
external development server), so verify BOOT-4 against the uninstalled release
app:

1. From the repository root, run `pnpm install --frozen-lockfile`, then
   `pnpm build:desktop`.
2. Quit any installed OpenBook instance. In a terminal, launch
   `packages/app/src-tauri/target/release/bundle/macos/OpenBook.app/Contents/MacOS/OpenBook`
   and keep its stderr visible. On Linux/Windows use the corresponding unpacked
   release executable.
3. Open a page and make an edit. In a second terminal, identify the child whose
   command starts with `openbook-server` using
   `ps -axo pid=,ppid=,command= | rg openbook-server`; confirm its PPID is the
   OpenBook host PID, then run `kill -9 <sidecar-pid>`.
4. The host log must show `state: Respawning, attempts: 1` and, after about one
   second, `state: Running, attempts: 1`. Re-run the `ps` command and confirm the
   sidecar has a new PID. Reload the page, make another edit, and confirm it saves
   without restarting the app.
5. Open **Settings → Sharing**, change the library access setting, reload, and
   confirm the change persisted. This is an owner-gated server mutation and
   verifies that the app-run `OPENBOOK_LOCAL_OWNER_SECRET` still authenticates
   after the process respawn.
6. Trigger a deliberate restart by toggling **Settings → Publish on LAN** or by
   changing the book directory. The old generation may log an
   `expected/stale termination`, but the next surfaced state must be
   `Running, attempts: 0`; it must not schedule an automatic backoff.

The webview contract can be sampled with Tauri `invoke('sidecar_state')`, and a
repair action calls `invoke('restart_sidecar')`. Both that query and every
`sidecar-state` event use this payload:

```ts
{
  state: 'dead' | 'respawning' | 'running';
  attempts: number;
  lastExitCode: number | null;
  lastStderrTail: string[];
}
```

Crash-loop exhaustion, the 1/2/4/8/16-second bound, healthy reset, deliberate
stop suppression, and repair reset are deterministic unit tests in
`src-tauri/src/sidecar_supervision.rs` (`cargo test sidecar_supervision`).
