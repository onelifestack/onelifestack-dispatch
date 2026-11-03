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
    timeout_ms: u64,
    follow_redirects: bool,
    insecure_tls: bool,
}

#[derive(Serialize)]
pub struct SendResponse {
    status: u16,
    status_text: String,
    headers: Vec<(String, String)>,
    body_base64: String,
    time_ms: u64,
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
    if let Some(body) = req.body {
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(InFlight::default())
        .invoke_handler(tauri::generate_handler![send_request, cancel_request, save_text_file])
        .run(tauri::generate_context!())
        .expect("error while running Dispatch");
}
