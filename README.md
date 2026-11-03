# Dispatch by OneLifeStack

A local-first API client for building, sending and saving HTTP requests. It runs as a desktop app (Tauri, for
Linux, Windows and macOS) and as a web app built from the same code.

No account, no sync, no telemetry. Collections, environments and history stay in this device's storage. The only
network traffic is the requests you send.

## What it does (v0.1, HTTP core)

- Requests: method, URL, query params kept in sync with the URL, headers, bodies (JSON, text, urlencoded form).
- Auth: basic, bearer token, API key (header or query), or inherited from the collection.
- Variables: `{{name}}` from the active environment, which overrides collection variables. Dynamic `{{$guid}}`,
  `{{$timestamp}}`, `{{$isoTimestamp}}`, `{{$randomInt}}`. Missing variables are flagged before you send.
- Collections, environments, and the last 200 requests in history.
- Paste a curl command into the URL bar to import it. **Copy as curl** for any sent request.
- Import Postman collections (v2.0/2.1) and environments. Export and import a Dispatch JSON backup.
- Response: status, time, size, pretty JSON or raw, headers, and exactly what was sent.
- Light and dark themes, keyboard shortcuts (Ctrl+Enter send, Ctrl+S save, Ctrl+Alt+N new request).

**Desktop vs web:** the desktop app sends requests from Rust, so any server works, every header is allowed and
self-signed certificates can be accepted (opt-in). The web app uses the browser's fetch, so servers must allow it
via CORS, and the browser shows only CORS-exposed response headers.

## Not yet

GraphQL, WebSocket, gRPC and MQTT; pre-request and test scripts; multipart/file bodies; OAuth 2 flows; tabs for
several open requests; code generation beyond curl. Postman imports report anything they skip.

## Build

See [CLAUDE.md](CLAUDE.md).
