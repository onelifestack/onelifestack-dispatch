//! Dispatch desktop shell. The UI is the same web app; this side sends requests natively, so there are
//! no browser CORS limits or forbidden headers, and it can (opt-in) accept self-signed certificates.

use std::collections::HashMap;
use std::error::Error as _;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use tauri_plugin_dialog::DialogExt;
use tokio::sync::oneshot;

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
    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(req.timeout_ms))
        .redirect(if req.follow_redirects { reqwest::redirect::Policy::limited(10) } else { reqwest::redirect::Policy::none() })
        .danger_accept_invalid_certs(req.insecure_tls)
        .user_agent(concat!("Dispatch/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| describe(&e))?;

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
        .manage(InFlight::default())
        .manage(std::sync::Arc::new(MockState::default()))
        .invoke_handler(tauri::generate_handler![send_request, cancel_request, save_text_file, save_base64_file, open_url, oauth_listen, mock_start, mock_stop, mock_reply])
        .run(tauri::generate_context!())
        .expect("error while running Dispatch");
}
