//! Dispatch desktop shell. The UI is the same web app; this side sends requests natively, so there are
//! no browser CORS limits or forbidden headers, and it can (opt-in) accept self-signed certificates.

use std::collections::{HashMap, HashSet};
use std::error::Error as _;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use tauri_plugin_dialog::DialogExt;
use tokio::sync::oneshot;

pub mod grpc;

#[derive(Deserialize)]
pub struct SendRequest {
    id: u64,
    method: String,
    url: String,
    headers: Vec<(String, String)>,
    body: Option<String>,
    /// Binary body.
    body_base64: Option<String>,
    /// Form-data parts.
    multipart: Option<Vec<Part>>,
    timeout_ms: u64,
    follow_redirects: bool,
    insecure_tls: bool,
    /// Proxy URL (http://, https:// or socks5://), and hosts that skip it.
    #[serde(default)]
    proxy: Option<String>,
    #[serde(default)]
    no_proxy: Option<String>,
    /// Client certificate and key (PEM) for mutual TLS.
    #[serde(default)]
    client_cert_pem: Option<String>,
    #[serde(default)]
    client_key_pem: Option<String>,
    /// Extra CA certificates (PEM) to trust, e.g. a homelab CA.
    #[serde(default)]
    ca_certs_pem: Vec<String>,
}

#[derive(Deserialize)]
pub struct Part {
    name: String,
    value: Option<String>,
    file_name: Option<String>,
    content_type: Option<String>,
    data_base64: Option<String>,
}

#[derive(Serialize)]
pub struct SendResponse {
    status: u16,
    status_text: String,
    headers: Vec<(String, String)>,
    body_base64: String,
    time_ms: u64,
    ttfb_ms: u64,
}

/// Requests in flight, so the UI can cancel one by id.
#[derive(Default)]
struct InFlight(Mutex<HashMap<u64, oneshot::Sender<()>>>);

/// The error and its causes on one line ("error sending request: connection refused").
fn describe(e: &reqwest::Error) -> String {
    let mut msg = e.to_string();
    let mut src = e.source();
    while let Some(s) = src {
        let part = s.to_string();
        if !msg.contains(&part) {
            msg.push_str(": ");
            msg.push_str(&part);
        }
        src = s.source();
    }
    msg
}

async fn perform(req: SendRequest) -> Result<SendResponse, String> {
    let method = reqwest::Method::from_bytes(req.method.as_bytes()).map_err(|_| format!("Unknown method {}.", req.method))?;
    let mut cb = reqwest::Client::builder()
        .timeout(Duration::from_millis(req.timeout_ms))
        .redirect(if req.follow_redirects { reqwest::redirect::Policy::limited(10) } else { reqwest::redirect::Policy::none() })
        .danger_accept_invalid_certs(req.insecure_tls)
        .user_agent(concat!("Dispatch/", env!("CARGO_PKG_VERSION")));
    if let Some(p) = req.proxy.as_deref().filter(|p| !p.trim().is_empty()) {
        let mut proxy = reqwest::Proxy::all(p.trim()).map_err(|e| format!("The proxy address isn’t valid: {e}"))?;
        if let Some(np) = req.no_proxy.as_deref().filter(|x| !x.trim().is_empty()) { proxy = proxy.no_proxy(reqwest::NoProxy::from_string(np)); }
        cb = cb.proxy(proxy);
    } else {
        cb = cb.no_proxy();
    }
    if let (Some(cert), Some(key)) = (req.client_cert_pem.as_deref(), req.client_key_pem.as_deref()) {
        let identity = reqwest::Identity::from_pem(format!("{cert}\n{key}").as_bytes()).map_err(|e| format!("The client certificate or key couldn’t be read: {}", describe(&e)))?;
        cb = cb.identity(identity);
    }
    for pem in &req.ca_certs_pem {
        for c in reqwest::Certificate::from_pem_bundle(pem.as_bytes()).map_err(|e| format!("A CA certificate couldn’t be read: {}", describe(&e)))? { cb = cb.add_root_certificate(c); }
    }
    let client = cb.build().map_err(|e| describe(&e))?;

    let mut builder = client.request(method, &req.url);
    for (k, v) in &req.headers {
        let name = reqwest::header::HeaderName::from_bytes(k.as_bytes()).map_err(|_| format!("“{k}” isn’t a valid header name."))?;
        let value = reqwest::header::HeaderValue::from_str(v).map_err(|_| format!("The value of header “{k}” has characters that can’t be sent."))?;
        builder = builder.header(name, value);
    }
    if let Some(parts) = req.multipart {
        let mut form = reqwest::multipart::Form::new();
        for p in parts {
            if let Some(data) = p.data_base64 {
                let bytes = STANDARD.decode(data).map_err(|_| format!("The file for “{}” couldn’t be read.", p.name))?;
                let mut part = reqwest::multipart::Part::bytes(bytes).file_name(p.file_name.unwrap_or_else(|| "file".into()));
                if let Some(ct) = p.content_type {
                    part = part.mime_str(&ct).map_err(|_| format!("“{ct}” isn’t a valid content type."))?;
                }
                form = form.part(p.name, part);
            } else {
                form = form.text(p.name, p.value.unwrap_or_default());
            }
        }
        builder = builder.multipart(form);
    } else if let Some(data) = req.body_base64 {
        builder = builder.body(STANDARD.decode(data).map_err(|_| "The body file couldn’t be read.".to_string())?);
    } else if let Some(body) = req.body {
        builder = builder.body(body);
    }

    let started = Instant::now();
    let res = builder.send().await.map_err(|e| {
        if e.is_timeout() {
            format!("No response after {} seconds.", req.timeout_ms / 1000)
        } else if e.is_connect() {
            format!("Couldn’t connect: {}", describe(&e))
        } else {
            describe(&e)
        }
    })?;
    let ttfb_ms = started.elapsed().as_millis() as u64;
    let status = res.status();
    let headers = res
        .headers()
        .iter()
        .map(|(k, v)| (k.as_str().to_string(), String::from_utf8_lossy(v.as_bytes()).into_owned()))
        .collect();
    let bytes = res.bytes().await.map_err(|e| if e.is_timeout() { format!("The response took longer than {} seconds.", req.timeout_ms / 1000) } else { describe(&e) })?;
    Ok(SendResponse {
        status: status.as_u16(),
        status_text: status.canonical_reason().unwrap_or("").to_string(),
        headers,
        body_base64: STANDARD.encode(&bytes),
        time_ms: started.elapsed().as_millis() as u64,
        ttfb_ms,
    })
}

