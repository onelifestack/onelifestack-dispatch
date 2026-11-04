# Dispatch v0.3 plan (autonomous build, started 2026-11-04)

Owner asked to build the rest of the roadmap while desktop testing waits. Git: commit per feature on
`feature/v0.3`, push, open a PR at the end; no merge, tag or release without the owner.
Not done here (needs the owner): real-machine testing, code-signing certificates, the updater's signing key,
public web hosting / developer-site listing, OneLifeStack sync design.

1. [x] Secrets encrypted at rest (device key that can't be exported); OAuth tokens saved back after refresh.
2. [x] Undo for deletes; automatic local backups with restore.
3. [ ] CodeMirror editor: syntax colours, {{variable}} + pm API + GraphQL autocomplete, foldable JSON responses.
4. [ ] Sidebar: drag-and-drop reorder/move, search across everything, multi-select move/delete.
5. [ ] Client certificates (mTLS), proxy settings, cookie manager (view/edit/delete, persisted).
6. [ ] Script compatibility: require lodash, moment, crypto-js, uuid; pm.visualizer with a Visualize tab.
7. [ ] Postman collection export; Insomnia and Bruno import.
8. [ ] Collections as files (desktop): save/open a collection as a folder of YAML files; CLI runs folders too.
9. [ ] Scheduled runs (desktop): run a collection every N minutes, notify on failure, keep results.
10. [ ] Server-sent events and Socket.IO requests.
11. [ ] Response history per request and side-by-side compare.
12. [ ] CI: macOS universal (Intel + Apple silicon), Linux ARM64; updater wiring documented.
13. [ ] Browser tour, docs, PR.

Progress notes go below as steps land.
- Step 1: core/vault.ts — AES-GCM with a non-extractable WebCrypto device key (raw-key fallback where a CryptoKey can't be stored); sealed: secret variables, auth secret fields, sensitive request headers, history request + sent headers, open-tab drafts. A database copied to another device reads secrets as empty. OAuth refresh → Execution.authUpdate → saved to request/folder/collection; runs reuse the new token.
- Step 2: undo stack for deleted requests/folders/collections/environments (toast with Undo, after the delete lands); IndexedDB v3 `backups` store: daily snapshot on open, manual, and before every restore; newest 10 kept; secrets stay sealed; restore replaces everything in one transaction; download strips secrets.
