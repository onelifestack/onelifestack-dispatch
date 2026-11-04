# CLAUDE.md — onelifestack-dispatch

Dispatch is OneLifeStack's local-first API client: a React + TypeScript web app (`src/`) wrapped in a Tauri 2
desktop shell (`src-tauri/`). Same UI everywhere; only the transport differs (`src/core/transport.ts`).

It's our own app with its own name and look (OneLifeStack palette). Postman is only a reference for the feature set
and an import format; never copy its name, branding, icons or UI.

## Layout

- `src/core/` — logic with no React, shared by the app and the CLI:
  - model and storage: `types.ts`, `db.ts` (IndexedDB v2; records normalized on read), `backup.ts` (Dispatch backup,
    Postman), `openapi.ts` (OpenAPI/Swagger/HAR)
  - building and sending: `vars.ts` + `fake.ts` ({{variables}}), `url.ts`, `prepare.ts` (variables + auth + body),
    `runtime.ts` (`execute`: the one pipeline everything uses), `auth.ts` (JWT, AWS SigV4, Digest, OAuth 2),
    `transport.ts` (fetch / Tauri / cookie jar), `cookies.ts`
  - scripts: `scripts.ts` (pm API, chai), `scriptPipeline.ts` (collection → folders → request order),
    `scriptWorker.ts` + `workerEngine.ts` (sandboxed Web Worker per script)
  - running: `runner.ts` (collections/suites/data, JUnit), `load.ts` (load tests), `csv.ts`
  - other: `codegen.ts` (12 languages), `curl.ts`, `docs.ts`, `mock.ts`, `graphql.ts`, `jsonpath.ts`, `format.ts`
- `src/ui/` — `useWorkspace.ts` holds all state and actions; one component per view (RequestPane, ResponsePane,
  RunnerView, LoadView, DocsView, MockView, RealtimePane for WebSocket/MQTT, GrpcPane, Editors…).
- `src/cli/main.ts` — `dispatch-run` (run, `load`, `mock`); bundled by `scripts/build-cli.mjs`.
- `src-tauri/src/lib.rs` — send/cancel, save files, open URL, OAuth loopback, mock server sockets;
  `grpc.rs` — gRPC (tonic + prost-reflect + protox).
- `tests/` — vitest (jsdom; `cli.test.ts` builds and runs the real CLI in Node). `src-tauri/tests/grpc_live.rs` —
  live gRPC test (needs `examples/grpc`).
- `examples/` — demo API, demo collection, data file, gRPC test server.

## Commands

Tool calls don't load `~/.bashrc`, so put node and cargo on PATH first:

    export PATH=~/.local/node/bin:~/.cargo/bin:$PATH

- `npm test` — all tests (watch the "Test Files" line too: a file that fails to load doesn't show in the count). `npm run typecheck`. `npm run build` — web build in `dist/` (relative base, so it works
  under any path, e.g. `/app/`).
- `npm run dev` — web dev server on :5173.
- `npm run build:cli` — `dist-cli/dispatch-run.mjs`.
- `npm run tauri dev` — desktop app with hot reload. `npm run tauri build` — `.deb` and AppImage in
  `src-tauri/target/release/bundle/`.

Desktop builds on Linux need these system packages (owner installs them; sudo isn't available to Claude):

    sudo apt-get install -y build-essential pkg-config libwebkit2gtk-4.1-dev libsoup-3.0-dev \
      libjavascriptcoregtk-4.1-dev librsvg2-dev libayatana-appindicator3-dev libssl-dev

Rust is user-space via rustup in `~/.cargo` (not on PATH by default).

## Visual check without a desktop

`vite preview` + Playwright from `~/projects/github-tools/rea/node_modules/playwright-core` with the headless
shell in `~/.cache/ms-playwright/chromium_headless_shell-1148`. It needs `libasound.so.2`, which isn't installed:
unpack it from `apt-get download libasound2t64` with `dpkg-deb -x` and set `LD_LIBRARY_PATH`.

## Gotchas

- `pkill -f <pattern>` in a tool call also matches the tool's own shell command and kills it; stop test servers by
  PID instead.
- The `mqtt` browser bundle exposes `connect` on the default export (see RealtimePane).
- The CLI bundle needs `require()` for CommonJS dependencies (yaml); `scripts/build-cli.mjs` provides it.
- gRPC reflection servers may omit imports or send well-known types under their own file names; `grpc.rs` handles
  both (found with the grpc-js reflection server).
- Keep collection order: requests and folders share a `sort` position; never sort runs by name.

## Where we left off

v0.2 built overnight 2026-11-03/04 on branch `overnight/v0.2` (PR to main). Plan and notes: `docs/PLAN.md`.
Desktop installers build; the app itself hasn't been opened on a real desktop yet (no display here). Next: open the
desktop build, then README "Not yet".