/// The send path for tests: a SendRequest as JSON in, the SendResponse as JSON out.
pub async fn send_json(req: serde_json::Value) -> Result<serde_json::Value, String> {
    let req: SendRequest = serde_json::from_value(req).map_err(|e| e.to_string())?;
    let res = perform(req).await?;
    serde_json::to_value(res).map_err(|e| e.to_string())
}

#[tauri::command]
async fn send_request(state: tauri::State<'_, InFlight>, req: SendRequest) -> Result<SendResponse, String> {
    let id = req.id;
    let (tx, rx) = oneshot::channel();
    state.0.lock().unwrap().insert(id, tx);
    let out = tokio::select! {
        r = perform(req) => r,
        _ = rx => Err("Request cancelled.".to_string()),
    };
    state.0.lock().unwrap().remove(&id);
    out
}

#[tauri::command]
fn cancel_request(state: tauri::State<'_, InFlight>, id: u64) {
    if let Some(tx) = state.0.lock().unwrap().remove(&id) {
        let _ = tx.send(());
    }
}

/// Asks where to save and writes the file. Returns false when the user cancels the dialog.
#[tauri::command]
async fn save_text_file(app: tauri::AppHandle, file_name: String, contents: String) -> Result<bool, String> {
    let picked = app
        .dialog()
        .file()
        .set_file_name(&file_name)
        .add_filter("JSON", &["json"])
        .blocking_save_file();
    let Some(path) = picked else { return Ok(false) };
    let path = path.into_path().map_err(|e| e.to_string())?;
    std::fs::write(&path, contents).map_err(|e| format!("Couldn’t save {}: {e}", path.display()))?;
    Ok(true)
}

/// Saves bytes (base64) through the save dialog, for binary responses.
#[tauri::command]
async fn save_base64_file(app: tauri::AppHandle, file_name: String, base64: String) -> Result<bool, String> {
    let bytes = STANDARD.decode(base64).map_err(|_| "The data couldn’t be decoded.".to_string())?;
    let picked = app.dialog().file().set_file_name(&file_name).blocking_save_file();
    let Some(path) = picked else { return Ok(false) };
    let path = path.into_path().map_err(|e| e.to_string())?;
    std::fs::write(&path, bytes).map_err(|e| format!("Couldn’t save {}: {e}", path.display()))?;
    Ok(true)
}

