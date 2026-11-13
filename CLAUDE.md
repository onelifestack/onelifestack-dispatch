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
  - `mcpAuth.ts`: MCP sign-in (discovery → registration → PKCE + `resource` → refresh), `MCP_SUGGESTIONS`; sign-ins
    sealed in IndexedDB meta `mcpSignIns`, keyed by environment + server. `examples/mcp-http-server.mjs --oauth` is
    a complete local sign-in server for tests and the Windows guide.
  - `mcpHandler.ts`: the MCP tools (list_requests, send_request, run_collection, run_flow), one JSON-RPC message
    in, one reply out; shared by `dispatch-run mcp` (stdio, first collection) and the desktop app's local MCP
    endpoint (every collection in the active workspace, with hooks that save script/token changes like Send does).
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
  `grpc.rs` — gRPC (tonic + prost-reflect + protox); `mcp_host.rs` — local MCP endpoint (127.0.0.1 only,
  bearer token, refuses Origin and foreign Host headers, POST only) that relays JSON-RPC to the frontend
  (`src/ui/mcpHost.ts`, turned on in Settings → AI assistants).
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

Installer artwork (`src-tauri/installer/`) is generated by `scripts/make-installer-art.mjs`; see `docs/RELEASING.md`.

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
- Never push to `main` without `npm run typecheck`: vitest passes code that the CI typecheck rejects (this happened
  once with a readonly tuple in a test).
- Desktop webview ↔ Chrome DevTools: Chrome refuses WebSocket connections that send an `Origin` header unless that
  origin is allowed with `--remote-allow-origins`. The desktop launcher passes exactly `location.origin`.
- Windows: Rust's `Command::new` only looks for `.exe` (use `resolve_command` for `npx`/`npm`), and child processes
  need `CREATE_NO_WINDOW` (`no_console`). `shellWords` keeps a backslash before an ordinary character, for Windows
  paths.
- Don't `npx` remote packages from tool calls; that's blocked here. Local examples (`examples/*.mjs`) cover MCP.
- MCP sign-in redirects to `http://127.0.0.1:33418/callback`, which a registered client is bound to; tests use 33419.

## Where we left off

Updated 2026-11-10 (end of day). The latest tag is **v0.5.1** (still a draft; v0.5.0 is the published Latest).
`main` is ahead of it: PRs #6 (local MCP endpoint), #7 (drag and drop) and #8 (docs) are merged but untagged and not
yet tried in the real desktop app. PR #10 (branded installers) is open.

**The repo is public (MIT) since 2026-11-05.** GitHub billing blocked Actions on the private repo, so the owner
made it public. To keep a personal e-mail out of the public history, the old repo was renamed
`onelifestack/onelifestack-dispatch-archive` (private; keeps PRs #1–#18, the old issues #8–#15 with the Windows
reports, and the draft releases up to v0.4.4) and this repo was pushed fresh with rewritten history. Issue and PR
numbers restarted here; below, numbers marked *archive* refer to the old repo. Locally, remote `archive` is the old
repo. Never commit with any address other than the noreply one (see the folder CLAUDE.md).

