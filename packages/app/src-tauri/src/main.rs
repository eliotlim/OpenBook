// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! The OpenBook desktop host.
//!
//! The desktop does NOT reimplement storage. It runs the very same TypeScript
//! server as the headless deployment (`@open-book/server`), bundled as a Tauri
//! sidecar, pointed at an embedded Postgres under the app-data directory. The
//! webview frontend talks to it over HTTP exactly like the web shell does — so
//! "desktop" and "server" run identical code.
//!
//! In `cargo tauri dev` the sidecar is NOT spawned: `pnpm dev` already runs the
//! server via tsx on the same port. In release builds the bundled sidecar is
//! launched here.

use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::api::process::{Command, CommandChild, CommandEvent};
use tauri::{Manager, State};

/// Default local address the bundled server listens on, and the URL the
/// frontend connects to by default (see `packages/app/src/data/client.ts`).
const DEFAULT_PORT: &str = "4319";
const DEFAULT_URL: &str = "http://127.0.0.1:4319";

struct AppState {
    /// Base URL of the running local server (loopback). Updated from the
    /// sidecar's readiness line; pre-seeded with the default for dev.
    server_url: Arc<Mutex<Option<String>>>,
    /// The sidecar process handle (None in dev), killed on exit.
    child: Mutex<Option<CommandChild>>,
}

/// Mirrors `ServerInfo` in `@open-book/sdk`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ServerInfo {
    running: bool,
    address: Option<String>,
}

#[tauri::command]
fn server_info(state: State<AppState>) -> ServerInfo {
    let url = state.server_url.lock().unwrap().clone();
    ServerInfo {
        running: url.is_some(),
        address: url,
    }
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let server_url = Arc::new(Mutex::new(Some(DEFAULT_URL.to_string())));
            let mut child: Option<CommandChild> = None;

            // Only spawn the bundled server in release builds; in dev the server
            // is run separately by `pnpm dev` on the same port.
            if !cfg!(debug_assertions) {
                let data_dir = app
                    .path_resolver()
                    .app_data_dir()
                    .ok_or("could not resolve the app data directory")?;
                std::fs::create_dir_all(&data_dir).ok();
                let data_dir = data_dir.to_string_lossy().to_string();

                let (mut rx, command_child) = Command::new_sidecar("openbook-server")
                    .map_err(|e| format!("failed to locate server sidecar: {e}"))?
                    .args([
                        "--data-dir",
                        data_dir.as_str(),
                        "--host",
                        "127.0.0.1",
                        "--port",
                        DEFAULT_PORT,
                    ])
                    .spawn()
                    .map_err(|e| format!("failed to spawn server sidecar: {e}"))?;
                child = Some(command_child);

                // Forward server logs and capture the readiness URL.
                let url_slot = server_url.clone();
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
            }

            app.manage(AppState {
                server_url,
                child: Mutex::new(child),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![server_info])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // Stop the bundled server on exit.
            if let tauri::RunEvent::ExitRequested { .. } = event {
                if let Some(state) = app_handle.try_state::<AppState>() {
                    if let Some(child) = state.child.lock().unwrap().take() {
                        let _ = child.kill();
                    }
                }
            }
        });
}