/// Opens a URL in the system browser (OAuth login pages).
#[tauri::command]
fn open_url(app: tauri::AppHandle, url: String) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("Only http(s) links can be opened.".into());
    }
    use tauri_plugin_opener::OpenerExt;
    app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())
}

/// Waits once for the OAuth redirect on 127.0.0.1:<port><path>, answers with a short page and returns the URL
/// the browser was sent to (with ?code=…&state=…). Gives up after `timeout_secs`.
#[tauri::command]
async fn oauth_listen(port: u16, path: String, timeout_secs: u64) -> Result<String, String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await.map_err(|e| format!("Couldn’t listen on port {port}: {e}"))?;
    let wait = async {
        loop {
            let (mut sock, _) = listener.accept().await.map_err(|e| e.to_string())?;
            let mut buf = vec![0u8; 8192];
            let n = sock.read(&mut buf).await.map_err(|e| e.to_string())?;
            let head = String::from_utf8_lossy(&buf[..n]).to_string();
            let target = head.lines().next().and_then(|l| l.split_whitespace().nth(1)).unwrap_or("/").to_string();
            if !target.starts_with(&path) || !target.contains('?') {
                let _ = sock.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;
                continue;
            }
            let body = "<!doctype html><meta charset=utf-8><title>Dispatch</title><body style=\"font:16px system-ui;padding:3rem\"><h1>You’re signed in</h1><p>You can close this tab and go back to Dispatch.</p>";
            let resp = format!("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body);
            let _ = sock.write_all(resp.as_bytes()).await;
            return Ok::<String, String>(format!("http://127.0.0.1:{port}{target}"));
        }
    };
    tokio::time::timeout(Duration::from_secs(timeout_secs), wait).await.map_err(|_| "Timed out waiting for the login to finish.".to_string())?
}

// ---------- MCP over stdio (desktop) ----------
// Starts an MCP server process; its stdout lines and stderr come back as "mcp-stdio" events, and the app writes
// JSON-RPC lines to its stdin. The app asks the user before running a command.

#[derive(Default)]
struct McpProcs(Mutex<HashMap<u64, (tokio::process::ChildStdin, tauri::async_runtime::JoinHandle<()>)>>);

#[derive(Serialize, Clone)]
struct McpLine { id: u64, kind: String, text: String }

#[tauri::command]
async fn mcp_stdio_start(app: tauri::AppHandle, state: tauri::State<'_, McpProcs>, id: u64, command: String, args: Vec<String>, env: Vec<(String, String)>, cwd: Option<String>) -> Result<(), String> {
    use tauri::Emitter;
    use tokio::io::{AsyncBufReadExt, BufReader};
    let mut cmd = tokio::process::Command::new(&command);
    cmd.args(&args).envs(env).stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped()).kill_on_drop(true);
    if let Some(dir) = cwd.filter(|d| !d.trim().is_empty()) { cmd.current_dir(dir); }
    let mut child = cmd.spawn().map_err(|e| format!("Couldn’t start “{command}”: {e}"))?;
    let stdin = child.stdin.take().ok_or("No stdin")?;
    let stdout = child.stdout.take().ok_or("No stdout")?;
    let stderr = child.stderr.take().ok_or("No stderr")?;
    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(l)) = lines.next_line().await { let _ = app2.emit("mcp-stdio", McpLine { id, kind: "stderr".into(), text: l }); }
    });
    let handle = tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(l)) = lines.next_line().await { let _ = app.emit("mcp-stdio", McpLine { id, kind: "line".into(), text: l }); }
        let code = child.wait().await.ok().and_then(|s| s.code()).map(|c| c.to_string()).unwrap_or_else(|| "?".into());
        let _ = app.emit("mcp-stdio", McpLine { id, kind: "exit".into(), text: code });
    });
    state.0.lock().unwrap().insert(id, (stdin, handle));
    Ok(())
}

#[tauri::command]
async fn mcp_stdio_send(state: tauri::State<'_, McpProcs>, id: u64, line: String) -> Result<(), String> {
    use tokio::io::AsyncWriteExt;
    let stdin = state.0.lock().unwrap().remove(&id);
    let Some((mut stdin, handle)) = stdin else { return Err("The MCP server isn’t running.".into()) };
    let r = async { stdin.write_all(line.as_bytes()).await?; stdin.write_all(b"\n").await?; stdin.flush().await }.await;
    state.0.lock().unwrap().insert(id, (stdin, handle));
    r.map_err(|e| format!("Couldn’t write to the MCP server: {e}"))
}

