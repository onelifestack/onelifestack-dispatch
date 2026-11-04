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
5. [x] Collection runner: folder/collection, iterations, CSV/JSON data files (data-driven), delay, stop on
       failure, results + export. Suite runner = run several collections/folders in order.
6. [x] Performance/load testing: virtual users, duration/iterations, ramp-up, think time; p50/p90/p95/p99,
       throughput, error rate, latency-over-time chart; caps + confirmation.
7. [x] CLI runner (`dispatch-run`) for CI: runs a backup/collection file with the same core in Node.
8. [x] Auth: Digest, OAuth 2 (client credentials, password, auth code + PKCE, refresh), JWT, AWS SigV4.
9. [x] Code generation (curl, JS fetch, Node axios, Python requests, Go, Java, C#, PHP, Ruby, Rust, HTTPie, PowerShell).
10. [x] Import OpenAPI 3 / Swagger 2 and HAR.
11. [x] Response: HTML preview (sandboxed), JSON filter, save to file, timing breakdown, cookies; cookie jar.
12. [x] Docs (Markdown) on collections/folders/requests; saved examples; local mock server (desktop).
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
- Step 5: runner view (targets = suite, pick/reorder, iterations, delay, CSV/JSON data, stop on failure, keep
  variable changes, live results + inspector, JSON/JUnit export); setNextRequest with loop guard; cookie jar
  (CookieTransport) on desktop and in runs. Core in core/runner.ts + core/csv.ts so the CLI reuses it.
- Step 6: core/load.ts (VUs ≤200, ramp-up, duration ≤30 min or loops, think time, per-user variables, optional
  scripts/tests, data rows, thresholds → pass/fail), latency + throughput charts (palette validated with the dataviz
  checks in both themes), tiles, per-request/status tables, per-second table, JSON/CSV export, permission checkbox.
  Browser-checked in light and dark with a real 8 s run.
- Step 7: `npm run build:cli` → dist-cli/dispatch-run.mjs (esbuild, one file). Runs Dispatch or Postman files,
  folders/suites, environments, --env-var, data files, bail, reporters cli/json/junit; `load` subcommand with
  thresholds and --i-have-permission. Exit 0/1/2. Scripts compile in a separate vm context. Tested against
  examples/demo-server.mjs + examples/demo-shop.postman_collection.json + examples/users.csv.
  Found and fixed: runs now keep collection order (requests and folders interleaved, `sort` field).
- Step 8: core/auth.ts — JWT HS256/384/512 (matches jwt.io sample), AWS SigV4 (matches AWS test suite vectors),
  Digest MD5/MD5-sess/SHA-256 (matches RFC 2617 example; MD5 implemented), OAuth 2 client credentials / password /
  auth code + PKCE / refresh. Desktop: system browser + one-shot 127.0.0.1 listener for the redirect; web: paste
  the landing URL. Expired tokens with a refresh token refresh per send (not saved back yet).
- Step 9: core/codegen.ts — 12 languages from the prepared request (escaping tested; Python output parsed with ast; curl round-trips). "</> Code" panel.
- Step 10: core/openapi.ts — OpenAPI 3 (JSON/YAML) + Swagger 2: servers→{{baseUrl}}, tags→folders, params→path vars/query/headers, sample bodies from examples/schemas ($ref, allOf/oneOf, recursion-safe), security→auth (+secret vars), response examples. HAR: entries→requests with recorded responses. All via importFile (app and CLI).
- Step 11: done in step 3 + cookie jar (step 5) + "Clear cookies" menu item (desktop).
- Step 12: safe Markdown renderer (React elements only; fixed an infinite loop on odd tables, fuzz test added),
  generated collection docs (core/docs.ts, export .md), examples editor in the Docs tab, mock server: shared matcher
  core/mock.ts (literal segments beat :params, x-mock-response-name/code, ?__example=), desktop = Rust sockets +
  app answers via events, CLI = `dispatch-run mock`. Found and fixed: the yaml dependency broke the CLI bundle
  (scripts/build-cli.mjs adds require); tests/cli.test.ts now builds and runs the real CLI.
- Step 13 (part 1): GraphQL (introspection via the request's own URL/headers/auth, syntax + schema validation with
  graphql-js, explorer that inserts starter operations), WebSocket and MQTT-over-WebSocket panes (connections live
  per request across tab switches, variables in messages, saved messages, live log). Protocol picker per request.
  Startup bundle cut from 660 KB to 355 KB by loading YAML, chai and GraphQL on demand. gRPC: next.
