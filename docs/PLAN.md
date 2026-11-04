# Dispatch v0.2 plan (overnight build, started 2026-11-03)

Owner chose: all four groups + suite runner, performance/load testing, data-driven testing. Git: commit per
feature on branch `overnight/v0.2`, push to the private repo, open a PR for review in the morning.
Out of scope (conflicts with OneLifeStack rules): cloud/team workspaces, monitors, Postbot/AI.

Order (each step: code + tests + typecheck + build, then commit and push):

1. [x] Data model v2 + DB migration: folders (nested), path variables, more body types (form-data with files,
       binary, XML/HTML raw, GraphQL), per-request settings, docs, examples, scripts fields, globals, secret vars.
2. [x] Request tabs (several open requests, restored on reload) + nested folders in the sidebar.
3. [x] Scripts + tests: sandboxed pre-request/post-response JS in a Web Worker with a pm-style API
       (variables, request, response, test/expect, sendRequest, console), test results tab, console panel.
4. [x] Dynamic fake-data variables ({{$randomEmail}} etc.).
5. [ ] Collection runner: folder/collection, iterations, CSV/JSON data files (data-driven), delay, stop on
       failure, results + export. Suite runner = run several collections/folders in order.
6. [ ] Performance/load testing: virtual users, duration/iterations, ramp-up, think time; p50/p90/p95/p99,
       throughput, error rate, latency-over-time chart; caps + confirmation.
7. [ ] CLI runner (`dispatch-run`) for CI: runs a backup/collection file with the same core in Node.
8. [ ] Auth: Digest, OAuth 2 (client credentials, password, auth code + PKCE, refresh), JWT, AWS SigV4.
9. [ ] Code generation (curl, JS fetch, Node axios, Python requests, Go, Java, C#, PHP, Ruby, Rust, HTTPie, PowerShell).
10. [ ] Import OpenAPI 3 / Swagger 2 and HAR.
11. [ ] Response: HTML preview (sandboxed), JSON filter, save to file, timing breakdown, cookies; cookie jar.
12. [ ] Docs (Markdown) on collections/folders/requests; saved examples; local mock server (desktop).
13. [ ] GraphQL (schema introspection, autocomplete), WebSocket (live log), MQTT (over WebSocket), gRPC (desktop).
14. [ ] Desktop build + Playwright visual pass; README/CLAUDE.md; PR.

Progress notes go under each step as it lands.

- Steps 1–2 (2026-11-04): model v2 + IndexedDB v2 (folders store, records normalized on read), shared run pipeline
  `core/runtime.ts` (app, runner and CLI use it), tabs restored on reload, nested folders with auth/scripts/docs,
  globals, secret variables (blank in backups), path variables, all body types incl. files (fetch + Rust multipart),
  per-request settings, timings (TTFB/download). 48 tests.
- Step 3: scripts run in a fresh Web Worker per script (fetch/XHR/WebSocket/IndexedDB removed first; 10 s limit),
  pm API close to Postman's (scopes, request edits, response + to.have.*, test/expect via chai, sendRequest,
  skipRequest, setNextRequest, legacy tests[]), collection → folders → request order, tests tab, console drawer,
  snippets. Browser-checked: sendRequest works, direct fetch blocked. Also pulled in from step 11: HTML/image
  preview (sandboxed iframe), JSONPath filter, cookies tab, save response to file, save as example, timings.
- Step 4: 70 {{$random…}} generators (Postman names, built-in word lists), "{{ }}" panel listing scope + generators.