#[tauri::command]
fn mcp_stdio_stop(state: tauri::State<'_, McpProcs>, id: u64) {
    if let Some((_, handle)) = state.0.lock().unwrap().remove(&id) { handle.abort(); } // dropping the child kills it
}

// ---------- Server-sent events (desktop) ----------

#[derive(Default)]
struct SseStreams(Mutex<HashMap<u64, tauri::async_runtime::JoinHandle<()>>>);

#[derive(Deserialize)]
pub struct SseOpen { id: u64, url: String, headers: Vec<(String, String)>, insecure_tls: bool }

#[derive(Serialize, Clone)]
struct SseMsg { id: u64, kind: String, text: String, status: u16 }

/// Opens an event stream; text arrives as "sse" events (kind: open, chunk, closed, error). The app parses it.
#[tauri::command]
fn sse_open(app: tauri::AppHandle, state: tauri::State<'_, SseStreams>, req: SseOpen) -> Result<(), String> {
    use futures_util::StreamExt;
    use tauri::Emitter;
    let id = req.id;
    let handle = tauri::async_runtime::spawn(async move {
        let emit = |kind: &str, text: String, status: u16| { let _ = app.emit("sse", SseMsg { id, kind: kind.into(), text, status }); };
        let client = match reqwest::Client::builder().danger_accept_invalid_certs(req.insecure_tls).build() { Ok(c) => c, Err(e) => { emit("error", describe(&e), 0); return; } };
        let mut b = client.get(&req.url).header("Accept", "text/event-stream").header("Cache-Control", "no-cache");
        for (k, v) in &req.headers { b = b.header(k, v); }
        match b.send().await {
            Err(e) => emit("error", describe(&e), 0),
            Ok(res) => {
                let status = res.status().as_u16();
                emit("open", res.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("").to_string(), status);
                let mut stream = res.bytes_stream();
                let mut pending: Vec<u8> = vec![];
                while let Some(chunk) = stream.next().await {
                    match chunk {
                        Ok(bytes) => {
                            pending.extend_from_slice(&bytes);
                            // Only hand over complete UTF-8; keep a split character for the next chunk.
                            let cut = match std::str::from_utf8(&pending) { Ok(_) => pending.len(), Err(e) => e.valid_up_to() };
                            let text = String::from_utf8_lossy(&pending[..cut]).to_string();
                            pending.drain(..cut);
                            if !text.is_empty() { emit("chunk", text, status); }
                        }
                        Err(e) => { emit("error", describe(&e), status); return; }
                    }
                }
                emit("closed", String::new(), status);
            }
        }
    });
    state.0.lock().unwrap().insert(id, handle);
    Ok(())
}

#[tauri::command]
fn sse_close(state: tauri::State<'_, SseStreams>, id: u64) {
    if let Some(h) = state.0.lock().unwrap().remove(&id) { h.abort(); }
}

/// Shows a desktop notification (scheduled runs that fail).
#[tauri::command]
fn notify_desktop(app: tauri::AppHandle, title: String, body: String) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;
    app.notification().builder().title(title).body(body).show().map_err(|e| e.to_string())
}

// ---------- Collections as files ----------

fn safe_join(root: &std::path::Path, rel: &str) -> Result<std::path::PathBuf, String> {
    let rel = std::path::Path::new(rel);
    if rel.is_absolute() || rel.components().any(|c| !matches!(c, std::path::Component::Normal(_))) {
        return Err(format!("Refusing to write outside the collection folder: {}", rel.display()));
    }
    Ok(root.join(rel))
}

const OURS: [&str; 3] = [".req.yaml", "_folder.yaml", "dispatch.collection.yaml"];

#[tauri::command]
async fn pick_folder(app: tauri::AppHandle) -> Option<String> {
    app.dialog().file().blocking_pick_folder().and_then(|p| p.into_path().ok()).map(|p| p.display().to_string())
}

/// Every Dispatch file under `root` (skips .git and node_modules; files over 2 MB are left out).
#[tauri::command]
fn read_collection_dir(root: String) -> Result<Vec<(String, String)>, String> { collection_dir_read(root) }

