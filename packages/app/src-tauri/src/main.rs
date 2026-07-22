// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! The OpenBook desktop host.
//!
//! The desktop runs the durable local `@book.dev/server` (real-disk PGlite + the
//! on-disk book mirror) and reaches it over **IPC**: the sidecar listens on a
//! Unix domain socket — **no TCP port** — and the webview tunnels requests and
//! the live feed through this host (see `ipc.rs`). A port is opened only when the
//! user **publishes** on the LAN: the sidecar then *also* binds `0.0.0.0` with an
//! access token, while the local UI keeps using IPC. No data hand-off is needed —
//! the server is the single canonical store in every mode.
//!
//! Publishing is release-only (it needs the bundled sidecar binary); in `tauri
//! dev` the host is unmanaged and the webview talks to the external `pnpm dev`
//! server over loopback instead. Preferences (publish, token, book folder)
//! persist in `host-config.json` under the app-data dir.

mod ipc;

use std::io::Read;
use std::net::UdpSocket;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

const DEFAULT_PORT: &str = "4319";
/// Service name for OS-keychain entries (the forwarding site key lives here).
const KEYCHAIN_SERVICE: &str = "pub.book.openbook";

/// Persisted host preferences (`host-config.json`). Controls how the sidecar is
/// spawned when publishing: the access token required on the LAN, and where the
/// on-disk book mirror is written.
#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct HostConfig {
    /// Publish on the LAN (also bind `0.0.0.0` + require the token). Off by default.
    published: bool,
    /// Access token required by every client when published (minted on demand).
    access_token: String,
    /// Folder the on-disk book mirror writes to (defaults to ~/Documents/OpenBook).
    book_dir: String,
}

struct AppState {
    /// The running sidecar process (always present in release; None in dev).
    child: Mutex<Option<CommandChild>>,
    /// App-data directory passed to the embedded server.
    data_dir: String,
    /// Unix socket the server listens on (the portless IPC transport).
    socket_path: String,
    /// Loopback TCP port used to reach the server on platforms without Unix
    /// sockets (Windows). Unused on Unix.
    local_port: u16,
    /// Per-run local-owner secret (the loopback-owner hatch). Minted at launch,
    /// shared with the sidecar via `OPENBOOK_LOCAL_OWNER_SECRET`, and stamped by
    /// the IPC bridge as `X-OpenBook-Local` on exactly the requests that originate
    /// in this app's own webview — never on tunnel-forwarded traffic — so the
    /// server can grant the machine owner authority over their own instance even
    /// when no (or a stale) account identity is present. Never persisted.
    local_secret: String,
    /// Persisted preferences + where they live on disk.
    config: Mutex<HostConfig>,
    config_path: PathBuf,
    /// Whether this host manages the server lifecycle (true in release builds,
    /// where the sidecar binary is bundled). Publishing requires it.
    managed: bool,
}

/// Mirrors `ServerInfo` in `@book.dev/sdk`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ServerInfo {
    running: bool,
    address: Option<String>,
    managed: bool,
    published: bool,
    lan_address: Option<String>,
    access_token: Option<String>,
    book_dir: Option<String>,
}

/// A single file in a book-folder transfer, mirroring `BookFolderFile` in the SDK.
#[derive(Serialize, Deserialize)]
struct BookFile {
    path: String,
    contents: String,
}

/// Result of a native folder export, mirroring the web fallback's shape.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportResult {
    location: String,
    count: usize,
}

