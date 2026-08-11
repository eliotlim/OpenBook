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
mod sidecar_supervision;

use std::collections::VecDeque;
use std::io::Read;
use std::net::UdpSocket;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Instant;

use serde::{Deserialize, Serialize};
use sidecar_supervision::{
    FailureDecision, SidecarStatePayload, SidecarSupervisor, HEALTHY_UPTIME, STDERR_TAIL_LINES,
};
use tauri::{AppHandle, Emitter, Manager, State};
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
    /// Publish on the LAN (also bind `0.0.0.0` + serve the web UI). Off by default.
    /// The LAN bind is tokenless — `guestAccess` is the only gate (STAB-7).
    published: bool,
    /// Folder the on-disk book mirror writes to (defaults to ~/Documents/OpenBook).
    book_dir: String,
    /// Bind a LOOPBACK TCP listener (`127.0.0.1:4319`) on the same sidecar so an
    /// out-of-process local MCP/agent connector can reach THIS library (STAB-5).
    /// Gated on the local-MCP/agent toggle — OFF by default, and PERSISTED across
    /// relaunch (unlike `published`, which is opt-in each run). NOTE: unlike the
    /// FS-permissioned IPC socket, this loopback TCP listener is reachable by any
    /// local process, so it is a real new surface, not a no-op — keep it gated on
    /// this explicit opt-in toggle. Cross-origin BROWSER reach is now closed (STAB-8):
    /// the sidecar reflects CORS only for the app's own origins and requires the
    /// first-party `X-OpenBook-Client` header on guest writes, so a random web page
    /// the browser visits can neither read nor write the local library. Redundant
    /// while `published` (which already binds `0.0.0.0:4319`).
    agent_local_tcp: bool,
}

