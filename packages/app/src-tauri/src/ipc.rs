//! Host IPC bridge to the portless local server.
//!
//! The desktop server listens on a Unix domain socket (no TCP port). The webview
//! can't reach a socket directly, so this module bridges it: `api_request`
//! tunnels a single HTTP request over the socket and returns the response, and a
//! background task streams the server's `/api/live` SSE feed and re-emits each
//! frame as a Tauri event the webview's data client subscribes to.
//!
//! HTTP/1.1 is spoken by hand over the stream — no extra crates. Requests use
//! `Connection: close` (one response, read to EOF); the live feed handles the
//! server's chunked transfer encoding via [`ChunkedReader`]. On non-Unix
//! platforms the same code talks to a loopback TCP port (named-pipe support is a
//! follow-up), so Windows still works, just not strictly portless.

use std::io::{BufRead, BufReader, Read, Write};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::AppState;

/// How the host reaches the local server: a Unix socket path, or a loopback TCP
/// port on platforms without Unix sockets.
#[derive(Clone)]
pub struct ConnInfo {
    pub socket_path: String,
    /// Used only on the non-Unix (loopback TCP) fallback.
    #[cfg_attr(unix, allow(dead_code))]
    pub local_port: u16,
}

impl ConnInfo {
    pub fn from_state(state: &AppState) -> Self {
        ConnInfo {
            socket_path: state.socket_path.clone(),
            local_port: state.local_port,
        }
    }
}

/// The reconstructed HTTP response handed back to the webview's `fetch` shim.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiResponse {
    pub status: u16,
    /// Response headers (hop-by-hop framing stripped), so the forwarding tunnel
    /// can re-emit `content-type` etc. instead of an untyped body.
    pub headers: Vec<(String, String)>,
    pub body: String,
}

/// A frame of the live feed, mirroring an SSE `event:`/`data:` pair.
#[derive(Clone, Serialize)]
struct LiveFrame {
    event: String,
    data: String,
}

trait Stream: Read + Write + Send {}
impl<T: Read + Write + Send> Stream for T {}

#[cfg(unix)]
fn connect(conn: &ConnInfo) -> std::io::Result<Box<dyn Stream>> {
    use std::os::unix::net::UnixStream;
    let stream = UnixStream::connect(&conn.socket_path)?;
    stream.set_read_timeout(Some(Duration::from_secs(180)))?;
    Ok(Box::new(stream))
}

#[cfg(not(unix))]
fn connect(conn: &ConnInfo) -> std::io::Result<Box<dyn Stream>> {
    use std::net::TcpStream;
    let stream = TcpStream::connect(("127.0.0.1", conn.local_port))?;
    stream.set_read_timeout(Some(Duration::from_secs(180)))?;
    Ok(Box::new(stream))
}

/// Connect, retrying briefly to ride out server startup / a publish respawn.
fn connect_retry(conn: &ConnInfo, attempts: u32) -> std::io::Result<Box<dyn Stream>> {
    let mut last: Option<std::io::Error> = None;
    for _ in 0..attempts {
        match connect(conn) {
            Ok(s) => return Ok(s),
            Err(e) => {
                last = Some(e);
                std::thread::sleep(Duration::from_millis(150));
            }
        }
    }
    Err(last.unwrap_or_else(|| std::io::Error::new(std::io::ErrorKind::NotConnected, "no server socket")))
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

/// Decode a chunked-transfer body (`<hex>\r\n<data>\r\n…0\r\n\r\n`) into bytes.
fn dechunk(mut data: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    while let Some(nl) = find(data, b"\r\n") {
        let size = std::str::from_utf8(&data[..nl])
            .ok()
            .and_then(|s| usize::from_str_radix(s.trim().split(';').next().unwrap_or("").trim(), 16).ok());
        let Some(size) = size else { break };
        data = &data[nl + 2..];
        if size == 0 || data.len() < size {
            break;
        }
        out.extend_from_slice(&data[..size]);
        data = &data[size..];
        if data.len() >= 2 {
            data = &data[2..]; // trailing CRLF
        }
    }
    out
}

/// Parse a buffered HTTP/1.1 response into (status, headers, body).
fn parse_response(raw: &[u8]) -> Result<ApiResponse, String> {
    let sep = find(raw, b"\r\n\r\n").ok_or("malformed response (no header terminator)")?;
    let head = String::from_utf8_lossy(&raw[..sep]);
    let body_bytes = &raw[sep + 4..];

    let mut lines = head.lines();
    let status = lines
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|s| s.parse::<u16>().ok())
        .ok_or("malformed response (no status)")?;

    // Keep the response headers, but drop the hop-by-hop framing: the body is
    // de-chunked below and re-served by the webview's `Response`, which sets its
    // own length, so a stale content-length/transfer-encoding would corrupt it.
    let mut headers = Vec::new();
    let mut chunked = false;
    for line in lines {
        let Some((name, value)) = line.split_once(':') else { continue };
        let (name, value) = (name.trim(), value.trim());
        match name.to_ascii_lowercase().as_str() {
            "transfer-encoding" => chunked = value.eq_ignore_ascii_case("chunked"),
            "content-length" | "connection" => {}
            _ => headers.push((name.to_string(), value.to_string())),
        }
    }

    let body = if chunked { dechunk(body_bytes) } else { body_bytes.to_vec() };
    Ok(ApiResponse {
        status,
        headers,
        body: String::from_utf8_lossy(&body).into_owned(),
    })
}