fn load_config(path: &PathBuf) -> HostConfig {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_config(path: &PathBuf, cfg: &HostConfig) {
    if let Ok(json) = serde_json::to_string_pretty(cfg) {
        let _ = std::fs::write(path, json);
    }
}

/// Primary outbound LAN IPv4, found via a *connected* (but unused) UDP socket —
/// no packets are sent. `None` when offline.
fn lan_ip() -> Option<String> {
    let sock = UdpSocket::bind("0.0.0.0:0").ok()?;
    sock.connect("8.8.8.8:80").ok()?;
    sock.local_addr().ok().map(|a| a.ip().to_string())
}

fn generate_token() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

fn build_info(state: &AppState) -> ServerInfo {
    // Snapshot the config and release its lock before taking any other, so this
    // never holds `config` while waiting on `child` (publish/respawn hold `child`
    // and would otherwise deadlock against it).
    let (published, access_token, book_dir) = {
        let cfg = state.config.lock().unwrap();
        (cfg.published, cfg.access_token.clone(), cfg.book_dir.clone())
    };
    let running = state.child.lock().unwrap().is_some();
    let lan_address = if published && running {
        lan_ip().map(|ip| format!("http://{ip}:{DEFAULT_PORT}"))
    } else {
        None
    };
    ServerInfo {
        running,
        // The local UI reaches the server over IPC, not an HTTP address; the
        // shareable URL (when published) is `lan_address`.
        address: None,
        managed: state.managed,
        published,
        lan_address,
        access_token: if published { Some(access_token) } else { None },
        book_dir: Some(book_dir),
    }
}

/// Spawn the server sidecar from the current config. It always listens on the
/// Unix socket (the portless IPC transport); when published it *also* binds
/// `0.0.0.0` with the access token for LAN access.
fn spawn_sidecar(
    app: &AppHandle,
    data_dir: &str,
    socket_path: &str,
    local_secret: &str,
    cfg: &HostConfig,
) -> Result<CommandChild, String> {
    #[cfg(not(unix))]
    let _ = socket_path;

    let mut args: Vec<String> = vec![
        "--data-dir".into(),
        data_dir.into(),
        "--book-dir".into(),
        cfg.book_dir.clone(),
    ];

    #[cfg(unix)]
    {
        args.push("--socket".into());
        args.push(socket_path.to_string());
    }

    if cfg.published {
        args.push("--host".into());
        args.push("0.0.0.0".into());
        args.push("--port".into());
        args.push(DEFAULT_PORT.into());
        if !cfg.access_token.is_empty() {
            args.push("--access-token".into());
            args.push(cfg.access_token.clone());
        }
    }

    // No Unix sockets here — serve a loopback TCP port so the host bridge has a
    // target even when not published (named-pipe support is a follow-up).
    #[cfg(not(unix))]
    if !cfg.published {
        args.push("--host".into());
        args.push("127.0.0.1".into());
        args.push("--port".into());
        args.push(DEFAULT_PORT.into());
    }

    let (mut rx, child) = app
        .shell()
        .sidecar("openbook-server")
        .map_err(|e| format!("failed to locate server sidecar: {e}"))?
        .args(args)
        // The ONLY thing that arms the sidecar's parent-death watch (stdin-EOF +
        // ppid poll → graceful shutdown). It must be an explicit host signal: a
        // headless/e2e/docker run with `--data-dir` over a /dev/null stdin is
        // otherwise indistinguishable from a sidecar and would self-terminate.
        .env("OPENBOOK_SIDECAR", "1")
        // The loopback-owner hatch: the sidecar trusts requests stamped with this
        // per-run secret (see `AppState::local_secret`) as the machine owner.
        .env("OPENBOOK_LOCAL_OWNER_SECRET", local_secret)
        .spawn()
        .map_err(|e| format!("failed to spawn server sidecar: {e}"))?;

    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    println!("[openbook-server] {}", String::from_utf8_lossy(&bytes).trim_end());
                }
                CommandEvent::Stderr(bytes) => {
                    eprintln!("[openbook-server] {}", String::from_utf8_lossy(&bytes).trim_end());
                }
                _ => {}
            }
        }
    });
    Ok(child)
}

/// Stop the running sidecar and spawn a fresh one from the current config — used
/// when publishing toggles or the book folder changes. The socket is rebound, so
/// the host bridge and IPC requests reconnect across the brief gap.
fn respawn(app: &AppHandle, state: &AppState) -> Result<(), String> {
    // Snapshot the config and release its lock before taking `child`, keeping a
    // single lock order (config → child) everywhere to avoid deadlock.
    let cfg = state.config.lock().unwrap().clone();
    let mut guard = state.child.lock().unwrap();
    if let Some(child) = guard.take() {
        stop_server_child(child);
    }
    *guard = Some(spawn_sidecar(app, &state.data_dir, &state.socket_path, &state.local_secret, &cfg)?);
    Ok(())
}