struct AppState {
    /// The running sidecar process (always present in release; None in dev).
    child: Mutex<Option<ManagedSidecar>>,
    /// Bounded-retry policy + generation gate. A deliberate stop advances the
    /// generation before signalling the child, so its Terminated event is stale.
    supervision: Mutex<SidecarSupervisor>,
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

struct ManagedSidecar {
    generation: u64,
    child: CommandChild,
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
    book_dir: Option<String>,
    /// Whether the loopback TCP listener for a local MCP/agent connector is on (STAB-5).
    agent_local_tcp: bool,
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
    let (published, book_dir, agent_local_tcp) = {
        let cfg = state.config.lock().unwrap();
        (cfg.published, cfg.book_dir.clone(), cfg.agent_local_tcp)
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
        book_dir: Some(book_dir),
        agent_local_tcp,
    }
}

/// The TCP-bind CLI args for the sidecar. Pure + unit-tested (STAB-5).
///
/// - `published` → bind `0.0.0.0:4319` for the LAN. NO `--access-token`: a LAN
///   publish is TOKENLESS by owner decision (STAB-7). Publishing always serves the
///   web UI, and a shared-secret gate runs BEFORE `guestAccess` — so a token would
///   401 every `/api` call the served (tokenless) shell makes, leaving an empty
///   page. The ONLY gate on the published bind is `guestAccess` (write/read/off).
/// - else `agent_local_tcp` → bind LOOPBACK `127.0.0.1:4319` only, so an
///   out-of-process local MCP/agent connector can reach this exact library. NO
///   access token; the connector presents its own PAT for auth. Unlike the
///   FS-permissioned IPC socket, this loopback bind is reachable by any local
///   process — a real added surface, hence the explicit opt-in toggle. Cross-origin
///   BROWSER reach is closed (STAB-8): app-origin-only CORS + a first-party
///   `X-OpenBook-Client` header required on guest writes, so a web page the browser
///   visits can neither read nor write the local library.
/// - else → no TCP bind (portless socket-only, the desktop default).
///
/// `published` wins over `agent_local_tcp`: `0.0.0.0:4319` already covers loopback,
/// so there is never a double-bind on the same port.
fn tcp_bind_args(published: bool, agent_local_tcp: bool) -> Vec<String> {
    let mut args: Vec<String> = Vec::new();
    if published {
        args.push("--host".into());
        args.push("0.0.0.0".into());
        args.push("--port".into());
        args.push(DEFAULT_PORT.into());
    } else if agent_local_tcp {
        args.push("--host".into());
        args.push("127.0.0.1".into());
        args.push("--port".into());
        args.push(DEFAULT_PORT.into());
    }
    args
}

/// The bundled LAN web UI directory — a Next static export staged as the `web-ui`
/// Tauri resource (see `scripts/build-web-ui.mjs` + `bundle.resources`). Returns
/// `None` when the resource is absent (e.g. a dev run with no bundle) so the
/// caller simply doesn't set `OPENBOOK_UI_DIR` and the sidecar stays API-only.
/// DEV: point the sidecar at the export directly with
/// `OPENBOOK_UI_DIR=packages/web/out` instead of relying on this bundled path.
fn resolve_ui_dir(app: &AppHandle) -> Option<String> {
    let dir = app.path().resource_dir().ok()?.join("web-ui");
    if dir.join("index.html").is_file() {
        Some(dir.to_string_lossy().to_string())
    } else {
        None
    }
}

/// Spawn the server sidecar from the current config. It always listens on the
/// Unix socket (the portless IPC transport); when published it *also* binds
/// `0.0.0.0` for LAN access (tokenless — `guestAccess` is the only gate, STAB-7),
/// and when the local-MCP/agent toggle is on it *also* binds loopback `127.0.0.1`
/// for the connector (STAB-5).
fn spawn_sidecar(
    app: &AppHandle,
    data_dir: &str,
    socket_path: &str,
    local_secret: &str,
    cfg: &HostConfig,
) -> Result<(tauri::async_runtime::Receiver<CommandEvent>, CommandChild), String> {
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

    // Published LAN bind, or the STAB-5 loopback bind for a local MCP/agent
    // connector. Factored + pure so it's unit-testable (see tcp_bind_args).
    args.extend(tcp_bind_args(cfg.published, cfg.agent_local_tcp));

    // No Unix sockets here — serve a loopback TCP port so the host bridge has a
    // target even when neither published nor the MCP toggle is on (named-pipe
    // support is a follow-up). `tcp_bind_args` already covers the published / MCP
    // cases, so add this fallback only when it produced nothing.
    #[cfg(not(unix))]
    if !cfg.published && !cfg.agent_local_tcp {
        args.push("--host".into());
        args.push("127.0.0.1".into());
        args.push("--port".into());
        args.push(DEFAULT_PORT.into());
    }

    let mut command = app
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
        .env("OPENBOOK_LOCAL_OWNER_SECRET", local_secret);

    // STAB-7 (LAN-hosted web UI): when PUBLISHED on the LAN, also hand the sidecar
    // the bundled static web bundle (a Next static export staged as the `web-ui`
    // Tauri resource) so a LAN browser can open `http://<ip>:4319/` directly. Gated
    // on `published` so the portless / loopback-only defaults NEVER expose a UI —
    // it tracks the `0.0.0.0` bind, which is also published-only. The served UI is
    // tokenless (guest-gated, STAB-7); the sidecar must NOT also carry an access
    // token, or every `/api` call the shell makes would 401 (empty shell). The
    // sidecar reads OPENBOOK_UI_DIR (server.ts) and 404s every UI path when unset;
    // an absent resource (a dev build with no bundle) simply leaves it unset.
    if cfg.published {
        if let Some(ui_dir) = resolve_ui_dir(app) {
            command = command.env("OPENBOOK_UI_DIR", ui_dir);
        }
    }

    command
        .spawn()
        .map_err(|e| format!("failed to spawn server sidecar: {e}"))
}

/// Stop the running sidecar and spawn a fresh one from the current config — used
/// when publishing toggles, the book folder changes, or the repair command runs.
/// The generation advances before the old child is signalled, so its termination
/// cannot enter the crash retry loop. The socket is rebound, so the host bridge
/// and IPC requests reconnect across the brief gap.
fn respawn(app: &AppHandle, state: &AppState) -> Result<(), String> {
    let (generation, payload) = state
        .supervision
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .begin_forced_respawn()
        .ok_or_else(|| "the app is shutting down".to_string())?;
    emit_sidecar_state(app, payload);

    // Take and drop the lock before BOOT-7's potentially blocking graceful stop.
    // The generation was already invalidated, so this death is expected.
    let old_child = state
        .child
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .take();
    if let Some(old_child) = old_child {
        stop_server_child(old_child.child);
    }

    match launch_sidecar(app, state, generation) {
        Ok(()) => Ok(()),
        Err(error) => {
            handle_sidecar_failure(app, generation, None, vec![error.clone()]);
            Err(error)
        }
    }
}

/// Spawn and install one process generation, then attach its output/termination
/// receiver. Installation precedes receiver polling so even an immediately
/// exiting test binary cannot race a stale child handle into `AppState`.
fn launch_sidecar(app: &AppHandle, state: &AppState, generation: u64) -> Result<(), String> {
    // Snapshot config without holding it across process creation. If a config IPC
    // races this launch, its deliberate respawn invalidates this generation and
    // replaces it using the newer snapshot.
    let cfg = state
        .config
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone();
    let (rx, child) = spawn_sidecar(
        app,
        &state.data_dir,
        &state.socket_path,
        &state.local_secret,
        &cfg,
    )?;

    let running_payload = {
        let mut supervisor = state
            .supervision
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let Some(payload) = supervisor.spawned(generation, Instant::now()) else {
            // A deliberate respawn/shutdown won while process creation was in
            // flight. Do not install this obsolete child or supervise its exit.
            drop(supervisor);
            stop_server_child(child);
            return Ok(());
        };
        *state
            .child
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(ManagedSidecar {
            generation,
            child,
        });
        payload
    };
    emit_sidecar_state(app, running_payload);
    monitor_sidecar(app.clone(), generation, rx);
    schedule_healthy_reset(app.clone(), generation);
    Ok(())
}

fn monitor_sidecar(
    app: AppHandle,
    generation: u64,
    mut rx: tauri::async_runtime::Receiver<CommandEvent>,
) {
    tauri::async_runtime::spawn(async move {
        let mut stderr_tail = VecDeque::with_capacity(STDERR_TAIL_LINES);
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    println!("[openbook-server] {}", String::from_utf8_lossy(&bytes).trim_end());
                }
                CommandEvent::Stderr(bytes) => {
                    let text = String::from_utf8_lossy(&bytes);
                    eprintln!("[openbook-server] {}", text.trim_end());
                    for line in text.lines() {
                        if stderr_tail.len() == STDERR_TAIL_LINES {
                            stderr_tail.pop_front();
                        }
                        stderr_tail.push_back(line.to_string());
                    }
                }
                CommandEvent::Terminated(terminated) => {
                    handle_sidecar_terminated(
                        &app,
                        generation,
                        terminated.code,
                        terminated.signal,
                        stderr_tail.into_iter().collect(),
                    );
                    return;
                }
                CommandEvent::Error(error) => {
                    eprintln!("[openbook-server] process event error: {error}");
                }
                _ => {}
            }
        }
    });
}