**Releases.** Every release is a *draft*: the owner publishes. Tags in order:
- v0.2.0
- v0.4.0: workspaces, MCP, flows, browser login
- v0.4.1: Windows process fixes
- v0.4.2: browser-login origin fix (archive #9)
- v0.4.3: MCP sign-in (archive #11 / PR #13)
- v0.4.4: deleted flows stay deleted (archive #14), MCP Sign out sticks (archive #15)
- v0.5.0: linked workspaces, phase 1 (a workspace kept as a folder of files; docs/DESIGN-linked-workspaces.md);
  MIT licence; the first release built in the public repo
- v0.5.1: round 3 fixes (copied workspace folders, import message, dialog and table layout)

Releases up to v0.4.4 are drafts in the archive repo only.

Releases 0.4.1–0.4.3 have no macOS `.dmg` (0.4.4 has one): GitHub's macOS arm64 runners weren't available ("The job was not acquired
by Runner"). To fill in the `.dmg` later, run `gh run rerun <run> --failed` for the tag's run.

**Windows test (issue #2; rounds 1–2 in archive #8).**
- An agent on the owner's Windows machine follows `docs/TESTING-WINDOWS.md`, which is copied into the issue body,
  and posts reports as comments on #2. The repo is public, so the guide tells it to strip personal details.
- Round 1 (on 0.4.1, built from source): 29 of 35 checks passed and it found archive #9 (fixed in 0.4.2).
- Round 2 (installed 0.4.3, 2026-11-05): 35 of 42 passed, 2 failed (archive #14, #15, both fixed in 0.4.4), 5 partial.
  Not covered: 150%/200% scaling, multiple monitors, 6.4d step 9 (a real provider), SmartScreen text.
- Round 3 (installed 0.5.0 over 0.4.3, issue #2, 2026-11-05): 24 of 26 passed, 0 failed, 2 partial. Data survived
  the upgrade; both retests pass. Found: a copied workspace folder with an edited id moved the original's items and
  secrets (fixed in 0.5.1 with `reIdTaken`); guide 6.6b step 5 described the wrong behaviour (corrected, new step 6);
  import message skipped flows, long commands overflowed the confirm dialog, workspace names wrapped (all fixed in
  0.5.1). Flows deleted in 0.4.x stay in the data after upgrading (noted in the 0.5.1 release notes).
- Round 4 (install 0.5.1 over 0.5.0; retest 6.6b step 6 and the round 3 fixes) was requested on #2 on 2026-11-05.
  No report yet as of 2026-11-10. The installers are on the v0.5.1 draft release.
- **Issue #9 (2026-11-10)** is the next Windows round and replaces the round 4 request on #2: part A repeats round 4
  on the installed 0.5.1; part B tests a build from `main` (CI run 42783403452, commit e8f9dc2, artifact
  `dispatch-windows`, still says 0.5.1) for the MCP endpoint (curl checks for 401/403/405, port field, token,
  port in use) and drag and drop; part C covers 150%/200% scaling, multiple monitors and SmartScreen text. The
  report goes on #9, not #2. Artifacts expire 2027-02-08.
- **Next step:** read the newest comment on #2 and any `[Windows] …` issues or `test/windows-*` branches the agent
  opened. Then fix in a PR, bump the version (package.json, tauri.conf.json, Cargo.toml + lock, `VERSION` in
  `src/cli/main.ts`, `clientVersion` in `src/core/mcp.ts`, the version in `docs/TESTING-WINDOWS.md`), tag, add
  release notes, and refresh #2's body from the guide.

**Open on GitHub.**
- Minor findings from round 2, not filed yet: no Duplicate in the collection menu; static-token servers show the
  Sign in banner and the Auth tab can't be reached for MCP; MCP results from the previous tab stay visible; two
  blocks named "End" can't be told apart in flow selects; importing a
  backup into the same workspace duplicates everything; error texts include Rust internals (`os error 10061`).
- Issue #2: the Windows test (rounds 1–3 done; round 4 moved into #9). Issue #9: the next Windows round.
- PR #10: branded installers (NSIS sidebar/header, MSI banner/dialog, styled .dmg; `src-tauri/installer/`,
  `scripts/make-installer-art.mjs`). All CI checks pass; the look has only been seen as images on Linux. Needs a
  look at the Windows setup pages and the .dmg window, then the owner's merge (not yet merged).
- Merged 2026-11-10, in `main` but not in any tag: the desktop app's local MCP endpoint (#6; Settings → AI
  assistants; `src-tauri/src/mcp_host.rs`, `src/core/mcpHandler.ts`, `src/ui/mcpHost.ts`; the port applies on
  blur/Enter and start/stop are serialised) and drag and drop between views (#7; Ctrl/Alt-drag copies in the
  sidebar, tabs onto collections, requests onto flow canvases and the Runner; `src/ui/dnd.ts`).
- Flaky CI: `tests/browser.test.ts` ("The browser didn't start in time") and the Linux `linuxdeploy` step each
  failed once and passed on `gh run rerun --failed`.

**Site.** dispatch.onelifestack.com shows 0.5.0 with downloads from the public release (`site/release.json`).
`site/release.json` on `main` already points at 0.5.1 (PR #5), so its links work only once the v0.5.1 release is
published: the owner publishes the release, then runs `scripts/publish-site.sh`. After
each published release, regenerate `site/release.json` and ask the owner to run `scripts/publish-site.sh` (auto mode
blocks Claude from publishing).

**Waiting on the owner.**
- Publishing the draft releases (v0.5.1 next), then publishing the site.
- Code-signing certificates and the updater key (`docs/RELEASING.md`). The updater key unblocks in-app updates:
  once the public key exists, add `tauri-plugin-updater`, the config and a "Check for updates" item. Without it, a
  key-less "Check for updates" button that opens the release page is possible (it contacts GitHub, so keep it opt-in).
- Merging PR #10 after a look at the installers.
- Sync design.
- The site's DNS (see `site/README.md`).

**Design canvas.** "Dispatch — Complete UX Redesign" (https://claude.ai/artifact/VxFK9bQ6zCXUV3wb36YLE7) was
gap-analysed against 0.4.4 on 2026-11-05. The owner keeps the node-graph flow editor (the canvas proposed a list).
Biggest unbuilt items: environment kinds + production guard, flow run evidence (screenshots, why it failed, re-run
from a step), richer schedules (times/cron, flows and saved suites), a real Ctrl+K palette.

**Linked workspaces** (owner chose "option B" over the canvas's Desk): phase 1 shipped in 0.5.0. Next: phase 2 (a
folder watcher: live reload and conflicts as files change) and phase 3 (`dispatch-run` on workspace folders,
`--env`, `--flow`, `DISPATCH_SECRET_*`). Code: `src/core/workspaceFiles.ts`, `src/ui/linkedDirs.ts`,
`folder_read`/`folder_sync` in `src-tauri/src/lib.rs`.

**Ideas not started.**
- UI assertions and screenshots in browser steps (deferred by the owner).
- An interactive MCP sign-in in the CLI (today the CLI takes a pasted token).
- A Windows-friendly cURL snippet (2.9 in the report; minor).
