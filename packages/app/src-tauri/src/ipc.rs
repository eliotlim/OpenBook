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

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use base64::Engine; // brings `.encode`/`.decode` into scope for the chunk codec
use serde::Serialize;
use tauri::ipc::Channel;
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
    /// Per-run local-owner secret (the loopback-owner hatch). Stamped as
    /// `X-OpenBook-Local` on webview-originated requests — and ONLY those: a
    /// request already carrying the tunnel's `X-OpenBook-Forwarded` marker came
    /// from a remote viewer and must never gain machine-owner authority, so the
    /// bridge both withholds the stamp there and drops any inbound imitation.
    pub local_secret: String,
}

/// The tunnel client's forwarded-request marker (`FORWARDED_HEADER` in the SDK).
const FORWARDED_HEADER: &str = "x-openbook-forwarded";
/// The local-owner secret header (`LOCAL_OWNER_HEADER` in the SDK).
const LOCAL_OWNER_HEADER: &str = "x-openbook-local";

impl ConnInfo {
    pub fn from_state(state: &AppState) -> Self {
        ConnInfo {
            socket_path: state.socket_path.clone(),
            local_port: state.local_port,
            local_secret: state.local_secret.clone(),
        }
    }
}

/// Append the caller's headers to a hand-built HTTP/1.1 request, applying the
/// bridge's header policy: the host owns the framing headers, the content type
/// defaults to JSON, the caller can never supply the local-owner secret itself,
/// and the secret is stamped only when the request is NOT tunnel-forwarded.
fn push_headers(request: &mut String, headers: &[(String, String)], local_secret: &str) {
    let forwarded = headers
        .iter()
        .any(|(name, _)| name.eq_ignore_ascii_case(FORWARDED_HEADER));
    let mut has_content_type = false;
    for (name, value) in headers {
        match name.to_ascii_lowercase().as_str() {
            "host" | "connection" | "content-length" | "transfer-encoding" => continue,
            // Never forward a caller-supplied copy of the secret header: the value
            // below is the only source of truth (a forwarded request that smuggled
            // one in is dropped here; the server also ignores it on the forwarded
            // path — defence in depth).
            LOCAL_OWNER_HEADER => continue,
            "content-type" => has_content_type = true,
            _ => {}
        }
        request.push_str(&format!("{name}: {value}\r\n"));
    }
    if !has_content_type {
        request.push_str("Content-Type: application/json\r\n");
    }
    if !forwarded && !local_secret.is_empty() {
        request.push_str(&format!("X-OpenBook-Local: {local_secret}\r\n"));
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

/// Shuts the underlying socket down (`Shutdown::Both`) from another thread,
/// unblocking a `read` that is parked on an infinite stream — see
/// [`api_request_stream`]'s cancellation. Called at most once.
type ShutdownFn = Box<dyn FnOnce() + Send>;

/// Open the socket and return it alongside a [`ShutdownFn`] over a *clone* of it.
/// The clone shares the same underlying socket, so shutting it down from the
/// abort task unblocks the streaming read on the original (no busy-poll).
#[cfg(unix)]
fn connect_with_shutdown(conn: &ConnInfo) -> std::io::Result<(Box<dyn Stream>, ShutdownFn)> {
    use std::net::Shutdown;
    use std::os::unix::net::UnixStream;
    let stream = UnixStream::connect(&conn.socket_path)?;
    stream.set_read_timeout(Some(Duration::from_secs(180)))?;
    let dup = stream.try_clone()?;
    let shutdown: ShutdownFn = Box::new(move || {
        let _ = dup.shutdown(Shutdown::Both);
    });
    Ok((Box::new(stream), shutdown))
}

#[cfg(not(unix))]
fn connect_with_shutdown(conn: &ConnInfo) -> std::io::Result<(Box<dyn Stream>, ShutdownFn)> {
    use std::net::{Shutdown, TcpStream};
    let stream = TcpStream::connect(("127.0.0.1", conn.local_port))?;
    stream.set_read_timeout(Some(Duration::from_secs(180)))?;
    let dup = stream.try_clone()?;
    let shutdown: ShutdownFn = Box::new(move || {
        let _ = dup.shutdown(Shutdown::Both);
    });
    Ok((Box::new(stream), shutdown))
}

fn connect(conn: &ConnInfo) -> std::io::Result<Box<dyn Stream>> {
    Ok(connect_with_shutdown(conn)?.0)
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

/// Like [`connect_retry`], but also hands back the [`ShutdownFn`] the streaming
/// path uses to cancel an in-flight read.
fn connect_with_shutdown_retry(conn: &ConnInfo, attempts: u32) -> std::io::Result<(Box<dyn Stream>, ShutdownFn)> {
    let mut last: Option<std::io::Error> = None;
    for _ in 0..attempts {
        match connect_with_shutdown(conn) {
            Ok(v) => return Ok(v),
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
    // everything else from the caller (per the bridge's header policy) and default
    // the content type when absent.
    let mut request = format!("{method} {path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n");
    push_headers(&mut request, headers, &conn.local_secret);
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

// ── Streaming request bridge (the forwarding tunnel) ─────────────────────────
//
// `api_request` above buffers the whole response (`read_to_end`) before
// returning — fine for finite `/api` calls, fatal for `/api/live`, which never
// closes. The forwarding tunnel serves arbitrary inbound requests (including a
// browser's `EventSource` to `/api/live`) over this same socket; buffering an
// infinite SSE body forwards NOTHING and the relay aborts at 120s (OB-284). So
// the tunnel uses `api_request_stream` instead: it sends the status+headers as
// soon as they're known, then each body chunk as it arrives, over a per-call
// `Channel` — the streaming sibling of the `/api/live` bridge below.
//
// Delivery rides a Tauri `ipc::Channel<StreamMessage>` rather than an app-global
// `emit`: the channel is scoped to the one invocation (no cross-window id
// collision) and ordered by construction (`Head` → `Chunk`s → terminal), so the
// webview never has to reassemble or de-dupe. Channels are Rust→JS only, so
// cancellation still flows back through `api_request_abort` keyed by the same
// caller-minted (globally unique) `stream_id`.

/// One message in a streamed response, sent over the request's `Channel`. `head`
/// lands first (so the tunnel can answer HTTP 200 promptly), then `chunk`s as the
/// body arrives, then exactly one terminal `end`/`error`.
#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum StreamMessage {
    Head { status: u16, headers: Vec<(String, String)> },
    /// A body slice, **base64-encoded** so any response type streams verbatim
    /// (the webview decodes it back to a `Uint8Array`). Serde would otherwise
    /// emit a `Vec<u8>` as a JSON integer array — ~4–6× expansion over the bridge,
    /// which the tunnel now pays on EVERY forwarded request (incl. large
    /// export/asset downloads); base64 is ~1.33× and stays byte-exact.
    Chunk { data: String },
    End,
    Error { message: String },
}

/// An in-flight streaming request, keyed by the caller-minted (UUID) request id.
/// The `shutdown` handle (a clone of the socket) lets [`api_request_abort`]
/// unblock the parked read; `cancelled` covers the brief window before `connect`
/// returns a socket to shut down (an abort that races the dial is remembered, not
/// lost). The id is a UUID minted in the webview, so it's unique across windows.
struct StreamSlot {
    cancelled: bool,
    shutdown: Option<ShutdownFn>,
}

fn streams() -> &'static Mutex<HashMap<String, StreamSlot>> {
    static STREAMS: OnceLock<Mutex<HashMap<String, StreamSlot>>> = OnceLock::new();
    STREAMS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Stream one HTTP request to the local server, sending the response back over
/// `channel` instead of buffering it. Used by the forwarding tunnel's `localFetch`
/// so SSE (and any response) flows live rather than blocking on `read_to_end`.
/// Resolves when the stream ends or is aborted via [`api_request_abort`].
#[tauri::command]
pub async fn api_request_stream(
    state: State<'_, AppState>,
    stream_id: String,
    method: String,
    path: String,
    headers: Vec<(String, String)>,
    body: Option<String>,
    channel: Channel<StreamMessage>,
) -> Result<(), String> {
    let conn = ConnInfo::from_state(&state);
    tauri::async_runtime::spawn_blocking(move || {
        let result = stream_request(&channel, &conn, &stream_id, &method, &path, &headers, body.as_deref());
        // A terminal frame so the webview can close (or error) its ReadableStream;
        // harmless if the consumer already cancelled after an abort.
        match result {
            Ok(()) => {
                let _ = channel.send(StreamMessage::End);
            }
            Err(e) => {
                let _ = channel.send(StreamMessage::Error { message: e.to_string() });
            }
        }
        streams().lock().unwrap().remove(&stream_id);
    })
    .await
    .map_err(|e| e.to_string())
}

/// Abort an in-flight [`api_request_stream`] (the tunnel request was cancelled —
/// the viewer closed the page / the relay dropped the exchange). The `Channel` is
/// Rust→JS only, so this is the JS→Rust half: shut the socket down so the parked
/// read returns at once, and remember the cancel if the dial hasn't produced a
/// socket yet.
#[tauri::command]
pub fn api_request_abort(stream_id: String) {
    let mut map = streams().lock().unwrap();
    if let Some(slot) = map.get_mut(&stream_id) {
        slot.cancelled = true;
        if let Some(shutdown) = slot.shutdown.take() {
            drop(map); // don't hold the lock across the socket shutdown
            shutdown();
        }
    }
}

fn stream_request(
    channel: &Channel<StreamMessage>,
    conn: &ConnInfo,
    stream_id: &str,
    method: &str,
    path: &str,
    headers: &[(String, String)],
    body: Option<&str>,
) -> std::io::Result<()> {
    // Register before dialing so an abort that races the (retrying) connect is
    // remembered and applied the instant we hold a socket.
    streams().lock().unwrap().insert(stream_id.to_string(), StreamSlot { cancelled: false, shutdown: None });

    let (stream, shutdown) = match connect_with_shutdown_retry(conn, 60) {
        Ok(v) => v,
        Err(e) => {
            streams().lock().unwrap().remove(stream_id);
            return Err(std::io::Error::new(std::io::ErrorKind::NotConnected, format!("ipc connect failed: {e}")));
        }
    };
    // Install the shutdown handle — unless an abort already arrived during the
    // dial, in which case tear down immediately rather than stream into the void.
    {
        let mut map = streams().lock().unwrap();
        match map.get_mut(stream_id) {
            Some(slot) if slot.cancelled => {
                drop(map);
                shutdown();
                return Ok(());
            }
            Some(slot) => slot.shutdown = Some(shutdown),
            None => return Ok(()), // removed already; nothing to do
        }
    }

    let mut reader = BufReader::new(stream);
    // Keep-alive (not `close`): the server streams an infinite body (SSE) rather
    // than being asked to end after one response. The host owns the framing
    // headers; forward the rest and default the content type when absent — mirrors
    // `blocking_request`.
    let body = body.unwrap_or("");
    let mut request = format!("{method} {path} HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n");
    push_headers(&mut request, headers, &conn.local_secret);
    request.push_str(&format!("Content-Length: {}\r\n\r\n{body}", body.len()));
    reader.get_mut().write_all(request.as_bytes())?;
    reader.get_mut().flush().ok();

    // Parse the status line + headers, noting the body framing.
    let mut line = String::new();
    if reader.read_line(&mut line)? == 0 {
        return Ok(()); // closed before any response
    }
    let status: u16 = line
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidData, "malformed status line"))?;

    let mut headers_out: Vec<(String, String)> = Vec::new();
    let mut chunked = false;
    let mut content_length: Option<usize> = None;
    loop {
        line.clear();
        if reader.read_line(&mut line)? == 0 {
            break;
        }
        if line == "\r\n" || line == "\n" {
            break;
        }
        let Some((name, value)) = line.split_once(':') else { continue };
        let (name, value) = (name.trim(), value.trim());
        match name.to_ascii_lowercase().as_str() {
            // Strip hop-by-hop framing — the webview's `Response` re-frames the body.
            "transfer-encoding" => chunked = value.eq_ignore_ascii_case("chunked"),
            "content-length" => content_length = value.parse().ok(),
            "connection" => {}
            _ => headers_out.push((name.to_string(), value.to_string())),
        }
    }

    // Send the head as soon as it's known so the tunnel answers HTTP 200 promptly
    // (the browser's EventSource sees `open` instead of waiting out the abort).
    // A `send` error means the channel's webview-side consumer is already gone
    // (e.g. a reload that never fired `api_request_abort`): self-reap rather than
    // stream into the void. Returning `Ok(())` drops the socket here and lets the
    // caller remove the registry entry, so the `spawn_blocking` thread is freed.
    if channel.send(StreamMessage::Head { status, headers: headers_out }).is_err() {
        return Ok(());
    }

    // Stream the body. De-chunk on the fly (SSE is chunked); a fixed-length body
    // reads exactly `content-length`; anything else reads to EOF.
    let mut body_reader: Box<dyn Read> = if chunked {
        Box::new(ChunkedReader::new(reader))
    } else {
        Box::new(reader)
    };
    let mut remaining = content_length;
    let mut buf = [0u8; 16 * 1024];
    loop {
        if remaining == Some(0) {
            break;
        }
        let n = match body_reader.read(&mut buf) {
            Ok(0) => break, // EOF, the 0-chunk, or an abort shutdown
            Ok(n) => n,
            // The 180s read timeout is a liveness backstop, not stream-end: an SSE
            // stream that's idle between frames (or a slow `EISCONN` retry) surfaces
            // as `WouldBlock`/`TimedOut` — keep waiting, don't tear it down. Only a
            // real socket error / EOF (above) ends the stream; an abort closes the
            // socket, which returns EOF here.
            Err(ref e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::Interrupted | std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                continue
            }
            Err(e) => return Err(e),
        };
        // Base64 keeps the payload compact (vs. serde's JSON integer array) and
        // byte-exact. A `send` error means the consumer was torn down without an
        // `api_request_abort` (webview reload): self-reap on this frame instead of
        // parking the thread until the read times out / the next ping closes us.
        let encoded = base64::engine::general_purpose::STANDARD.encode(&buf[..n]);
        if channel.send(StreamMessage::Chunk { data: encoded }).is_err() {
            return Ok(());
        }
        if let Some(r) = remaining.as_mut() {
            *r = r.saturating_sub(n);
        }
    }
    Ok(())
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
    // The live bridge is the app's own subscription, so it carries the local-owner
    // stamp: without it the feed resolves as an anonymous guest and, on a claimed
    // instance, is silently filtered down to guest-readable pages (or rejected
    // outright under `guestAccess: 'off'`) — the desktop's own sidebar would stop
    // updating for restricted pages.
    let mut request = String::from(
        "GET /api/live HTTP/1.1\r\nHost: localhost\r\nAccept: text/event-stream\r\nConnection: keep-alive\r\n",
    );
    if !conn.local_secret.is_empty() {
        request.push_str(&format!("X-OpenBook-Local: {}\r\n", conn.local_secret));
    }
    request.push_str("\r\n");
    reader.get_mut().write_all(request.as_bytes())?;
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

#[cfg(test)]
mod chunk_codec_tests {
    use base64::Engine;

    /// `StreamMessage::Chunk` carries the body as base64 (compact over the bridge);
    /// `tauriStreamFetch`'s `base64ToBytes` decodes it back. Prove the wire form
    /// round-trips EVERY byte value — including non-UTF-8 bytes a raw `Vec<u8>`
    /// would have survived — so the swap stays byte-exact.
    #[test]
    fn base64_chunk_roundtrip_is_byte_exact() {
        let original: Vec<u8> = (0..=255u8).cycle().take(4096).collect();
        let encoded = base64::engine::general_purpose::STANDARD.encode(&original);
        // The encoded payload is pure ASCII, so no raw bytes leak into the JSON
        // string serde emits for the `Channel`.
        assert!(encoded.is_ascii());
        let decoded = base64::engine::general_purpose::STANDARD.decode(&encoded).unwrap();
        assert_eq!(decoded, original);
    }

    /// Pin the exact encoding the webview's `atob` must agree with (standard
    /// alphabet, `=`-padded) so an accidental engine swap is caught.
    #[test]
    fn base64_chunk_matches_known_vector() {
        let enc = base64::engine::general_purpose::STANDARD.encode(b"OpenBook \x00\xff");
        assert_eq!(enc, "T3BlbkJvb2sgAP8=");
        assert_eq!(
            base64::engine::general_purpose::STANDARD.decode(enc).unwrap(),
            b"OpenBook \x00\xff"
        );
    }
}