#[tauri::command]
fn server_info(state: State<AppState>) -> ServerInfo {
    build_info(&state)
}

/// Publish (or unpublish) this instance on the LAN. Enabling mints a token (once)
/// and respawns the server so it *also* binds `0.0.0.0`; disabling respawns it
/// socket-only. The local UI uses IPC throughout, so there is no data hand-off
/// and no client switch — only the LAN listener changes.
#[tauri::command]
fn publish_server(app: AppHandle, state: State<AppState>, enabled: bool) -> Result<ServerInfo, String> {
    if !state.managed {
        return Ok(build_info(&state));
    }
    {
        let mut cfg = state.config.lock().unwrap();
        cfg.published = enabled;
        if enabled && cfg.access_token.is_empty() {
            cfg.access_token = generate_token();
        }
        save_config(&state.config_path, &cfg);
    }
    respawn(&app, &state)?;
    Ok(build_info(&state))
}

/// Open a native folder picker for the book-mirror directory. Persists the choice
/// and restarts the server so the mirror re-points. Async so the (blocking)
/// dialog runs off the main thread.
#[tauri::command]
async fn choose_book_dir(app: AppHandle, state: State<'_, AppState>) -> Result<ServerInfo, String> {
    use tauri_plugin_dialog::DialogExt;
    let picked = app.dialog().file().blocking_pick_folder();
    if let Some(fp) = picked {
        if let Some(path) = fp.as_path() {
            let dir = path.to_string_lossy().to_string();
            std::fs::create_dir_all(&dir).ok();
            {
                let mut cfg = state.config.lock().unwrap();
                cfg.book_dir = dir;
                save_config(&state.config_path, &cfg);
            }
            if state.managed {
                respawn(&app, &state)?;
            }
        }
    }
    Ok(build_info(&state))
}

/// Reveal the book-mirror folder in the OS file manager (Finder/Explorer).
#[tauri::command]
fn reveal_book_dir(app: AppHandle, state: State<AppState>) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let dir = state.config.lock().unwrap().book_dir.clone();
    std::fs::create_dir_all(&dir).ok();
    app.opener()
        .open_path(dir, None::<&str>)
        .map_err(|e| e.to_string())
}

/// Write an exported book folder to a directory the user picks. Returns a summary
/// (the chosen folder + how many page files were written), or `None` if the user
/// cancelled the dialog. Async so the blocking picker runs off the main thread.
#[tauri::command]
async fn export_book_folder(app: AppHandle, files: Vec<BookFile>) -> Result<Option<ExportResult>, String> {
    use tauri_plugin_dialog::DialogExt;
    let Some(fp) = app.dialog().file().blocking_pick_folder() else {
        return Ok(None);
    };
    let Some(base) = fp.as_path().map(|p| p.to_path_buf()) else {
        return Ok(None);
    };
    let mut count = 0usize;
    for file in &files {
        let abs = base.join(&file.path);
        if let Some(parent) = abs.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::write(&abs, &file.contents).map_err(|e| e.to_string())?;
        if file.path.ends_with(".html") {
            count += 1;
        }
    }
    let location = base
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| base.to_string_lossy().to_string());
    Ok(Some(ExportResult { location, count }))
}

/// Read a user-picked book folder back into files (relative POSIX paths), or
/// `None` if the dialog was cancelled. Only UTF-8 text files are returned.
#[tauri::command]
async fn import_book_folder(app: AppHandle) -> Result<Option<Vec<BookFile>>, String> {
    use tauri_plugin_dialog::DialogExt;
    let Some(fp) = app.dialog().file().blocking_pick_folder() else {
        return Ok(None);
    };
    let Some(base) = fp.as_path().map(|p| p.to_path_buf()) else {
        return Ok(None);
    };
    let mut out = Vec::new();
    read_dir_recursive(&base, &base, &mut out).map_err(|e| e.to_string())?;
    Ok(Some(out))
}

