# CLAUDE.md — onelifestack-dispatch

Dispatch is OneLifeStack's local-first API client: a React + TypeScript web app (`src/`) wrapped in a Tauri 2
desktop shell (`src-tauri/`). Same UI everywhere; only the transport differs (`src/core/transport.ts`).

It's our own app with its own name and look (OneLifeStack palette). Postman is only a reference for the feature set
and an import format; never copy its name, branding, icons or UI.

## Layout

- `src/core/` — pure logic, no React: `types.ts` (data model), `vars.ts` ({{variables}}), `url.ts` (params ⇄ URL),
  `prepare.ts` (variables + auth + body → exactly what is sent), `curl.ts` (import/export), `backup.ts`
  (Dispatch backup + Postman collection/environment import), `transport.ts` (browser fetch vs Tauri `invoke`),
  `db.ts` (IndexedDB), `format.ts`.
- `src/ui/` — `useWorkspace.ts` holds all state and actions; components render it.
- `src-tauri/src/lib.rs` — commands `send_request` (reqwest + rustls), `cancel_request`, `save_text_file`.
- `tests/` — vitest: `core.test.ts` (logic), `app.test.tsx` (UI with a fake transport, fake-indexeddb).

## Commands

Tool calls don't load `~/.bashrc`, so put node and cargo on PATH first:

    export PATH=~/.local/node/bin:~/.cargo/bin:$PATH

- `npm test` — all tests. `npm run typecheck`. `npm run build` — web build in `dist/` (relative base, so it works
  under any path, e.g. `/app/`).
- `npm run dev` — web dev server on :5173.
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

## Where we left off

See README "Not yet". Next candidates: multiple request tabs, pre-request/test scripts (sandboxed), GraphQL,
WebSocket. GitHub repo not created yet.