fn handle_sidecar_terminated(
    app: &AppHandle,
    generation: u64,
    exit_code: Option<i32>,
    signal: Option<i32>,
    stderr_tail: Vec<String>,
) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };

    // Remove only this generation. A replacement may already be installed by a
    // deliberate respawn, in which case its child must remain untouched.
    {
        let mut child = state
            .child
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if child.as_ref().is_some_and(|live| live.generation == generation) {
            child.take();
        }
    }

    eprintln!(
        "[sidecar] terminated: exit_code={exit_code:?} signal={signal:?}; stderr tail ({} lines):",
        stderr_tail.len()
    );
    for line in &stderr_tail {
        eprintln!("[sidecar]   {line}");
    }
    handle_sidecar_failure(app, generation, exit_code, stderr_tail);
}

fn handle_sidecar_failure(
    app: &AppHandle,
    generation: u64,
    exit_code: Option<i32>,
    stderr_tail: Vec<String>,
) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    let Some((payload, decision)) = state
        .supervision
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .failed(generation, Instant::now(), exit_code, stderr_tail)
    else {
        eprintln!("[sidecar] ignored expected/stale termination for generation {generation}");
        return;
    };
    emit_sidecar_state(app, payload);

    match decision {
        FailureDecision::RetryAfter(delay) => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                tokio_sleep(delay).await;
                retry_sidecar(&app, generation);
            });
        }
        FailureDecision::Exhausted => {
            eprintln!(
                "[sidecar] crash-loop bound exhausted; automatic respawn stopped (use restart_sidecar to retry)"
            );
        }
    }
}

async fn tokio_sleep(delay: std::time::Duration) {
    // Tauri re-exports its Tokio runtime but not `time`; a small async-friendly
    // blocking task keeps the backoff off both the UI and async-runtime threads.
    let _ = tauri::async_runtime::spawn_blocking(move || std::thread::sleep(delay)).await;
}

fn retry_sidecar(app: &AppHandle, expected_generation: u64) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    let Some(generation) = state
        .supervision
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .begin_retry(expected_generation)
    else {
        return;
    };

    if let Err(error) = launch_sidecar(app, &state, generation) {
        eprintln!("[sidecar] respawn attempt failed: {error}");
        handle_sidecar_failure(app, generation, None, vec![error]);
    }
}

fn schedule_healthy_reset(app: AppHandle, generation: u64) {
    tauri::async_runtime::spawn(async move {
        tokio_sleep(HEALTHY_UPTIME).await;
        let Some(state) = app.try_state::<AppState>() else {
            return;
        };
        let payload = state
            .supervision
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .mark_healthy(generation, Instant::now());
        if let Some(payload) = payload {
            emit_sidecar_state(&app, payload);
        }
    });
}

fn emit_sidecar_state(app: &AppHandle, payload: SidecarStatePayload) {
    eprintln!("[sidecar] state transition: {payload:?}");
    if let Err(error) = app.emit("sidecar-state", payload) {
        eprintln!("[sidecar] failed to emit sidecar-state: {error}");
    }
}

#[tauri::command]
fn server_info(state: State<AppState>) -> ServerInfo {
    build_info(&state)
}

/// Query the same stable payload emitted through the `sidecar-state` event.
#[tauri::command]
fn sidecar_state(state: State<AppState>) -> SidecarStatePayload {
    state
        .supervision
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .snapshot()
}

