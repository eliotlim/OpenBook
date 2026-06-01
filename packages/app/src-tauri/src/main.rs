// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! The OpenBook desktop host.
//!
//! The desktop runs the same TypeScript server as the headless deployment
//! (`@open-book/server`), bundled as a Tauri sidecar over an embedded PGlite
//! database. The webview frontend talks to it over HTTP exactly like the web
//! shell. These commands let the frontend inspect and control that local server.
//!
//! In a release build the sidecar is managed here (auto-started, start/stop
//! exposed). In `tauri dev` the server is run externally by `pnpm dev`, so it is
//! reported as unmanaged and start/stop are no-ops.

use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::api::process::{Command, CommandChild, CommandEvent};
use tauri::{Manager, State};

const DEFAULT_PORT: &str = "4319";
const DEFAULT_URL: &str = "http://127.0.0.1:4319";

struct AppState {
    /// Base URL of the local server (updated from the sidecar's readiness line).
    server_url: Arc<Mutex<Option<String>>>,
    /// The running sidecar process, if any (None in dev or when stopped).
    child: Mutex<Option<CommandChild>>,
    /// App-data directory passed to the embedded server.
    data_dir: String,
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
}

fn build_info(state: &AppState) -> ServerInfo {
    let address = state.server_url.lock().unwrap().clone();
    // When managed, "running" reflects the child process; in dev the server is
    // external and assumed up.
    let running = if state.managed {
        state.child.lock().unwrap().is_some()
    } else {
        true
    };
    ServerInfo {
        running,
        address,
        managed: state.managed,
    }
}

/// Spawn the server sidecar, forwarding its logs and capturing the URL it prints.
fn spawn_sidecar(data_dir: &str, url_slot: Arc<Mutex<Option<String>>>) -> Result<CommandChild, String> {
    let (mut rx, child) = Command::new_sidecar("openbook-server")
        .map_err(|e| format!("failed to locate server sidecar: {e}"))?
        .args(["--data-dir", data_dir, "--host", "127.0.0.1", "--port", DEFAULT_PORT])
        .spawn()
        .map_err(|e| format!("failed to spawn server sidecar: {e}"))?;

    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    if let Some(url) = line.strip_prefix("OPENBOOK_READY ") {
                        *url_slot.lock().unwrap() = Some(url.trim().to_string());
                    }
                    println!("[openbook-server] {line}");
                }
                CommandEvent::Stderr(line) => eprintln!("[openbook-server] {line}"),
                _ => {}
            }
        }
    });
    Ok(child)
}

#[tauri::command]
fn server_info(state: State<AppState>) -> ServerInfo {
    build_info(&state)
}

#[tauri::command]
fn start_server(state: State<AppState>) -> Result<ServerInfo, String> {
    if state.managed {
        let mut guard = state.child.lock().unwrap();
        if guard.is_none() {
            *guard = Some(spawn_sidecar(&state.data_dir, state.server_url.clone())?);
        }
    }
    Ok(build_info(&state))
}

#[tauri::command]
fn stop_server(state: State<AppState>) -> Result<ServerInfo, String> {
    if state.managed {
        if let Some(child) = state.child.lock().unwrap().take() {
            child.kill().map_err(|e| format!("failed to stop server: {e}"))?;
        }
    }
    Ok(build_info(&state))
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let data_dir = app
                .path_resolver()
                .app_data_dir()
                .ok_or("could not resolve the app data directory")?;
            std::fs::create_dir_all(&data_dir).ok();
            let data_dir = data_dir.to_string_lossy().to_string();

            let server_url = Arc::new(Mutex::new(Some(DEFAULT_URL.to_string())));
            let managed = !cfg!(debug_assertions);

            let mut child = None;
            if managed {
                child = Some(spawn_sidecar(&data_dir, server_url.clone())?);
            }

            app.manage(AppState {
                server_url,
                child: Mutex::new(child),
                data_dir,
                managed,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![server_info, start_server, stop_server])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                if let Some(state) = app_handle.try_state::<AppState>() {
                    if let Some(child) = state.child.lock().unwrap().take() {
                        let _ = child.kill();
                    }
                }
            }
        });
}