/// Collect every readable UTF-8 text file under `dir`, keyed by its path relative
/// to `base` (with `/` separators). Non-UTF-8 files are skipped.
fn read_dir_recursive(base: &Path, dir: &Path, out: &mut Vec<BookFile>) -> std::io::Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_dir() {
            read_dir_recursive(base, &path, out)?;
        } else if let Ok(rel) = path.strip_prefix(base) {
            let mut buf = Vec::new();
            if std::fs::File::open(&path)
                .and_then(|mut f| f.read_to_end(&mut buf))
                .is_ok()
            {
                if let Ok(text) = String::from_utf8(buf) {
                    out.push(BookFile {
                        path: rel.to_string_lossy().replace('\\', "/"),
                        contents: text,
                    });
                }
            }
        }
    }
    Ok(())
}

// ── OS keychain (forwarding site key) ────────────────────────────────────────
// Small get/set/delete over the platform keychain, keyed by a caller-supplied
// name. The desktop KeyStore stores the site identity (incl. the Ed25519 private
// key) here so it never touches disk in the clear.

#[tauri::command]
fn keychain_set(key: String, value: String) -> Result<(), String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, &key)
        .and_then(|e| e.set_password(&value))
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn keychain_get(key: String) -> Result<Option<String>, String> {
    match keyring::Entry::new(KEYCHAIN_SERVICE, &key).and_then(|e| e.get_password()) {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn keychain_delete(key: String) -> Result<(), String> {
    match keyring::Entry::new(KEYCHAIN_SERVICE, &key).and_then(|e| e.delete_credential()) {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

// ── Update target (self-update check) ────────────────────────────────────────

/// The build target the update-check API keys on: OS family (`darwin` | `linux`
/// | `windows`) + CPU architecture (`aarch64` | `x86_64`).
#[derive(serde::Serialize)]
struct UpdateTarget {
    target: &'static str,
    arch: &'static str,
}

/// Compile-time truth about what binary this is — `std::env::consts` reflects
/// the target the app was *built for*, which is exactly what the updater wants
/// (an Intel build under Rosetta must keep receiving x86_64 updates). Reading
/// it here, rather than sniffing `navigator.userAgent` in the webview, also
/// keeps the JS check path and the Rust updater plugin on the same answer.
#[tauri::command]
fn update_target() -> UpdateTarget {
    UpdateTarget {
        // Rust says "macos"; the update API (like Tauri's own {{target}}) says "darwin".
        target: match std::env::consts::OS {
            "macos" => "darwin",
            os => os,
        },
        arch: std::env::consts::ARCH,
    }
}

/// Whether `url` is the app's own document origin — the only origin the webview
/// is ever allowed to navigate to. Covers the release custom protocol
/// (`tauri://localhost` on macOS/Linux; `http(s)://tauri.localhost` on
/// Windows/Android, incl. `useHttpsScheme`) and the dev server / loopback
/// (`http://localhost:1420`). Everything else is refused (see `nav_guard`).
fn is_app_origin(url: &tauri::Url) -> bool {
    match (url.scheme(), url.host_str().unwrap_or("")) {
        ("tauri", "localhost") => true,
        ("http" | "https", "tauri.localhost") => true,
        ("http" | "https", "localhost" | "127.0.0.1") => true,
        _ => false,
    }
}

/// Navigation backstop for EVERY webview (the config-defined main window and any
/// JS-created secondary window): the last line of defence behind the JS
/// `DragDropGuard`. A dropped file, a `window.open`, a `<meta http-equiv=refresh>`
/// or any redirect that tries to point the webview off its own document is
/// refused, so the app can never be stranded on a `file://…` (or any foreign)
/// page even if the JS guard regresses. Real web links still work: an off-origin
/// `http(s)` target is handed to the OS browser (matching how the app opens
/// external URLs elsewhere) before the in-webview navigation is cancelled.
fn nav_guard<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("nav-guard")
        .on_navigation(|webview, url| {
            if is_app_origin(url) {
                return true;
            }
            if matches!(url.scheme(), "http" | "https") {
                use tauri_plugin_opener::OpenerExt;
                let _ = webview
                    .app_handle()
                    .opener()
                    .open_url(url.as_str(), None::<&str>);
            }
            false
        })
        .build()
}

fn main() {
    tauri::Builder::default()
        // Single-instance guard (registered first): a second launch focuses the
        // running window instead of starting a competing PGlite owner.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        // Navigation backstop for every window (STAB-4): refuse any navigation
        // off the app's own origin so a stray file drop / window.open / redirect
        // can never strand the webview on a file://… page.
        .plugin(nav_guard())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        // Handles `openbook://auth-callback#token=…` sign-in deep links.
        .plugin(tauri_plugin_deep_link::init())
        // Self-update: manifest endpoint + minisign pubkey are pinned in
        // tauri.conf.json (plugins.updater); the JS side drives it through
        // `platform.updates` (packages/app/src/data/updates.ts).
        .plugin(tauri_plugin_updater::Builder::new().build())
        // Relaunch-to-apply after an update is staged.
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            #[cfg(any(target_os = "linux", target_os = "windows"))]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let _ = app.deep_link().register_all();
            }
            let data_dir_pb = app
                .path()
                .app_data_dir()
                .map_err(|e| format!("could not resolve the app data directory: {e}"))?;
            std::fs::create_dir_all(&data_dir_pb).ok();
            let config_path = data_dir_pb.join("host-config.json");
            let data_dir = data_dir_pb.to_string_lossy().to_string();

            // Load (or initialise) host config. Default the book folder to a
            // visible ~/Documents/OpenBook — it's for external sync/backup, so a
            // hidden app-data path would defeat it.
            let mut config = load_config(&config_path);
            if config.book_dir.is_empty() {
                let docs = app
                    .path()
                    .document_dir()
                    .unwrap_or_else(|_| data_dir_pb.clone());
                config.book_dir = docs.join("OpenBook").to_string_lossy().to_string();
                save_config(&config_path, &config);
            }
            std::fs::create_dir_all(&config.book_dir).ok();

            // The server always listens on this socket (portless IPC). Publishing
            // never auto-resumes across a relaunch — the LAN bind is opt-in each run.
            let socket_path = Path::new(&data_dir).join("openbook.sock").to_string_lossy().to_string();
            let local_port: u16 = 4319;
            config.published = false;
            let managed = !cfg!(debug_assertions);
            // Per-run local-owner secret (the loopback-owner hatch): shared with the
            // sidecar via env and stamped on webview-originated IPC requests only.
            let local_secret = generate_token();

            // Release: run the durable server over the socket and start the live
            // bridge. Dev: the webview talks to the external `pnpm dev` server.
            let mut child = None;
            if managed {
                let handle = app.handle().clone();
                // Clean up a sidecar orphaned by a prior non-graceful host exit
                // (Force Quit / crash / kill -9) before spawning — it still holds
                // the single-owner PGlite/mirror lock, which our fresh spawn would
                // otherwise collide with. Pid-reuse-guarded (see reap_orphan_sidecar).
                reap_orphan_sidecar(&data_dir);
                child = Some(spawn_sidecar(&handle, &data_dir, &socket_path, &local_secret, &config)?);
                ipc::start_live_bridge(
                    handle.clone(),
                    ipc::ConnInfo {
                        socket_path: socket_path.clone(),
                        local_port,
                        local_secret: local_secret.clone(),
                    },
                );
            }

            app.manage(AppState {
                child: Mutex::new(child),
                data_dir,
                socket_path,
                local_port,
                local_secret,
                config: Mutex::new(config),
                config_path,
                managed,
            });

            // The UI draws its own title bar; macOS keeps native traffic lights
            // via an overlay titlebar, elsewhere the main window is frameless.
            #[cfg(not(target_os = "macos"))]
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_decorations(false);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            server_info,
            publish_server,
            choose_book_dir,
            reveal_book_dir,
            export_book_folder,
            import_book_folder,
            keychain_set,
            keychain_get,
            keychain_delete,
            update_target,
            ipc::api_request,
            ipc::api_request_stream,
            ipc::api_request_abort
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| match event {
            // Stop the sidecar on the way out so it isn't orphaned (an orphan keeps
            // the PGlite/mirror lock and blocks the next launch). `ExitRequested`
            // fires on window-close; `Exit` also fires for macOS `Cmd+Q` /
            // `terminate:`, where `ExitRequested` may not. Both route through the
            // idempotent helper (its `take()` yields the child only once), and we
            // don't rely on the shell plugin's own cleanup — it doesn't track this
            // Rust-spawned child.
            tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit => {
                stop_managed_server(app_handle);
            }
            _ => {}
        });
}

/// Take and stop the managed sidecar, if one is running. Idempotent: `take()`
/// hands out the child once, so calling this from both the `ExitRequested` and
/// `Exit` run-event arms is safe.
fn stop_managed_server(app_handle: &AppHandle) {
    let Some(state) = app_handle.try_state::<AppState>() else {
        return;
    };
    // Take the child and DROP the lock guard before the (blocking, up to
    // SHUTDOWN_GRACE_MS) stop — holding it across the wait would block a
    // concurrent publish_server/respawn IPC on the same mutex.
    let child = state.child.lock().unwrap().take();
    if let Some(child) = child {
        stop_server_child(child);
    }
}

/// Stop the server sidecar, giving it a chance to flush pending writes first.
///
/// On Unix we send SIGTERM (the server's shutdown handler runs a final
/// CHECKPOINT, drains the disk-mirror journal, and closes the store) and then
/// **wait for the child to actually exit** before a hard-kill backstop. The old
/// fixed 800 ms sleep could truncate that shutdown mid-write under heavy edit
/// churn, and a truncated checkpoint is exactly what leaves PGlite's WAL
/// unrecoverable on the next launch (OB-164). Polling the pid lets a clean exit
/// return promptly while still force-killing a stuck child.
///
/// On other platforms we kill directly — durability still holds, since the
/// mirror writes atomically and replays its journal on the next launch.
fn stop_server_child(child: CommandChild) {
    #[cfg(unix)]
    {
        // Upper bound on how long we wait for the sidecar's shutdown checkpoint
        // + journal flush before the hard-kill backstop.
        const SHUTDOWN_GRACE_MS: u64 = 6000;
        let pid = child.pid() as libc::pid_t;
        // SAFETY: plain `kill(2)` syscalls with a known child pid.
        unsafe {
            libc::kill(pid, libc::SIGTERM);
        }
        let deadline =
            std::time::Instant::now() + std::time::Duration::from_millis(SHUTDOWN_GRACE_MS);
        loop {
            // `kill(pid, 0)` probes liveness without sending a signal; a non-zero
            // return (ESRCH) means the process has exited and been reaped.
            let alive = unsafe { libc::kill(pid, 0) } == 0;
            if !alive {
                return;
            }
            if std::time::Instant::now() >= deadline {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        let _ = child.kill();
    }
    #[cfg(not(unix))]
    {
        let _ = child.kill();
    }
}

// ── Startup reaper (cleans up a sidecar orphaned by a prior crash/force-quit) ──
//
// A non-graceful prior host exit (Force Quit / crash / `kill -9` / logout SIGKILL)
// can leave the `openbook-server` sidecar running. That orphan still holds the
// single-owner PGlite/mirror `DirLock`, so the next launch's fresh spawn collides
// (the lock correctly DECLINES against the live orphan rather than corrupt PGlite).
// The single-instance plugin guarantees we are the only host, so any leftover
// sidecar is genuinely abandoned and safe to stop. The parent-death watch in the
// sidecar (layer A) prevents *new* orphans; this reaps ones from before the fix or
// from a path where that watch didn't fire.

/// A prior run's pid, parsed from a lock/discovery file. Both
/// `.openbook-pglite.lock` (`{pid,host,startedAt}`) and `server.json`
/// (`{url,port,pid,startedAt}`) carry a `pid`; serde ignores the other fields.
/// Gated `any(unix, test)` so a Windows release build (no reaper) gets no
/// dead-code warning.
#[cfg(any(unix, test))]
#[derive(Deserialize)]
struct PriorRun {
    pid: i32,
}

/// Does `ps_comm` (a `ps -p <pid> -o comm=` line — the **executable**, not its
/// args) identify our sidecar? True iff the executable's basename starts with
/// `openbook-server`.
///
/// This is the **pid-reuse guard**, factored out so it is unit-testable. We match
/// the executable, NOT the full command line: a recycled pid running
/// `tail -f …/openbook-server.log`, `grep openbook-server`, `less …openbook-server`,
/// or an editor on such a path has `comm` = `tail`/`grep`/`less`/the editor and is
/// correctly REJECTED, so we never SIGTERM a bystander. The basename-prefix covers
/// the per-arch binary `openbook-server-<triple>` (e.g.
/// `openbook-server-aarch64-apple-darwin`) and Linux's 15-char `comm` truncation
/// of it (`openbook-server`). The reaper is release-only (`managed`), so the live
/// holder of our data dir is always the compiled binary — never a `node`/`tsx` dev
/// process.
///
/// Gated `any(unix, test)` (used by the unix reaper + the all-platform unit test)
/// so a Windows release build gets no dead-code warning.
#[cfg(any(unix, test))]
fn comm_is_openbook_server(ps_comm: &str) -> bool {
    let name = ps_comm.trim();
    let base = name.rsplit('/').next().unwrap_or(name); // basename of the executable
    base.starts_with("openbook-server")
}

#[cfg(unix)]
fn read_pid_from(path: &Path) -> Option<i32> {
    let body = std::fs::read_to_string(path).ok()?;
    serde_json::from_str::<PriorRun>(&body).ok().map(|r| r.pid)
}

/// Pid of a prior sidecar, preferring the PGlite lock (always written in embedded
/// mode) and falling back to the TCP discovery file.
#[cfg(unix)]
fn prior_sidecar_pid(data_dir: &str) -> Option<i32> {
    read_pid_from(&Path::new(data_dir).join(".openbook-pglite.lock"))
        .or_else(|| read_pid_from(&Path::new(data_dir).join("server.json")))
}

/// Whether `pid` is a live process. `kill(pid, 0)` only probes: `0` = alive,
/// `ESRCH` = gone, `EPERM` = exists but owned by another user (still alive).
#[cfg(unix)]
fn pid_is_alive(pid: i32) -> bool {
    let rc = unsafe { libc::kill(pid as libc::pid_t, 0) };
    if rc == 0 {
        return true;
    }
    matches!(std::io::Error::last_os_error().raw_os_error(), Some(libc::EPERM))
}

/// Confirm the live `pid` is actually our sidecar (not a recycled pid) by reading
/// its **executable** (`ps -o comm=`, not its args) and matching the basename.
/// Fails safe: if `ps` can't confirm, returns false so we never signal an
/// unverified pid.
#[cfg(unix)]
fn pid_is_openbook_server(pid: i32) -> bool {
    match std::process::Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "comm="])
        .output()
    {
        Ok(out) if out.status.success() => {
            comm_is_openbook_server(&String::from_utf8_lossy(&out.stdout))
        }
        _ => false,
    }
}

/// Stop a sidecar orphaned by a prior non-graceful host exit, before we spawn a
/// fresh one. SIGTERMs the orphan ONLY after confirming (a) the recorded pid is
/// alive and (b) it is genuinely an `openbook-server` — the pid-reuse guard, a
/// hard requirement, since signalling a recycled pid would kill an unrelated
/// process. We deliberately do **not** escalate to SIGKILL: a half-killed PGlite
/// can leave an unrecoverable WAL (OB-164), and if SIGTERM is somehow ignored the
/// new spawn's `DirLock` declines safely rather than risking corruption.
#[cfg(unix)]
fn reap_orphan_sidecar(data_dir: &str) {
    let Some(pid) = prior_sidecar_pid(data_dir) else {
        return;
    };
    if pid <= 1 {
        return; // never touch pid 0/1 (a malformed/sentinel body)
    }
    if !pid_is_alive(pid) {
        return; // dead → the lock is stale; DirLock takes it over on spawn
    }
    if !pid_is_openbook_server(pid) {
        eprintln!(
            "[reaper] pid {pid} from a prior run is alive but is not an openbook-server (pid reuse) — not signalling"
        );
        return;
    }
    eprintln!("[reaper] stopping orphaned openbook-server pid {pid} from a prior run");
    // SAFETY: plain kill(2) with a pid we've confirmed is our abandoned sidecar.
    unsafe {
        libc::kill(pid as libc::pid_t, libc::SIGTERM);
    }
    // Wait briefly for it to checkpoint + release the lock before we spawn.
    const REAP_GRACE_MS: u64 = 5000;
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(REAP_GRACE_MS);
    while pid_is_alive(pid) {
        if std::time::Instant::now() >= deadline {
            eprintln!(
                "[reaper] pid {pid} still alive after {REAP_GRACE_MS}ms — proceeding (DirLock will arbitrate)"
            );
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
}

#[cfg(not(unix))]
fn reap_orphan_sidecar(_data_dir: &str) {
    // Windows orphan reaping (tasklist/taskkill) is a follow-up. The sidecar's
    // stdin-EOF parent-death watch (layer A) covers host death cross-platform, so
    // new orphans shouldn't occur there either.
}

#[cfg(test)]
mod reaper_tests {
    use super::comm_is_openbook_server;

    #[test]
    fn accepts_the_per_arch_sidecar_binary() {
        // macOS `comm=` is the full executable path; Linux truncates `comm` to 15
        // chars (`openbook-server`). Both basenames start with `openbook-server`.
        assert!(comm_is_openbook_server(
            "/Applications/OpenBook.app/Contents/MacOS/openbook-server-aarch64-apple-darwin\n"
        ));
        assert!(comm_is_openbook_server("openbook-server-aarch64-apple-darwin"));
        assert!(comm_is_openbook_server("openbook-server")); // Linux truncated comm
    }

    #[test]
    fn rejects_an_unrelated_recycled_pid() {
        // The pid-reuse guard matches the EXECUTABLE (comm), not args, so a recycled
        // pid running a tool that merely *mentions* the path is rejected — we never
        // SIGTERM a bystander.
        assert!(!comm_is_openbook_server("tail")); // `tail -f …/openbook-server.log`
        assert!(!comm_is_openbook_server("grep")); // `grep openbook-server`
        assert!(!comm_is_openbook_server("less")); // `less …/openbook-server.log`
        assert!(!comm_is_openbook_server("/usr/bin/node")); // dev `node … packages/server`
        assert!(!comm_is_openbook_server("/bin/zsh"));
        assert!(!comm_is_openbook_server(""));
    }

    // Control-flow guard: absent / empty / garbage lock content yields no pid, so
    // the reaper signals nothing; a real (extra-field) lock body yields the pid,
    // and server.json is the fallback. Unix-gated (read_pid_from/prior_sidecar_pid
    // are #[cfg(unix)]).
    #[cfg(unix)]
    #[test]
    fn read_pid_from_handles_absent_garbage_and_valid_locks() {
        use super::{prior_sidecar_pid, read_pid_from};
        use std::fs;

        let dir = std::env::temp_dir().join(format!(
            "ob-reaper-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        let data_dir = dir.to_str().unwrap();
        let lock = dir.join(".openbook-pglite.lock");

        // Absent → None (no lock, no signal).
        assert_eq!(read_pid_from(&lock), None);
        assert_eq!(prior_sidecar_pid(data_dir), None);

        // Empty / garbage → None (never parse a pid out of junk).
        fs::write(&lock, b"").unwrap();
        assert_eq!(read_pid_from(&lock), None);
        fs::write(&lock, b"not json at all").unwrap();
        assert_eq!(read_pid_from(&lock), None);

        // Real lock body shape (extra host/startedAt fields ignored) → the pid.
        fs::write(&lock, br#"{"pid":4242,"host":"h","startedAt":"2026-01-01T00:00:00.000Z"}"#).unwrap();
        assert_eq!(read_pid_from(&lock), Some(4242));
        assert_eq!(prior_sidecar_pid(data_dir), Some(4242));

        // server.json is the fallback when the pglite lock is absent.
        fs::remove_file(&lock).unwrap();
        let server_json = dir.join("server.json");
        fs::write(&server_json, br#"{"url":"http://x","port":4319,"pid":777,"startedAt":"x"}"#).unwrap();
        assert_eq!(prior_sidecar_pid(data_dir), Some(777));

        fs::remove_dir_all(&dir).ok();
    }
}
