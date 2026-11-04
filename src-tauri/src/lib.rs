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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(InFlight::default())
        .invoke_handler(tauri::generate_handler![send_request, cancel_request, save_text_file, save_base64_file, open_url, oauth_listen])
        .run(tauri::generate_context!())
        .expect("error while running Dispatch");
}