pub fn collection_dir_read(root: String) -> Result<Vec<(String, String)>, String> {
    let root = std::path::PathBuf::from(&root);
    if !root.join("dispatch.collection.yaml").exists() { return Err(format!("{} has no dispatch.collection.yaml.", root.display())); }
    let mut out = vec![];
    let mut stack = vec![root.clone()];
    while let Some(dir) = stack.pop() {
        for e in std::fs::read_dir(&dir).map_err(|e| format!("Couldn’t read {}: {e}", dir.display()))? {
            let e = e.map_err(|e| e.to_string())?;
            let p = e.path();
            let name = e.file_name().to_string_lossy().to_string();
            if p.is_dir() { if name != ".git" && name != "node_modules" { stack.push(p); } continue; }
            if !OURS.iter().any(|s| name.ends_with(s)) { continue; }
            if e.metadata().map(|m| m.len() > 2 * 1024 * 1024).unwrap_or(true) { continue; }
            let rel = p.strip_prefix(&root).map_err(|e| e.to_string())?.to_string_lossy().replace('\\', "/");
            let text = std::fs::read_to_string(&p).map_err(|e| format!("Couldn’t read {rel}: {e}"))?;
            out.push((rel, text));
        }
    }
    Ok(out)
}

/// Writes the files; with `prune`, also removes Dispatch files that aren't in the list (renames, moves,
/// deletes) and then empty folders. Never touches other files.
#[tauri::command]
fn write_collection_dir(root: String, files: Vec<(String, String)>, prune: bool) -> Result<(), String> { collection_dir_write(root, files, prune) }

pub fn collection_dir_write(root: String, files: Vec<(String, String)>, prune: bool) -> Result<(), String> {
    let root = std::path::PathBuf::from(&root);
    std::fs::create_dir_all(&root).map_err(|e| format!("Couldn’t create {}: {e}", root.display()))?;
    let mut keep = HashSet::new();
    for (rel, text) in &files {
        let p = safe_join(&root, rel)?;
        if let Some(parent) = p.parent() { std::fs::create_dir_all(parent).map_err(|e| e.to_string())?; }
        if std::fs::read_to_string(&p).ok().as_deref() != Some(text.as_str()) {
            std::fs::write(&p, text).map_err(|e| format!("Couldn’t write {rel}: {e}"))?;
        }
        keep.insert(p);
    }
    if prune {
        let mut dirs = vec![];
        let mut stack = vec![root.clone()];
        while let Some(dir) = stack.pop() {
            for e in std::fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
                let p = e.path();
                let name = e.file_name().to_string_lossy().to_string();
                if p.is_dir() { if name != ".git" && name != "node_modules" { dirs.push(p.clone()); stack.push(p); } continue; }
                if OURS.iter().any(|s| name.ends_with(s)) && !keep.contains(&p) { let _ = std::fs::remove_file(&p); }
            }
        }
        dirs.sort_by_key(|d| std::cmp::Reverse(d.components().count()));
        for d in dirs { let _ = std::fs::remove_dir(&d); } // only succeeds when empty
    }
    Ok(())
}

// ---------- Mock server ----------
// Rust only does the sockets: each request is sent to the app as a "mock-request" event and the app answers with
// mock_reply, using the same route matcher as the CLI (src/core/mock.ts). Listens on 127.0.0.1 only.

#[derive(Default)]
struct MockState {
    stop: Mutex<Option<oneshot::Sender<()>>>,
    waiting: Mutex<HashMap<u64, oneshot::Sender<MockReply>>>,
    next: std::sync::atomic::AtomicU64,
}

#[derive(Deserialize)]
pub struct MockReply {
    status: u16,
    headers: Vec<(String, String)>,
    body: String,
}

#[derive(Serialize, Clone)]
struct MockRequestEvent {
    id: u64,
    method: String,
    target: String,
    headers: Vec<(String, String)>,
    body: String,
}

fn reason(code: u16) -> &'static str {
    reqwest::StatusCode::from_u16(code).ok().and_then(|s| s.canonical_reason()).unwrap_or("")
}