/// Repair entry point for the webview: invalidate pending timers/children, reset
/// the five-attempt crash bound, and make one immediate launch attempt.
#[tauri::command]
fn restart_sidecar(app: AppHandle, state: State<AppState>) -> Result<SidecarStatePayload, String> {
    if state.managed {
        respawn(&app, &state)?;
    }
    Ok(sidecar_state(state))
}

/// Publish (or unpublish) this instance on the LAN. Enabling respawns the server so
/// it *also* binds `0.0.0.0` and serves the bundled web UI; disabling respawns it
/// socket-only. The LAN bind is TOKENLESS by owner decision (STAB-7) — publishing
/// always serves the UI, and the ONLY gate on it is `guestAccess` (write/read/off).
/// The local UI uses IPC throughout, so there is no data hand-off and no client
/// switch — only the LAN listener changes.
#[tauri::command]
fn publish_server(app: AppHandle, state: State<AppState>, enabled: bool) -> Result<ServerInfo, String> {
    if !state.managed {
        return Ok(build_info(&state));
    }
    {
        let mut cfg = state.config.lock().unwrap();
        cfg.published = enabled;
        save_config(&state.config_path, &cfg);
    }
    respawn(&app, &state)?;
    Ok(build_info(&state))
}

/// Bind (or unbind) the loopback TCP listener (`127.0.0.1:4319`) for an
/// out-of-process local MCP/agent connector (STAB-5). Flipped together with the
/// agent-API toggle in Settings so the connector's default endpoint actually points
/// at THIS library's server. Persists the preference (survives relaunch, unlike the
/// per-run LAN publish) and respawns the sidecar so the bind takes effect. The local
/// UI keeps using IPC throughout — only the extra loopback listener changes.
#[tauri::command]
fn set_agent_local_tcp(app: AppHandle, state: State<AppState>, enabled: bool) -> Result<ServerInfo, String> {
    if !state.managed {
        return Ok(build_info(&state));
    }
    {
        let mut cfg = state.config.lock().unwrap();
        if cfg.agent_local_tcp == enabled {
            return Ok(build_info(&state)); // no change — don't churn the sidecar
        }
        cfg.agent_local_tcp = enabled;
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
        // Only a confirmed "no such entry" may read as absent.
        Err(keyring::Error::NoEntry) => Ok(None),
        // A locked keychain or a denied access prompt means the entry is
        // UNREADABLE, not absent — surface the typed `keychain-locked:` prefix
        // the TS side maps to a retryable KeychainLockedError, so it can never
        // be mistaken for "no identity stored" (the re-provision path, which
        // would silently rename the forwarded site).
        Err(e @ (keyring::Error::NoStorageAccess(_) | keyring::Error::PlatformFailure(_))) => {
            Err(format!("keychain-locked: {e}"))
        }
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

/// Minimum gap between two OS-browser opens triggered from the nav guard. A
/// hostile subframe can spam off-origin navigations; this caps how fast we hand
/// them to the OS browser, blunting tab-spam. Both are still cancelled in-webview.
const OPEN_EXTERNAL_MIN_GAP_MS: u64 = 1500;

/// Wall-clock millis of the last `OpenExternal` we honoured (`0` = never). A
/// module global so the rate limit spans every webview and frame in the process.
static LAST_OPEN_EXTERNAL_MS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// What the nav guard should do with a requested navigation.
#[derive(Debug, PartialEq, Eq)]
enum NavAction {
    /// Let it proceed in-webview: an app-origin top-level navigation, OR
    /// iframe/artifact *content* (`about:srcdoc`, `blob:`, `data:`, deep links…).
    Allow,
    /// Cancel it in-webview and do nothing else — the `file://` stranding vector.
    Cancel,
    /// Cancel it in-webview and hand the URL to the OS browser — an off-origin
    /// `http(s)` web link.
    OpenExternal,
}

/// Pure navigation decision — the testable core of {@link nav_guard}.
///
/// wry gives us **no frame identity**: `on_navigation` fires for the top document
/// AND for child frames (a SandboxedHtml artifact `<iframe>`) on macOS/Linux. So
/// we key on the URL **scheme**, not a strict origin allowlist:
///   - app origin                → `Allow` (the SPA's own top-level navigation)
///   - `http`/`https` off-origin → `OpenExternal` (real web link → OS browser)
///   - `file`                    → `Cancel` (the native-file-drop stranding vector)
///   - everything else           → `Allow`: `about:srcdoc` is exactly how
///     SandboxedHtml loads its artifact; `blob:`/`data:` are artifact content and
///     `openbook:` is our sign-in deep link — cancelling any of them would blank
///     every artifact / drop deep links.
///
/// Documented residual (owner-accepted, pending): with no frame identity an
/// off-origin `http(s)` navigation *inside a subframe* also lands here and is
/// pushed to the OS browser + cancelled. The opener is rate-limited
/// ({@link OPEN_EXTERNAL_MIN_GAP_MS}) to blunt tab-spam from hostile subframes.
fn nav_action(url: &tauri::Url) -> NavAction {
    if is_app_origin(url) {
        return NavAction::Allow;
    }
    match url.scheme() {
        "http" | "https" => NavAction::OpenExternal,
        "file" => NavAction::Cancel,
        _ => NavAction::Allow,
    }
}

/// Rate-limit gate for the `OpenExternal` arm (pure). Given the last honoured
/// open and the current wall-clock millis, whether another open should fire. A
/// backwards clock jump (`now < last`) saturates to `0` and is denied.
fn rate_limit_allows(last_ms: u64, now_ms: u64) -> bool {
    now_ms.saturating_sub(last_ms) >= OPEN_EXTERNAL_MIN_GAP_MS
}

/// Wall-clock now in millis since the epoch — good enough for a spam gate.
fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Navigation backstop for EVERY webview (the config-defined main window and any
/// JS-created secondary window): the last line of defence behind the JS
/// `DragDropGuard`. A dropped file, a `window.open`, a `<meta http-equiv=refresh>`
/// or any redirect that tries to point the webview off its own document is
/// refused, so the app can never be stranded on a `file://…` page even if the JS
/// guard regresses. Real web links still work: an off-origin `http(s)` target is
/// handed to the OS browser (matching how the app opens external URLs elsewhere)
/// before the in-webview navigation is cancelled — but see {@link nav_action}:
/// because wry gives no frame identity, subframe `http(s)` navigations also land
/// here, so the opener is rate-limited to blunt tab-spam.
fn nav_guard<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    use std::sync::atomic::Ordering;
    tauri::plugin::Builder::new("nav-guard")
        .on_navigation(|webview, url| match nav_action(url) {
            NavAction::Allow => true,
            NavAction::Cancel => false,
            NavAction::OpenExternal => {
                let now = now_millis();
                let last = LAST_OPEN_EXTERNAL_MS.load(Ordering::Relaxed);
                if rate_limit_allows(last, now) {
                    LAST_OPEN_EXTERNAL_MS.store(now, Ordering::Relaxed);
                    use tauri_plugin_opener::OpenerExt;
                    let _ = webview
                        .app_handle()
                        .opener()
                        .open_url(url.as_str(), None::<&str>);
                }
                false
            }
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

            app.manage(AppState {
                child: Mutex::new(None),
                supervision: Mutex::new(SidecarSupervisor::new(managed)),
                data_dir: data_dir.clone(),
                socket_path: socket_path.clone(),
                local_port,
                local_secret: local_secret.clone(),
                config: Mutex::new(config),
                config_path,
                managed,
            });

            // Release: run the durable server over the socket and start the live
            // bridge. Dev: the webview talks to the external `pnpm dev` server.
            if managed {
                let handle = app.handle().clone();
                // Clean up a sidecar orphaned by a prior non-graceful host exit
                // (Force Quit / crash / kill -9) before spawning — it still holds
                // the single-owner PGlite/mirror lock, which our fresh spawn would
                // otherwise collide with. Pid-reuse-guarded (see reap_orphan_sidecar).
                reap_orphan_sidecar(&data_dir);
                if let Err(error) = respawn(&handle, &app.state::<AppState>()) {
                    // Keep the host alive: supervision will retry and surface a
                    // bounded dead state instead of bricking the whole launch.
                    eprintln!("[sidecar] initial launch failed: {error}");
                }
                ipc::start_live_bridge(
                    handle,
                    ipc::ConnInfo {
                        socket_path,
                        local_port,
                        local_secret,
                    },
                );
            }

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
            sidecar_state,
            restart_sidecar,
            publish_server,
            set_agent_local_tcp,
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
        // Closing the main window used to freeze the app for up to SHUTDOWN_GRACE_MS:
        // the sidecar drain (final CHECKPOINT + mirror-journal flush) ran on the main
        // event-loop thread, so the compositor couldn't paint and the window/dock icon
        // hung. Instead we intercept the close, hide the app *immediately* (so it
        // disappears near-instantly), and run the drain off the main thread — then
        // exit once it's actually flushed. Only the main window drives shutdown;
        // secondary windows (App.tsx `openWindow`) close normally.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() != "main" {
                    return; // a secondary window: let it close without touching the app
                }
                api.prevent_close();
                begin_shutdown(window.app_handle());
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| match event {
            // Backstop for a quit that bypasses `WindowEvent::CloseRequested` —
            // macOS `Cmd+Q` / `terminate:` (and `app.exit()` from anywhere). Drain
            // the sidecar the SAME way the close path does: OFF the main thread, so
            // the event loop stays live and the app doesn't freeze while the
            // seconds-long CHECKPOINT + mirror flush runs. We prevent the exit,
            // start (or join) the off-thread drain, and let it call `exit(0)` once
            // the sidecar has actually flushed. `SHUTDOWN_DONE` lets our own
            // post-drain `exit(0)` fall through instead of being prevented forever.
            tauri::RunEvent::ExitRequested { api, .. } => {
                if SHUTDOWN_DONE.load(Ordering::SeqCst) {
                    return; // drain already finished — let this exit proceed
                }
                api.prevent_exit();
                begin_shutdown(app_handle);
            }
            // Final backstop as the loop tears down: stop the sidecar so it isn't
            // orphaned (an orphan keeps the PGlite/mirror lock and blocks the next
            // launch). Idempotent — after a completed drain the child is already
            // gone, so this returns instantly and never blocks the exit.
            tauri::RunEvent::Exit => {
                stop_managed_server(app_handle);
            }
            _ => {}
        });
}

/// Coordinates a graceful, non-blocking shutdown. Only ONE drain ever runs
/// (`SHUTDOWN_STARTED` gate); subsequent close/quit requests just wait for it.
/// The drain runs on its own thread so the main event loop keeps painting — the
/// window/dock icon disappear immediately instead of freezing for the length of
/// the sidecar's final CHECKPOINT + mirror-journal flush.
static SHUTDOWN_STARTED: AtomicBool = AtomicBool::new(false);
/// Set once the off-thread drain has completed and we're about to `exit(0)`, so
/// the resulting `RunEvent::ExitRequested` is allowed through rather than
/// re-prevented (which would deadlock the quit).
static SHUTDOWN_DONE: AtomicBool = AtomicBool::new(false);

/// Hide the app immediately, then drain the sidecar off the main thread and exit
/// once it has flushed. Safe to call repeatedly and from either the close-button
/// path or the `Cmd+Q` path: the first caller owns the drain, the rest are no-ops.
fn begin_shutdown(app: &AppHandle) {
    // Hide first (on the main thread, where this runs) so the app vanishes now,
    // before the seconds-long drain — this is the whole point of the fix.
    hide_app(app);
    if SHUTDOWN_STARTED.swap(true, Ordering::SeqCst) {
        return; // a drain is already in flight; it will exit(0) when done
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let started = std::time::Instant::now();
        stop_managed_server(&app);
        eprintln!(
            "[shutdown] sidecar drain complete in {}ms — exiting",
            started.elapsed().as_millis()
        );
        SHUTDOWN_DONE.store(true, Ordering::SeqCst);
        app.exit(0);
    });
}

/// Make the app disappear immediately at shutdown. On macOS `app.hide()` also
/// clears the dock/app presence (so it doesn't linger visibly); elsewhere we hide
/// the frameless main window. Best-effort — a failure here just means the window
/// stays up a beat longer while the drain runs, it never blocks the exit.
fn hide_app(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    {
        let _ = app.hide();
    }
    #[cfg(not(target_os = "macos"))]
    {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.hide();
        }
    }
}

