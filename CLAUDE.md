# CLAUDE.md — onelifestack-dispatch

Dispatch is OneLifeStack's local-first API client: a React + TypeScript web app (`src/`) wrapped in a Tauri 2
desktop shell (`src-tauri/`). Same UI everywhere; only the transport differs (`src/core/transport.ts`).

It's our own app with its own name and look (OneLifeStack palette). Postman is only a reference for the feature set
and an import format; never copy its name, branding, icons or UI.

## Layout

- `src/core/` — logic with no React, shared by the app and the CLI:
  - model and storage: `types.ts`, `db.ts` (IndexedDB v4; records normalized on read), `backup.ts` (Dispatch backup,
    Postman), `openapi.ts` (OpenAPI/Swagger/HAR)
  - building and sending: `vars.ts` + `fake.ts` ({{variables}}), `url.ts`, `prepare.ts` (variables + auth + body),
    `runtime.ts` (`execute`: the one pipeline everything uses), `auth.ts` (JWT, AWS SigV4, Digest, OAuth 2),
    `transport.ts` (fetch / Tauri / cookie jar), `cookies.ts`
  - scripts: `scripts.ts` (pm API, chai), `scriptPipeline.ts` (collection → folders → request order),
    `scriptWorker.ts` + `workerEngine.ts` (sandboxed Web Worker per script)
  - running: `runner.ts` (collections/suites/data, JUnit), `load.ts` (load tests), `csv.ts`
  - other: `codegen.ts` (12 languages), `curl.ts`, `docs.ts`, `mock.ts`, `graphql.ts`, `jsonpath.ts`, `format.ts`
  - v0.3: `vault.ts` (secrets at rest), `interop.ts` (Postman export, Insomnia/Bruno import), `fileFormat.ts`
    (collections as files), `schedules.ts`, `sse.ts`, `diff.ts`, `scriptLibs.ts` (require'able libraries)
  - browser logins: `cdp.ts` (minimal DevTools-protocol client), `browser.ts` (steps, launcher interface),
    `browserPipeline.ts` (the `Pipeline.browser` hook); launchers in `src/node/browserLauncher.ts` (CLI) and
    `src/ui/desktopBrowser.ts` (Tauri `browser_launch`)
  - `flows.ts`: flow graph (nodes, wires from output ports) and `runFlow`; straight chains run in a loop, recursion
    only for branches and For each (deep recursion overflowed the stack). Stored in IndexedDB v4 `flows`.
- `src/ui/` — `useWorkspace.ts` holds all state and actions; one component per view (RequestPane, ResponsePane,
  RunnerView, LoadView, DocsView, MockView, RealtimePane for WebSocket/MQTT/SSE/Socket.IO, GrpcPane, Editors,
  SettingsView/CookiesView, BackupsView, Schedules, ResponseHistory…). `editor/codemirror.ts` is the lazy editor;
  `CodeArea` falls back to a textarea in jsdom. `linkedDirs.ts` syncs collections to folders.
- `src/ui/FlowView.tsx` — the flow canvas (absolutely placed blocks, SVG wires, pointer drag; every wire can also
  be set from the side panel's “Then go to” selects, which is what keyboard users and tests use).
- `src/cli/main.ts` — `dispatch-run` (run, `load`, `mock`, `mcp`, `flow`); bundled by `scripts/build-cli.mjs`.
- `src-tauri/src/lib.rs` — send/cancel (proxy, mTLS, CA certs), save files, open URL, OAuth loopback, mock server
  sockets, SSE streams, notifications, collection folders (pick/read/write);
  `grpc.rs` — gRPC (tonic + prost-reflect + protox).
- `tests/` — vitest (jsdom; `cli.test.ts` builds and runs the real CLI in Node). `src-tauri/tests/grpc_live.rs` —
  live gRPC test (needs `examples/grpc`); `network_live.rs` — mTLS/proxy (needs `examples/tls`);
  `collection_files.rs` — folder write/prune/escape.
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

Installers for every OS come from GitHub Actions (`.github/workflows/build.yml`), not this machine: each push or PR
builds Windows (`.msi`, NSIS `.exe`), Linux (`.deb`, `.rpm`, AppImage) and macOS (`.dmg`) as run artifacts. To
release: bump the version in `package.json`, `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml`, push a tag
`vX.Y.Z`, and the installers land on a draft GitHub Release to review and publish. The installers aren't code-signed
yet (Windows SmartScreen and macOS Gatekeeper will warn).

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
- Run `npm run build` before committing, not just tests: a worker-format change once passed tests but broke the
  build. The script worker must stay `worker: { format: 'es' }`.
- CodeMirror and React: never push a value the editor itself emitted back into it (CodeArea tracks emitted values).
- Port 4321 is taken on this machine by another app; use other ports for test servers.
- Tauri commands can't also be `pub` at the crate root; expose a separate pub function for tests.
- Browser-login tests use Playwright's Chromium with `DISPATCH_BROWSER_ARGS=--no-sandbox` (AppArmor blocks its
  sandbox here). Never add `--no-sandbox` by default.
- A `<select>` inside a `<label>` gets its options in its accessible name; give it an `aria-label`.

## Where we left off

2026-11-04: inbox item 5 (browser automation) built on `feature/flows` (based on `feature/inbox`, PR #4): browser
login requests and visual flows. PR open, not merged.

v0.3 built autonomously 2026-11-04 on `feature/v0.3` (PR to main; not merged). Plan and notes:
`docs/PLAN-v0.3.md`. Desktop app still hasn't been opened on a real display; that's the owner's next step.
Waiting on the owner: code-signing certificates and the updater key (docs/RELEASING.md), sync design.
