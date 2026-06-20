// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! The OpenBook desktop host.
//!
//! The desktop runs the same TypeScript server as the headless deployment
//! (`@open-book/server`), bundled as a Tauri sidecar over an embedded PGlite
//! database. The webview frontend talks to it over HTTP exactly like the web
//! shell. These commands let the frontend inspect and control that local server.
//!
//! By default the server binds **loopback** (`127.0.0.1`) with no auth — local
//! only. The user can **publish** it on the LAN: the host then binds `0.0.0.0`
//! and requires an access token (so the unauthenticated workspace isn't open to
//! anyone who can reach the port). Preferences (publish, token, book-mirror
//! folder) persist in `host-config.json` under the app-data dir.
//!
//! In a release build the sidecar is managed here (auto-started, start/stop
//! exposed). In `tauri dev` the server is run externally by `pnpm dev`, so it is
//! reported as unmanaged and start/stop are no-ops.

use std::net::UdpSocket;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

const DEFAULT_PORT: &str = "4319";
const LOOPBACK_URL: &str = "http://127.0.0.1:4319";

/// Persisted host preferences (`host-config.json`). Controls how the sidecar is
/// spawned: loopback vs published (LAN), the access token required when
/// published, and where the on-disk book mirror is written.
#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct HostConfig {
    /// Publish on the LAN (bind `0.0.0.0` + require the token). Off by default.
    published: bool,
    /// Access token required by every client when published (minted on demand).
    access_token: String,
    /// Folder the on-disk book mirror writes to (defaults to ~/Documents/OpenBook).
    book_dir: String,
}

struct AppState {
    /// Base URL of the local server (loopback; updated from the readiness line).
    server_url: Arc<Mutex<Option<String>>>,
    /// The running sidecar process, if any (None in dev or when stopped).
    child: Mutex<Option<CommandChild>>,
    /// App-data directory passed to the embedded server.
    data_dir: String,
    /// Persisted preferences + where they live on disk.
    config: Mutex<HostConfig>,
    config_path: PathBuf,
    /// Whether this host manages the server lifecycle (true in release builds).
    managed: bool,
}

/// Mirrors `ServerInfo` in `@open-book/sdk`.
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
    // Take a snapshot of the config and release the lock before acquiring any
    // other, so this never holds `config` while waiting on `child` (respawn
    // holds `child` and would otherwise deadlock against it).
    let (published, access_token, book_dir) = {
        let cfg = state.config.lock().unwrap();
        (cfg.published, cfg.access_token.clone(), cfg.book_dir.clone())
    };
    let address = state.server_url.lock().unwrap().clone();
    let running = if state.managed {
        state.child.lock().unwrap().is_some()
    } else {
        true
    };
    let lan_address = if published {
        lan_ip().map(|ip| format!("http://{ip}:{DEFAULT_PORT}"))
    } else {
        None
    };
    ServerInfo {
        running,
        address,
        managed: state.managed,
        published,
        lan_address,
        // Only surface the token while published (the local UI needs it then).
        access_token: if published { Some(access_token) } else { None },
        book_dir: Some(book_dir),
    }
}

/// Spawn the server sidecar from the current config, forwarding logs and
/// capturing the URL it prints. Binds `0.0.0.0` + an access token when published,
/// otherwise loopback with none.
fn spawn_sidecar(
    app: &AppHandle,
    data_dir: &str,
    cfg: &HostConfig,
    url_slot: Arc<Mutex<Option<String>>>,
) -> Result<CommandChild, String> {
    let host = if cfg.published { "0.0.0.0" } else { "127.0.0.1" };
    let mut args: Vec<String> = vec![
        "--data-dir".into(),
        data_dir.into(),
        "--book-dir".into(),
        cfg.book_dir.clone(),
        "--host".into(),
        host.into(),
        "--port".into(),
        DEFAULT_PORT.into(),
    ];
    if cfg.published && !cfg.access_token.is_empty() {
        args.push("--access-token".into());
        args.push(cfg.access_token.clone());
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
                    let line = String::from_utf8_lossy(&bytes);
                    let line = line.trim_end();
                    if let Some(url) = line.strip_prefix("OPENBOOK_READY ") {
                        *url_slot.lock().unwrap() = Some(url.trim().to_string());
                    }
                    println!("[openbook-server] {line}");
                }
                CommandEvent::Stderr(bytes) => {
                    eprintln!(
                        "[openbook-server] {}",
                        String::from_utf8_lossy(&bytes).trim_end()
                    );
                }
                _ => {}
            }
        }
    });
    Ok(child)
}