/// Take and stop the managed sidecar, if one is running. Idempotent: `take()`
/// hands out the child once, so calling this from both the `ExitRequested` and
/// `Exit` run-event arms is safe.
fn stop_managed_server(app_handle: &AppHandle) {
    let Some(state) = app_handle.try_state::<AppState>() else {
        return;
    };
    // Invalidate the receiver and every pending backoff before BOOT-7's graceful
    // stop emits Terminated. This is the normal-quit supervision guard.
    state
        .supervision
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .begin_shutdown();
    // Take the child and DROP the lock guard before the (blocking, up to
    // SHUTDOWN_GRACE_MS) stop — holding it across the wait would block a
    // concurrent publish_server/respawn IPC on the same mutex.
    let child = state.child.lock().unwrap_or_else(|p| p.into_inner()).take();
    if let Some(child) = child {
        stop_server_child(child.child);
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
        // Timed so slow shutdowns are diagnosable: a drain that consistently runs
        // near SHUTDOWN_GRACE_MS suggests the sidecar's periodic WAL maintenance
        // (CHECKPOINT/VACUUM cadence) is falling behind and the exit checkpoint is
        // doing too much work — worth investigating server-side, not here.
        let started = std::time::Instant::now();
        let deadline = started + std::time::Duration::from_millis(SHUTDOWN_GRACE_MS);
        loop {
            // `kill(pid, 0)` probes liveness without sending a signal; a non-zero
            // return (ESRCH) means the process has exited and been reaped.
            let alive = unsafe { libc::kill(pid, 0) } == 0;
            if !alive {
                eprintln!(
                    "[shutdown] sidecar (pid {pid}) exited cleanly in {}ms",
                    started.elapsed().as_millis()
                );
                return;
            }
            if std::time::Instant::now() >= deadline {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        eprintln!(
            "[shutdown] sidecar (pid {pid}) still alive after {SHUTDOWN_GRACE_MS}ms — hard-killing (drain may be truncated)"
        );
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

/// Remove a PGlite lock left by `stale_pid`, but only while the on-disk body still
/// names that pid. The identity recheck keeps a concurrent replacement intact.
///
/// Residual (accepted, ER-5-style): between the recheck and the unlink a concurrent
/// non-app claimant (CLI verify run; a second app is excluded by the single-instance
/// guard) could complete a breaker-serialized takeover, and we would unlink its fresh
/// lock. The window is ~one syscall wide and requires a same-moment boot collision;
/// serializing via the .breaker protocol from Rust is the fix if this is ever observed.
#[cfg(unix)]
fn remove_stale_pglite_lock(data_dir: &str, stale_pid: i32) {
    let path = Path::new(data_dir).join(".openbook-pglite.lock");
    if read_pid_from(&path) != Some(stale_pid) {
        return;
    }
    match std::fs::remove_file(&path) {
        Ok(()) => eprintln!("[reaper] removed stale PGlite dir lock left by dead pid {stale_pid}"),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => eprintln!(
            "[reaper] could not remove stale PGlite dir lock left by dead pid {stale_pid}: {err}"
        ),
    }
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
/// new spawn's `DirLock` declines safely rather than risking corruption. A dead
/// recorded pid has its stale PGlite lock removed here so bootstrap does not rely
/// on the sidecar getting far enough to reclaim it itself.
#[cfg(unix)]
fn reap_orphan_sidecar(data_dir: &str) {
    let Some(pid) = prior_sidecar_pid(data_dir) else {
        return;
    };
    if pid <= 1 {
        return; // never touch pid 0/1 (a malformed/sentinel body)
    }
    if !pid_is_alive(pid) {
        remove_stale_pglite_lock(data_dir, pid);
        return;
    }
    if !pid_is_openbook_server(pid) {
        // The process can disappear between the kill(0) probe and `ps`. Re-probe
        // before treating an empty `ps` result as pid reuse; never remove a lock
        // while the recorded pid is still alive.
        if !pid_is_alive(pid) {
            remove_stale_pglite_lock(data_dir, pid);
            return;
        }
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
    loop {
        if !pid_is_alive(pid) {
            remove_stale_pglite_lock(data_dir, pid);
            break;
        }
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
mod nav_guard_tests {
    use super::{is_app_origin, nav_action, rate_limit_allows, NavAction, OPEN_EXTERNAL_MIN_GAP_MS};

    fn origin(url: &str) -> bool {
        is_app_origin(&tauri::Url::parse(url).unwrap())
    }

    fn action(url: &str) -> NavAction {
        nav_action(&tauri::Url::parse(url).unwrap())
    }

    #[test]
    fn allows_the_app_own_origins() {
        // Release custom protocol (macOS/Linux) + Windows/Android https variant.
        assert!(origin("tauri://localhost/"));
        assert!(origin("tauri://localhost/index.html"));
        assert!(origin("https://tauri.localhost/"));
        assert!(origin("http://tauri.localhost/index.html"));
        // Dev server (devUrl) + loopback.
        assert!(origin("http://localhost:1420/"));
        assert!(origin("http://localhost/"));
        assert!(origin("http://127.0.0.1:1420/"));
    }

    #[test]
    fn is_app_origin_refuses_foreign_hosts() {
        // The stranding vector: a dropped file.
        assert!(!origin("file:///Users/me/Downloads/evil.html"));
        // Real external sites.
        assert!(!origin("https://example.com/"));
        assert!(!origin("http://evil.example.com/"));
        // Look-alike hosts must NOT match the custom-protocol allowlist.
        assert!(!origin("https://tauri.localhost.evil.com/"));
        assert!(!origin("https://localhost.evil.com/"));
        assert!(!origin("tauri://evil/"));
        // Other schemes.
        assert!(!origin("openbook://page/abc"));
        assert!(!origin("data:text/html,<script>1</script>"));
    }

    // ── nav_action: the frame-aware, scheme-based decision (STAB-4 review) ──

    #[test]
    fn app_origins_navigate_in_place() {
        assert_eq!(action("tauri://localhost/"), NavAction::Allow);
        assert_eq!(action("https://tauri.localhost/index.html"), NavAction::Allow);
        assert_eq!(action("http://localhost:1420/"), NavAction::Allow);
        assert_eq!(action("http://127.0.0.1:1420/"), NavAction::Allow);
    }

    #[test]
    fn off_origin_web_links_open_externally() {
        // Real external sites (and look-alike hosts) → OS browser, cancelled in-webview.
        assert_eq!(action("https://example.com/"), NavAction::OpenExternal);
        assert_eq!(action("http://evil.example.com/"), NavAction::OpenExternal);
        assert_eq!(action("https://tauri.localhost.evil.com/"), NavAction::OpenExternal);
    }

    #[test]
    fn file_urls_are_cancelled() {
        // The native-file-drop stranding vector — cancelled, nothing opened.
        assert_eq!(action("file:///Users/me/Downloads/evil.html"), NavAction::Cancel);
    }

    #[test]
    fn iframe_and_artifact_content_schemes_are_allowed() {
        // SandboxedHtml loads as about:srcdoc; blob:/data: are artifact content;
        // openbook: is the sign-in deep link. Cancelling any would blank artifacts
        // or drop deep links — these MUST pass (the previous origin-allowlist
        // wrongly cancelled them for child frames).
        assert_eq!(action("about:srcdoc"), NavAction::Allow);
        assert_eq!(action("about:blank"), NavAction::Allow);
        assert_eq!(action("blob:https://tauri.localhost/8f3c-uuid"), NavAction::Allow);
        assert_eq!(action("data:text/html,<b>hi</b>"), NavAction::Allow);
        assert_eq!(action("openbook://auth-callback"), NavAction::Allow);
    }

    #[test]
    fn open_external_is_rate_limited() {
        // At/over the gap → allowed; under it (or a same-instant / backwards clock)
        // → suppressed. This is the pure gate the OpenExternal arm consults.
        assert!(rate_limit_allows(0, OPEN_EXTERNAL_MIN_GAP_MS));
        assert!(rate_limit_allows(1_000, 1_000 + OPEN_EXTERNAL_MIN_GAP_MS));
        assert!(!rate_limit_allows(1_000, 1_000 + OPEN_EXTERNAL_MIN_GAP_MS - 1));
        assert!(!rate_limit_allows(1_000, 1_000)); // same instant
        assert!(!rate_limit_allows(5_000, 1_000)); // clock went backwards → saturating_sub → 0
    }
}

#[cfg(test)]
mod tcp_bind_tests {
    use super::tcp_bind_args;

    #[test]
    fn toggle_off_binds_no_tcp() {
        // The desktop default: neither published nor the local-MCP toggle → the
        // sidecar is portless (socket-only), so NOTHING listens on 4319 (STAB-5
        // security invariant: no listener unless a toggle is on).
        assert!(tcp_bind_args(false, false).is_empty());
    }

    #[test]
    fn local_mcp_toggle_binds_loopback_only() {
        // Toggle on (not published) → loopback 127.0.0.1:4319, NEVER 0.0.0.0, and
        // NO access token (loopback-only; the connector presents its own PAT).
        let args = tcp_bind_args(false, true);
        assert_eq!(args, vec!["--host", "127.0.0.1", "--port", "4319"]);
        assert!(!args.iter().any(|a| a == "0.0.0.0"));
        assert!(!args.iter().any(|a| a == "--access-token"));
    }

    #[test]
    fn published_binds_lan_tokenless_and_wins_over_mcp() {
        // Published binds 0.0.0.0 and it WINS over the MCP toggle (0.0.0.0:4319
        // already covers loopback — no double-bind). The LAN bind is TOKENLESS by
        // owner decision (STAB-7): `guestAccess` is the only gate, and a token would
        // 401 every /api call the served (tokenless) UI shell makes.
        let args = tcp_bind_args(true, true);
        assert_eq!(args, vec!["--host", "0.0.0.0", "--port", "4319"]);
        assert!(!args.iter().any(|a| a == "--access-token"));
    }

    #[test]
    fn published_never_passes_an_access_token() {
        // Regression guard for the tokenless posture: a plain publish (no MCP) binds
        // the LAN and passes NO `--access-token`, so the served shell's /api calls
        // clear the gate and only `guestAccess` decides.
        let args = tcp_bind_args(true, false);
        assert_eq!(args, vec!["--host", "0.0.0.0", "--port", "4319"]);
        assert!(!args.iter().any(|a| a == "--access-token"));
    }
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

    #[cfg(unix)]
    #[test]
    fn reap_removes_a_stale_lock_for_a_dead_recorded_pid() {
        use super::{pid_is_alive, reap_orphan_sidecar};
        use std::fs;

        let dir = std::env::temp_dir().join(format!(
            "ob-reaper-dead-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        let lock = dir.join(".openbook-pglite.lock");

        let mut child = std::process::Command::new("sh")
            .args(["-c", "exit 0"])
            .spawn()
            .unwrap();
        let dead_pid = child.id() as i32;
        child.wait().unwrap();
        assert!(!pid_is_alive(dead_pid));

        fs::write(
            &lock,
            format!(
                r#"{{"pid":{dead_pid},"host":"old-host","startedAt":"2026-08-10T01:16:54.631Z"}}"#
            ),
        )
        .unwrap();
        reap_orphan_sidecar(dir.to_str().unwrap());
        assert!(!lock.exists());

        fs::remove_dir_all(&dir).ok();
    }
}
