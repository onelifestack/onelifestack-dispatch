# Dispatch by OneLifeStack

A local-first API client for building, sending, testing and documenting APIs. It runs as a desktop app (Tauri, for
Linux, Windows and macOS), as a web app built from the same code, and as a command-line runner for CI.

No account, no sync, no telemetry. Collections, environments and history stay in this device's storage. The only
network traffic is the requests you send.

## Features (v0.2)

**Requests**
- HTTP with params (kept in sync with the URL), `:path` variables, headers, and bodies: JSON, text, XML, HTML,
  urlencoded, multipart form-data with files, binary files, GraphQL.
- Several requests open in tabs (restored after a reload); per-request timeout, redirects and TLS settings.
- WebSocket and MQTT (over WebSocket) with saved messages and a live log; gRPC on desktop (server reflection or a
  pasted `.proto`; unary and streaming).
- GraphQL: fetch the schema by introspection, checks as you type, schema explorer with starter operations.

**Auth**: basic, bearer, API key, Digest, OAuth 2.0 (client credentials, password, authorization code + PKCE,
refresh), JWT (HS256/384/512), AWS Signature v4; inherited from folders and collections.

**Variables**: globals, collection, environment, data-file and script-local scopes; secret values (hidden, left out
of backups); 70 `{{$random…}}` fake-data generators; a `{{ }}` panel listing what's in scope.

**Scripts and tests**: pre-request and post-response JavaScript with a `pm` API close to Postman's (variables,
request edits, `pm.response`, `pm.test`/`pm.expect` with chai, `pm.sendRequest`, `setNextRequest`, `skipRequest`).
Scripts run sandboxed in a Web Worker with no network or storage access of their own. Console for script output and
the network log.

**Collections**: nested folders with their own auth, scripts and docs; history; runner for collections, folders and
suites with iterations, delays, CSV/JSON data files and stop-on-failure; JSON and JUnit reports.

**Performance**: load tests with up to 200 virtual users, ramp-up, duration or loops, think time, thresholds (p95,
error rate, throughput), latency and throughput charts, CSV export of every sample.

**Response**: pretty JSON with a JSONPath filter, HTML and image preview (sandboxed), headers, cookies, test
results, timing (first byte), save to file, save as example. Cookie jar on desktop.

**Share and reuse**: import Postman collections and environments, OpenAPI 3 / Swagger 2 (JSON or YAML), HAR and
curl; export a Dispatch backup or one collection; copy any request as code in 12 languages; generated Markdown docs
per collection; a mock server that serves saved examples (desktop, or `dispatch-run mock`).

**CLI** (`dispatch-run`): run collections, folders and suites with environments, data files and reporters;
`dispatch-run load` for load tests with pass/fail thresholds; `dispatch-run mock` to serve examples.

## Desktop vs web

The desktop app sends requests from Rust: any server, every header, self-signed certificates (opt-in), cookies, the
mock server and gRPC. The web app uses the browser's `fetch`, so servers must allow it via CORS, the browser only
shows CORS-exposed response headers (Digest auth needs the server to expose `WWW-Authenticate`), and gRPC and the
mock server aren't available.

## Try it

    node examples/demo-server.mjs        # a tiny API on :4318 (login, orders, Digest, a flaky endpoint)

Import `examples/demo-shop.postman_collection.json`, then run it in the Runner with `examples/users.csv` as the data
file, or from the command line:

    npm run build:cli
    ./dist-cli/dispatch-run.mjs examples/demo-shop.postman_collection.json -d examples/users.csv --junit report.xml

For gRPC see `examples/grpc/README.md`.

## Not yet

Request-level history diff, team sync (deliberately: local-first), AI assistance (needs a separate decision),
Socket.IO, server-sent events, gRPC-Web and gRPC in the browser, OAuth 2 token saving after automatic refresh.

## Build

See [CLAUDE.md](CLAUDE.md).