/// Stop the running sidecar (gracefully) and spawn a fresh one from the current
/// config — used when publishing toggles or the book folder changes.
fn respawn(app: &AppHandle, state: &AppState) -> Result<(), String> {
    // Snapshot the config and release its lock before taking `child`, keeping a
    // single lock order (config → child) everywhere to avoid deadlock.
    let cfg = state.config.lock().unwrap().clone();
    let mut guard = state.child.lock().unwrap();
    if let Some(child) = guard.take() {
        stop_server_child(child);
    }
    *guard = Some(spawn_sidecar(app, &state.data_dir, &cfg, state.server_url.clone())?);
    Ok(())
}

#[tauri::command]
fn server_info(state: State<AppState>) -> ServerInfo {
    build_info(&state)
}

#[tauri::command]
fn start_server(app: AppHandle, state: State<AppState>) -> Result<ServerInfo, String> {
    if state.managed && state.child.lock().unwrap().is_none() {
        let cfg = state.config.lock().unwrap().clone();
        let child = spawn_sidecar(&app, &state.data_dir, &cfg, state.server_url.clone())?;
        *state.child.lock().unwrap() = Some(child);
    }
    Ok(build_info(&state))
}

#[tauri::command]
fn stop_server(state: State<AppState>) -> Result<ServerInfo, String> {
    if state.managed {
        if let Some(child) = state.child.lock().unwrap().take() {
            stop_server_child(child);
        }
    }
    Ok(build_info(&state))
}

/// Publish (or unpublish) the server on the LAN. Mints a token on first publish,
/// persists the choice, and restarts the sidecar so it rebinds.
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
/// and restarts the sidecar so it re-points the mirror. Async so the (blocking)
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
            respawn(&app, &state)?;
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

            // Load (or initialise) host config. Default the book mirror to a
            // visible ~/Documents/OpenBook folder — the mirror exists for
            // external sync/backup, so a hidden app-data path would defeat it.
            let mut config = load_config(&config_path);
            if config.book_dir.is_empty() {
                let docs = app.path().document_dir().unwrap_or_else(|_| data_dir_pb.clone());
                config.book_dir = docs.join("OpenBook").to_string_lossy().to_string();
                save_config(&config_path, &config);
            }
            std::fs::create_dir_all(&config.book_dir).ok();

            let server_url = Arc::new(Mutex::new(Some(LOOPBACK_URL.to_string())));
            let managed = !cfg!(debug_assertions);

            let mut child = None;
            if managed {
                let handle = app.handle().clone();
                child = Some(spawn_sidecar(&handle, &data_dir, &config, server_url.clone())?);
            }

            app.manage(AppState {
                server_url,
                child: Mutex::new(child),
                data_dir,
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
            start_server,
            stop_server,
            publish_server,
            choose_book_dir,
            reveal_book_dir
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
/// On Unix we send SIGTERM (the server's shutdown handler drains the disk-mirror
/// journal and closes the store) and wait briefly before a hard-kill backstop.
/// On other platforms we kill directly — durability still holds, since the
/// mirror writes atomically and replays its journal on the next launch.
fn stop_server_child(child: CommandChild) {
    #[cfg(unix)]
    {
        let pid = child.pid();
        // SAFETY: a plain `kill(2)` syscall with a known child pid + signal.
        unsafe {
            libc::kill(pid as libc::pid_t, libc::SIGTERM);
        }
        std::thread::sleep(std::time::Duration::from_millis(800));
        let _ = child.kill();
    }
    #[cfg(not(unix))]
    {
        let _ = child.kill();
    }
}