fn blocking_request(
    conn: &ConnInfo,
    method: &str,
    path: &str,
    headers: &[(String, String)],
    body: Option<&str>,
) -> Result<ApiResponse, String> {
    let mut stream = connect_retry(conn, 60).map_err(|e| format!("ipc connect failed: {e}"))?;
    let body = body.unwrap_or("");
    // The host owns the framing headers (Host/Connection/Content-Length); forward
    // everything else from the caller and default the content type when absent.
    let mut request = format!("{method} {path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n");
    let mut has_content_type = false;
    for (name, value) in headers {
        match name.to_ascii_lowercase().as_str() {
            "host" | "connection" | "content-length" | "transfer-encoding" => continue,
            "content-type" => has_content_type = true,
            _ => {}
        }
        request.push_str(&format!("{name}: {value}\r\n"));
    }
    if !has_content_type {
        request.push_str("Content-Type: application/json\r\n");
    }
    request.push_str(&format!("Content-Length: {}\r\n\r\n{body}", body.len()));
    stream.write_all(request.as_bytes()).map_err(|e| e.to_string())?;
    stream.flush().ok();
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).map_err(|e| e.to_string())?;
    parse_response(&raw)
}

/// Tunnel one HTTP request to the local server over the host socket. The webview
/// passes the verbatim API path (e.g. `/api/pages`); the blocking socket IO runs
/// off the async runtime.
#[tauri::command]
pub async fn api_request(
    state: State<'_, AppState>,
    method: String,
    path: String,
    headers: Vec<(String, String)>,
    body: Option<String>,
) -> Result<ApiResponse, String> {
    let conn = ConnInfo::from_state(&state);
    tauri::async_runtime::spawn_blocking(move || blocking_request(&conn, &method, &path, &headers, body.as_deref()))
        .await
        .map_err(|e| e.to_string())?
}

/// A `Read` that decodes HTTP/1.1 chunked transfer encoding on the fly, so the
/// SSE parser above it sees a clean byte stream.
struct ChunkedReader<R: BufRead> {
    inner: R,
    remaining: usize,
    done: bool,
}

impl<R: BufRead> ChunkedReader<R> {
    fn new(inner: R) -> Self {
        ChunkedReader { inner, remaining: 0, done: false }
    }
}

impl<R: BufRead> Read for ChunkedReader<R> {
    fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
        if self.done {
            return Ok(0);
        }
        if self.remaining == 0 {
            let mut line = String::new();
            if self.inner.read_line(&mut line)? == 0 {
                self.done = true;
                return Ok(0);
            }
            let hex = line.trim().split(';').next().unwrap_or("");
            let size = usize::from_str_radix(hex, 16)
                .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidData, "bad chunk size"))?;
            if size == 0 {
                self.done = true;
                return Ok(0);
            }
            self.remaining = size;
        }
        let want = out.len().min(self.remaining);
        let n = self.inner.read(&mut out[..want])?;
        self.remaining -= n;
        if self.remaining == 0 {
            let mut crlf = [0u8; 2];
            let _ = self.inner.read_exact(&mut crlf); // consume the chunk's trailing CRLF
        }
        Ok(n)
    }
}

/// Stream `/api/live` over the socket once, emitting each SSE frame as a Tauri
/// event. Returns when the connection ends (server restart / publish respawn).
fn run_live_once(app: &AppHandle, conn: &ConnInfo) -> std::io::Result<()> {
    let stream = connect_retry(conn, 60)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::NotConnected, e))?;
    let mut reader = BufReader::new(stream);
    reader.get_mut().write_all(
        b"GET /api/live HTTP/1.1\r\nHost: localhost\r\nAccept: text/event-stream\r\nConnection: keep-alive\r\n\r\n",
    )?;
    reader.get_mut().flush().ok();

    // Consume the response headers; note whether the body is chunked (it is).
    let mut chunked = false;
    let mut line = String::new();
    loop {
        line.clear();
        if reader.read_line(&mut line)? == 0 {
            return Ok(());
        }
        if line.to_ascii_lowercase().contains("transfer-encoding: chunked") {
            chunked = true;
        }
        if line == "\r\n" || line == "\n" {
            break;
        }
    }

    // Connected: tell the webview so it resyncs (OB-132), then stream frames.
    let _ = app.emit("openbook://live-status", "open");

    let mut body: Box<dyn BufRead> = if chunked {
        Box::new(BufReader::new(ChunkedReader::new(reader)))
    } else {
        Box::new(reader)
    };

    let mut event = String::new();
    let mut data = String::new();
    loop {
        line.clear();
        if body.read_line(&mut line)? == 0 {
            return Ok(()); // stream ended
        }
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed.is_empty() {
            if !data.is_empty() {
                let _ = app.emit(
                    "openbook://live",
                    LiveFrame { event: std::mem::take(&mut event), data: std::mem::take(&mut data) },
                );
            }
            event.clear();
            data.clear();
        } else if let Some(rest) = trimmed.strip_prefix("event:") {
            event = rest.trim().to_string();
        } else if let Some(rest) = trimmed.strip_prefix("data:") {
            if !data.is_empty() {
                data.push('\n');
            }
            data.push_str(rest.strip_prefix(' ').unwrap_or(rest));
        }
        // id:/retry:/comments are ignored.
    }
}

/// Start the background live bridge: stream the server's SSE feed and re-emit it
/// to all windows, reconnecting (with a disconnect notice) across server restarts.
pub fn start_live_bridge(app: AppHandle, conn: ConnInfo) {
    std::thread::spawn(move || loop {
        let _ = run_live_once(&app, &conn);
        // Dropped (startup race, or a publish respawn) — tell the webview so it
        // re-syncs on the next open, then retry.
        let _ = app.emit("openbook://live-status", "error");
        std::thread::sleep(Duration::from_millis(500));
    });
}
