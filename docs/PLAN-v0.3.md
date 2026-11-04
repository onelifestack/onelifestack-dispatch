# Dispatch v0.3 plan (autonomous build, started 2026-11-04)

Owner asked to build the rest of the roadmap while desktop testing waits. Git: commit per feature on
`feature/v0.3`, push, open a PR at the end; no merge, tag or release without the owner.
Not done here (needs the owner): real-machine testing, code-signing certificates, the updater's signing key,
public web hosting / developer-site listing, OneLifeStack sync design.

1. [x] Secrets encrypted at rest (device key that can't be exported); OAuth tokens saved back after refresh.
2. [x] Undo for deletes; automatic local backups with restore.
3. [x] CodeMirror editor: syntax colours, {{variable}} + pm API + GraphQL autocomplete, foldable JSON responses.
4. [x] Sidebar: drag-and-drop reorder/move, search across everything, multi-select move/delete.
5. [x] Client certificates (mTLS), proxy settings, cookie manager (view/edit/delete, persisted).
6. [x] Script compatibility: require lodash, moment, crypto-js, uuid; pm.visualizer with a Visualize tab.
7. [x] Postman collection export; Insomnia and Bruno import.
8. [x] Collections as files (desktop): save/open a collection as a folder of YAML files; CLI runs folders too.
9. [x] Scheduled runs (desktop): run a collection every N minutes, notify on failure, keep results.
10. [x] Server-sent events and Socket.IO requests.
11. [x] Response history per request and side-by-side compare.
12. [ ] CI: macOS universal (Intel + Apple silicon), Linux ARM64; updater wiring documented.
13. [ ] Browser tour, docs, PR.

Progress notes go below as steps land.
- Step 1: core/vault.ts — AES-GCM with a non-extractable WebCrypto device key (raw-key fallback where a CryptoKey can't be stored); sealed: secret variables, auth secret fields, sensitive request headers, history request + sent headers, open-tab drafts. A database copied to another device reads secrets as empty. OAuth refresh → Execution.authUpdate → saved to request/folder/collection; runs reuse the new token.
- Step 2: undo stack for deleted requests/folders/collections/environments (toast with Undo, after the delete lands); IndexedDB v3 `backups` store: daily snapshot on open, manual, and before every restore; newest 10 kept; secrets stay sealed; restore replaces everything in one transaction; download strips secrets.
- Step 3: src/ui/editor/codemirror.ts (lazy chunk ~570 KB): JSON/JS/XML/HTML/GraphQL (cm6-graphql with the fetched schema), {{var}} highlight + completion (scope + generators), pm API completion, read-only foldable JSON response viewer, theme on app tokens. CodeArea keeps its API; jsdom gets a textarea. Found and fixed in the browser: React echoing older values back into the editor lost fast keystrokes (now only outside changes sync), and Enter must accept a completion (completion keymap at highest precedence).
- Step 4: ws.placeItems (re-parent + renumber siblings; folders carry descendants across collections; no moving a folder into itself), drag-and-drop in the sidebar (drop on a row = before it, on a folder/collection header = into it), Ctrl/Cmd-click selection with a Move/Delete bar (one undo), search across name/URL/method/body/headers/docs, Ctrl+K.
- Step 5: Settings view (general, proxy + bypass, CA certificates, client certificates by host/*.domain/:port, keys sealed); Rust: reqwest proxy/no_proxy, Identity::from_pem, extra roots. Cookie manager view (add/edit/delete/clear), jar saved sealed and reloaded on start. Live test src-tauri/tests/network_live.rs with examples/tls (passes: unknown CA refused, CA without client cert refused, mTLS accepted, proxy used and bypassed). Fixed: port-specific certificates now win over host-only ones.
- Step 6: core/scriptLibs.ts scans the script and loads only the libraries it uses (lodash incl. global _, moment, crypto-js, uuid, ajv, handlebars); pm.response.to.have.jsonSchema (ajv, readable errors); pm.visualizer.set → Visualize tab (sandboxed iframe; template scripts run in the web version, desktop CSP blocks inline scripts).
- Step 7: core/interop.ts — Postman v2.1 collection export (folders, auth, scripts, examples, path vars; secrets blank) round-trips through our own Postman importer; Postman environment export; Insomnia v4 import (groups in any order, base env → collection vars, {{ _.x }} → {{x}}); Bruno folder import (parseBru blocks, bruno.json, folders from paths, environments/, disabled ~rows, warnings for bru./res. scripts and asserts). Menu: "Import a Bruno collection folder…" (webkitdirectory).
- Step 8: core/fileFormat.ts — dispatch.collection.yaml + <folder>/_folder.yaml + *.req.yaml (ids kept, slugs unique per folder, literal secrets never written, {{refs}} kept, OAuth tokens never written; reading merges this device's secrets). Desktop: pick_folder/read/write commands (prune only Dispatch files, no path escapes), "Save to a folder…"/Reload/Unlink in the collection, "Open a collection folder…" in the menu, auto-write as you edit (debounced, only on change). CLI runs a folder. Tests: TS round trip, CLI folder run, Rust write/prune/escape.
- Step 9: core/schedules.ts + ui/Schedules.tsx — schedules (collection/folder, environment, every N min, notify), checked every 30 s while open, one at a time; last 100 runs kept with failure reasons; desktop notifications via tauri-plugin-notification (Rust command), browser Notification API on the web. Script variable changes not kept.
- Step 10: core/sse.ts parser (chunk boundaries, ids, event types, retry, comments); SSE via fetch streaming on the web and a Rust stream (sse_open/sse_close, UTF-8-safe chunks) on desktop, with the request's headers and auth; Socket.IO over WebSocket (listen to named events or all, emit with JSON args, bearer → auth.token). Demo server has /events. Browser-checked against real servers (port 4321 is used by another app here; tests use 4331).
- Step 11: core/diff.ts (LCS with common prefix/suffix trimming, fallback for huge inputs, context collapsing); History tab per request (saved: by id; drafts: by method+URL) with Open and Compare (status/time/size, body diff on pretty JSON, header diff); earlier responses also listed before the first send.