async fn serve_one(mut sock: tokio::net::TcpStream, app: tauri::AppHandle, state: std::sync::Arc<MockState>) {
    use tauri::Emitter;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut buf = Vec::new();
    let mut tmp = [0u8; 8192];
    let head_end = loop {
        match sock.read(&mut tmp).await {
            Ok(0) | Err(_) => return,
            Ok(n) => buf.extend_from_slice(&tmp[..n]),
        }
        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") { break i; }
        if buf.len() > 64 * 1024 { return; }
    };
    let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
    let mut lines = head.split("\r\n");
    let mut first = lines.next().unwrap_or("").split_whitespace();
    let method = first.next().unwrap_or("GET").to_string();
    let target = first.next().unwrap_or("/").to_string();
    let headers: Vec<(String, String)> = lines.filter_map(|l| l.split_once(':').map(|(k, v)| (k.trim().to_string(), v.trim().to_string()))).collect();
    let len: usize = headers.iter().find(|(k, _)| k.eq_ignore_ascii_case("content-length")).and_then(|(_, v)| v.parse().ok()).unwrap_or(0).min(10 * 1024 * 1024);
    let mut body = buf[head_end + 4..].to_vec();
    while body.len() < len {
        match sock.read(&mut tmp).await { Ok(0) | Err(_) => break, Ok(n) => body.extend_from_slice(&tmp[..n]) }
    }
    let cors = "Access-Control-Allow-Origin: *\r\nAccess-Control-Allow-Headers: *\r\nAccess-Control-Allow-Methods: *\r\n";
    if method == "OPTIONS" {
        let _ = sock.write_all(format!("HTTP/1.1 204 No Content\r\n{cors}Content-Length: 0\r\nConnection: close\r\n\r\n").as_bytes()).await;
        return;
    }
    let id = state.next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let (tx, rx) = oneshot::channel();
    state.waiting.lock().unwrap().insert(id, tx);
    let _ = app.emit("mock-request", MockRequestEvent { id, method: method.clone(), target, headers, body: String::from_utf8_lossy(&body).to_string() });
    let reply = match tokio::time::timeout(Duration::from_secs(30), rx).await {
        Ok(Ok(r)) => r,
        _ => { state.waiting.lock().unwrap().remove(&id); MockReply { status: 504, headers: vec![], body: "{\"error\":\"the mock didn’t answer\"}".into() } }
    };
    let mut out = format!("HTTP/1.1 {} {}\r\n{cors}", reply.status, reason(reply.status));
    for (k, v) in &reply.headers {
        if k.eq_ignore_ascii_case("content-length") || k.eq_ignore_ascii_case("connection") || k.eq_ignore_ascii_case("transfer-encoding") { continue; }
        out.push_str(&format!("{}: {}\r\n", k.replace(['\r', '\n'], ""), v.replace(['\r', '\n'], "")));
    }
    let body = if method == "HEAD" { Vec::new() } else { reply.body.into_bytes() };
    out.push_str(&format!("Content-Length: {}\r\nConnection: close\r\n\r\n", body.len()));
    let _ = sock.write_all(out.as_bytes()).await;
    let _ = sock.write_all(&body).await;
}

#[tauri::command]
async fn mock_start(app: tauri::AppHandle, state: tauri::State<'_, std::sync::Arc<MockState>>, port: u16) -> Result<(), String> {
    let st = state.inner().clone();
    if let Some(stop) = st.stop.lock().unwrap().take() { let _ = stop.send(()); }
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await.map_err(|e| format!("Couldn’t start the mock on port {port}: {e}"))?;
    let (tx, mut rx) = oneshot::channel::<()>();
    *st.stop.lock().unwrap() = Some(tx);
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::select! {
                _ = &mut rx => break,
                acc = listener.accept() => {
                    if let Ok((sock, _)) = acc { tauri::async_runtime::spawn(serve_one(sock, app.clone(), st.clone())); }
                }
            }
        }
    });
    Ok(())
}

#[tauri::command]
fn mock_stop(state: tauri::State<'_, std::sync::Arc<MockState>>) {
    if let Some(stop) = state.stop.lock().unwrap().take() { let _ = stop.send(()); }
}

#[tauri::command]
fn mock_reply(state: tauri::State<'_, std::sync::Arc<MockState>>, id: u64, reply: MockReply) {
    if let Some(tx) = state.waiting.lock().unwrap().remove(&id) { let _ = tx.send(reply); }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .manage(InFlight::default())
        .manage(SseStreams::default())
        .manage(McpProcs::default())
        .manage(std::sync::Arc::new(MockState::default()))
        .invoke_handler(tauri::generate_handler![send_request, cancel_request, save_text_file, save_base64_file, open_url, oauth_listen, mock_start, mock_stop, mock_reply, grpc::grpc_describe, grpc::grpc_call, pick_folder, read_collection_dir, write_collection_dir, notify_desktop, sse_open, sse_close, mcp_stdio_start, mcp_stdio_send, mcp_stdio_stop])
        .run(tauri::generate_context!())
        .expect("error while running Dispatch");
}
