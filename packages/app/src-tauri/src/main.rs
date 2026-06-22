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
fn spawn_sidecar(app: &AppHandle, data_dir: &str, socket_path: &str, cfg: &HostConfig) -> Result<CommandChild, String> {
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
    *guard = Some(spawn_sidecar(app, &state.data_dir, &state.socket_path, &cfg)?);
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
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        // Handles `openbook://auth-callback#token=…` sign-in deep links.
        .plugin(tauri_plugin_deep_link::init())
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

            // Release: run the durable server over the socket and start the live
            // bridge. Dev: the webview talks to the external `pnpm dev` server.
            let mut child = None;
            if managed {
                let handle = app.handle().clone();
                child = Some(spawn_sidecar(&handle, &data_dir, &socket_path, &config)?);
                ipc::start_live_bridge(
                    handle.clone(),
                    ipc::ConnInfo { socket_path: socket_path.clone(), local_port },
                );
            }

            app.manage(AppState {
                child: Mutex::new(child),
                data_dir,
                socket_path,
                local_port,
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
            ipc::api_request
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                if let Some(state) = app_handle.try_state::<AppState>() {
                    if let Some(child) = state.child.lock().unwrap().take() {
                        stop_server_child(child);
                    }
                }
            }
        });
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
