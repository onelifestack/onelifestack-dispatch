//! A local MCP endpoint (Streamable HTTP, JSON responses) so AI assistants can use the open app: its collections,
//! the active environment, cookies and signed-in tokens. Off until turned on in Settings.
//!
//! Rust only guards and relays: it listens on 127.0.0.1, requires the bearer token from Settings, refuses requests
//! from web pages (an Origin header) and from other host names (DNS rebinding), then hands each JSON-RPC message to
//! the frontend, which answers with the same tools as `dispatch-run mcp`.

use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::oneshot;

const MAX_BODY: usize = 4 * 1024 * 1024;
/// A run_collection or run_flow can take a while.
const ANSWER_TIMEOUT: Duration = Duration::from_secs(600);

#[derive(Default)]
pub struct McpHost {
    stop: Mutex<Option<oneshot::Sender<()>>>,
    waiting: Mutex<HashMap<u64, oneshot::Sender<Option<String>>>>,
    next: AtomicU64,
}

#[derive(Clone, Serialize)]
struct McpHostRequest {
    id: u64,
    body: String,
}

fn same_bytes(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() { return false; }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

async fn respond(sock: &mut tokio::net::TcpStream, status: &str, extra: &str, body: &str) {
    let ct = if body.is_empty() { "" } else { "Content-Type: application/json\r\n" };
    let head = format!("HTTP/1.1 {status}\r\n{ct}{extra}Content-Length: {}\r\nConnection: close\r\n\r\n", body.len());
    let _ = sock.write_all(head.as_bytes()).await;
    let _ = sock.write_all(body.as_bytes()).await;
}

fn rpc_error(msg: &str) -> String {
    serde_json::json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32000, "message": msg } }).to_string()
}

async fn serve_one(mut sock: tokio::net::TcpStream, app: tauri::AppHandle, host: Arc<McpHost>, port: u16, token: Arc<String>) {
    use tauri::Emitter;
    let mut buf = Vec::new();
    let mut tmp = [0u8; 8192];
    let head_end = loop {
        match tokio::time::timeout(Duration::from_secs(30), sock.read(&mut tmp)).await {
            Ok(Ok(0)) | Ok(Err(_)) | Err(_) => return,
            Ok(Ok(n)) => buf.extend_from_slice(&tmp[..n]),
        }
        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") { break i; }
        if buf.len() > 64 * 1024 { return; }
    };
    let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
    let mut lines = head.split("\r\n");
    let mut first = lines.next().unwrap_or("").split_whitespace();
    let method = first.next().unwrap_or("").to_string();
    let target = first.next().unwrap_or("/").to_string();
    let headers: Vec<(String, String)> = lines.filter_map(|l| l.split_once(':').map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_string()))).collect();
    let header = |name: &str| headers.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str());

    // Web pages may not talk to it (browsers always send Origin on cross-site requests), nor other host names.
    if header("origin").is_some() {
        respond(&mut sock, "403 Forbidden", "", &rpc_error("Requests from web pages aren't accepted.")).await;
        return;
    }
    let host_ok = header("host").map(|h| h == format!("127.0.0.1:{port}") || h == format!("localhost:{port}")).unwrap_or(false);
    if !host_ok {
        respond(&mut sock, "403 Forbidden", "", &rpc_error("Use http://127.0.0.1:<port>/mcp.")).await;
        return;
    }
    let path = target.split('?').next().unwrap_or("");
    if path != "/mcp" {
        respond(&mut sock, "404 Not Found", "", &rpc_error("The MCP endpoint is /mcp.")).await;
        return;
    }
    let presented = header("authorization").and_then(|v| v.strip_prefix("Bearer ").or_else(|| v.strip_prefix("bearer "))).unwrap_or("");
    if token.is_empty() || !same_bytes(presented.trim().as_bytes(), token.as_bytes()) {
        respond(&mut sock, "401 Unauthorized", "WWW-Authenticate: Bearer\r\n", &rpc_error("Missing or wrong token. Copy it from Dispatch → Settings → AI assistants.")).await;
        return;
    }
    if method != "POST" {
        // No server-to-client stream: every answer comes back on the POST that asked.
        respond(&mut sock, "405 Method Not Allowed", "Allow: POST\r\n", "").await;
        return;
    }
    let len: usize = header("content-length").and_then(|v| v.parse().ok()).unwrap_or(0);
    if len > MAX_BODY {
        respond(&mut sock, "413 Payload Too Large", "", &rpc_error("Request too large.")).await;
        return;
    }
    let mut body = buf[head_end + 4..].to_vec();
    while body.len() < len {
        match sock.read(&mut tmp).await { Ok(0) | Err(_) => break, Ok(n) => body.extend_from_slice(&tmp[..n]) }
    }
    body.truncate(len);

    let id = host.next.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = oneshot::channel();
    host.waiting.lock().unwrap().insert(id, tx);
    let _ = app.emit("mcp-host-request", McpHostRequest { id, body: String::from_utf8_lossy(&body).to_string() });
    match tokio::time::timeout(ANSWER_TIMEOUT, rx).await {
        Ok(Ok(Some(answer))) => respond(&mut sock, "200 OK", "", &answer).await,
        Ok(Ok(None)) => respond(&mut sock, "202 Accepted", "", "").await,
        _ => {
            host.waiting.lock().unwrap().remove(&id);
            respond(&mut sock, "504 Gateway Timeout", "", &rpc_error("Dispatch didn't answer in time.")).await;
        }
    }
}

/// Starts (or restarts) the endpoint on 127.0.0.1:<port>.
#[tauri::command]
pub async fn mcp_host_start(app: tauri::AppHandle, state: tauri::State<'_, Arc<McpHost>>, port: u16, token: String) -> Result<(), String> {
    if token.len() < 32 { return Err("The token is too short; generate a new one.".into()); }
    let host = state.inner().clone();
    if let Some(stop) = host.stop.lock().unwrap().take() { let _ = stop.send(()); }
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await.map_err(|e| format!("Couldn’t start the MCP endpoint on port {port}: {e}"))?;
    let (tx, mut rx) = oneshot::channel::<()>();
    *host.stop.lock().unwrap() = Some(tx);
    let token = Arc::new(token);
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::select! {
                _ = &mut rx => break,
                acc = listener.accept() => {
                    if let Ok((sock, _)) = acc { tauri::async_runtime::spawn(serve_one(sock, app.clone(), host.clone(), port, token.clone())); }
                }
            }
        }
    });
    Ok(())
}

#[tauri::command]
pub fn mcp_host_stop(state: tauri::State<'_, Arc<McpHost>>) {
    if let Some(stop) = state.stop.lock().unwrap().take() { let _ = stop.send(()); }
    for (_, tx) in state.waiting.lock().unwrap().drain() { let _ = tx.send(None); }
}

/// The frontend's answer to one message; `None` for a notification (HTTP 202, no body).
#[tauri::command]
pub fn mcp_host_reply(state: tauri::State<'_, Arc<McpHost>>, id: u64, body: Option<String>) {
    if let Some(tx) = state.waiting.lock().unwrap().remove(&id) { let _ = tx.send(body); }
}

#[cfg(test)]
mod tests {
    use super::same_bytes;
    #[test]
    fn compares_tokens() {
        assert!(same_bytes(b"abc", b"abc"));
        assert!(!same_bytes(b"abc", b"abd"));
        assert!(!same_bytes(b"abc", b"abcd"));
    }
}
