# Testing Dispatch 0.5.1 on Windows

Instructions for a tester (a person or an AI agent) on a Windows 10/11 machine. Work through each section, record
**PASS / FAIL / BLOCKED** for every numbered check, and write the results into a report (template at the end).

Dispatch is OneLifeStack's local-first API client: a desktop app (Tauri 2, WebView2), a web build and a command-line
tool, `dispatch-run`. This is the **first time the desktop app has ever been opened on a real machine**. Everything
below has passed automated tests on Linux and in a headless browser, but nobody has clicked through the desktop app
yet. Expect to find real bugs; that's the point.

## Ground rules

- **Don't** publish the GitHub release, push to `main`, merge anything or create tags. Report only. If you fix
  something, push it to a branch named `test/windows-<short-topic>` and say so in the report.
- Use only the local demo servers below, plus the public echo/broker services named in section 6. Don't point load
  tests or scripted logins at anything else.
- For every FAIL, record:
  - the exact steps
  - what you expected and what happened
  - a screenshot
  - any text in the app's **Console** (bottom-left of the status bar)
- If a check is blocked by an earlier failure, mark it BLOCKED and move on.
- Make a note of anything that looks broken, cramped or confusing, even if it "works".
- **The repository is public**, and so are its issues and comments. Before posting, take out anything personal:
  replace your Windows user name in paths with `<you>`, and leave out machine names, e-mail addresses, tokens and
  cookies. Crop screenshots that show any of these.

## 0. Setup

You need: Windows 10 or 11 (x64), PowerShell, Git, the GitHub CLI (`gh`) logged in with write access to
`onelifestack/onelifestack-dispatch` (the repo is public, but the draft release isn't), Node.js 20 or newer, and Microsoft Edge (built into Windows; Chrome works too).

```powershell
winget install --id Git.Git -e
winget install --id GitHub.cli -e
winget install --id OpenJS.NodeJS.LTS -e
# open a new terminal so PATH updates, then:
gh auth login
node --version   # must be v20 or newer
```

Get the source (for the demo servers, example files and the CLI) and the installers:

```powershell
mkdir $HOME\dispatch-test; cd $HOME\dispatch-test
gh repo clone onelifestack/onelifestack-dispatch
cd onelifestack-dispatch           # stay on main: it has the demo login page and example files used below
npm ci
npm run build:cli          # builds dist-cli\dispatch-run.mjs
mkdir ..\installers
gh release download v0.5.1 --repo onelifestack/onelifestack-dispatch -p "*x64-setup.exe" -p "*x64_en-US.msi" -D ..\installers
```

The release is a **draft**, so it's only visible to accounts with write access to the repo. If `gh release download`
says "release not found", run `gh release list --repo onelifestack/onelifestack-dispatch`: the draft must be listed
with its installers (the build can take 20+ minutes after the tag). Also check `gh auth status`. If only an older
draft is there, stop and report that rather than testing a build you made yourself.

Start the demo API in its **own terminal** and leave it running for the whole session:

```powershell
cd $HOME\dispatch-test\onelifestack-dispatch
node examples\demo-server.mjs        # http://localhost:4318
```

What the demo API offers:

| Endpoint | What it does |
| --- | --- |
| `POST /login` with `{"user": "..."}` | Returns a token and sets an HttpOnly `sid` cookie. If you also send `password`, it must be `secret`. |
| `GET /login` | An HTML login form (user `ann`, password `secret`). On success it sets the cookie, stores `{"access_token": ...}` in localStorage under `auth`, and opens `/dashboard`. |
| `GET /orders`, `POST /orders`, `GET /orders/:id` | Need the cookie or `Authorization: Bearer <token>`. |
| `GET /digest` | Digest auth (user `ann`, password `secret`). |
| `GET /flaky` | Sometimes slow; fails about 1 in 20. |
| `GET /events` | Server-sent events: 5 ticks. |

## 1. Install, first launch, uninstall

1.1. Run `Dispatch_0.5.1_x64-setup.exe`. SmartScreen will warn because the installer isn't code-signed yet: click
     "More info" → "Run anyway". Record the exact warning text. The install must finish without errors.

1.2. Start Dispatch from the Start menu. A window titled Dispatch opens and shows the request editor (URL field,
     Send button, sidebar with Collections / Flows / History / Environments).
   - Note how long the launch took.
   - Note any blank or white window.

1.3. Check that both themes work: switch Windows between light and dark mode (Settings → Personalization →
     Colors), or use the app's own Settings.
   - Text must stay readable in both.
   - Nothing should be invisible, such as dark text on a dark background.

1.4. Check the display at 100%, 150% and 200% scaling, and with the window resized to its narrowest. Look for:
   - blurry text
   - overlapping controls
   - content that can't be reached

1.5. Persistence:
   1. Create anything, for example send a request so it appears under History.
   2. Close the app completely.
   3. Reopen it. History, open tabs and settings must still be there.

1.6. *(Do this at the very end.)* Uninstall from Settings → Apps and confirm it's gone from the Start menu. Then
     install the `.msi` instead, launch it once, and uninstall it too. The msi installs for all users, so it needs
     administrator rights (a UAC prompt; a non-elevated `msiexec /qn` fails with Error 1925). Record whether your
     data survived a reinstall. Either outcome is acceptable, but write down which happened.

## 2. HTTP basics

2.1. GET `http://localhost:4318/orders`. Expect **401** with `{"error":"log in first"}`.

2.2. POST `http://localhost:4318/login`:
   1. Body tab → JSON → `{ "user": "ann" }`. Send.
   2. Expect 200 with a token.
   3. Open the **Cookies** tab of the response: you should see `sid`.

2.3. GET `/orders` again **without adding any header**. Expect **200**: the cookie jar sent `sid`. (This is
     desktop-only behaviour, so it matters.)

2.4. **Collections:** save the request to a new collection with Ctrl+S (name it "Win test"). Then:
   1. Rename it.
   2. Duplicate it.
   3. Delete it, then click **Undo** on the toast.

2.5. **Auth:** GET `/digest` with Auth type **Digest**, user `ann`, password `secret`. Expect 200 `{"hello":"ann"}`.

2.6. **Variables:**
   1. Make an environment "Local" with `base` = `http://localhost:4318`.
   2. Select it in the top-right picker.
   3. Send `{{base}}/flaky`.
   4. Hover `{{base}}` in the URL: its value should show.

2.7. **Save to file:** save a response body with the response's save-to-file option. A real Windows "Save as"
     dialog must open and write the file.

2.8. **Import:**
   1. Menu (≡) → **Import** → `examples\demo-shop.postman_collection.json`. A "Demo shop" collection appears.
   2. Right-click it, or use its "…" menu → **Run collection…**.
   3. Add `examples\users.csv` as the data file and run.
   4. Results appear per iteration. The only expected failures are occasional `/flaky` ones.

2.9. **Code:** copy a request as code as **PowerShell** and as **Python**. Run the PowerShell snippet in
     PowerShell. The cURL snippet is multi-line bash (`\` continuations), so it's for Git Bash or WSL, not
     PowerShell. That's a known limitation; just note whether it runs in Git Bash if you have it.

## 3. Browser login (new in 0.4; fixed for the desktop app in 0.4.2)

This drives Microsoft Edge (or Chrome) in the background to log in through a web form and keep the token.

3.1. Menu (≡) → **Import** → `examples\browser-login.dispatch.json`. You get:
   - a collection "Login check" with two requests, "Browser login" and "Orders with token"
   - an environment "Demo local" (`base`, `user` = `ann`, `password` = `secret`)
   - a flow "Login then orders"

   Select the environment **Demo local**.

3.2. Open **Browser login**. You should see 8 steps:
   1. open `{{base}}/login`
   2. fill the username
   3. fill the password
   4. click submit
   5. wait for `/dashboard`
   6. extract cookie `sid`
   7. extract localStorage `auth` → `token`
   8. extract text `#who`

3.3. Click **Run login** with "Show the browser" **off**. Expect:
   - every step ticked green and a 200 "Logged in" response, within about 10 s
   - no visible browser window
   - the "Demo local" environment now has `token`, `sessionCookie` and `whoText` (= `ann`), shown as secret values

   Record the time it took. If it fails with "couldn't find a browser", record the error and the paths of the
   Edge and Chrome executables on this machine.

3.4. Turn **Show the browser** on and run again. An Edge window should appear, type into the form, log in and close
     itself.

3.5. Send **Orders with token**. Expect 200 and the test "200" passing: the token from step 3.3 was used.

3.6. **Failure case:**
   1. Set `password` to `wrong` in the environment.
   2. Run the login again. It must fail clearly at the "wait for /dashboard" step: a timeout with a readable
      message, no hang, and no leftover Edge processes (check Task Manager).
   3. Set the password back to `secret`.

3.7. Run the collection with **Run collection…**. Both requests must pass, with the browser step shown as `WEB`.

## 4. Flows (new in 0.4, never tried on Windows)

4.1. Sidebar → **Flows** tab → open "Login then orders". The canvas shows Start → Login → Orders, wired together.

4.2. Click **Run flow**. While it runs, each block turns blue and then green. The log underneath lists 3 steps and
     says **Passed**.

4.3. Editing with the mouse:
   1. Drag blocks around.
   2. Add an **If** block from the toolbar.
   3. Drag from the If block's **false** dot to a new **End** block whose outcome is set to "Failed".
   4. Click a wire and press Delete to remove it.
   5. Check that the canvas scrolls when blocks are placed far right or far down.

4.4. Editing with the keyboard only: select a block, then use **Then go to** in the side panel to wire it. Tab
     through the controls and confirm that focus is visible.

4.5. Build this flow from scratch, in this order:
   1. Start
   2. Request "Browser login" (ok)
   3. Request "Orders with token" (ok)
   4. **Set variable** `firstId` = `$.orders[0].id`
   5. **If** `vars.firstId === "1"`: true → End (Passed), false → End (Failed)

   Run it and expect **Passed**. Then change the condition to `=== "2"` and expect **Failed** with "Ended as
   failed".

4.6. **For each:**
   1. Add a For each block with "Rows of data" and the data `id\n1\n2\n3`.
   2. Wire "each" to a Request that GETs `{{base}}/orders/{{item.id}}`. You'll need to make and save that request
      first, with an `Authorization: Bearer {{token}}` header.
   3. Expect 3 runs of that request: ids 1 to 3 give 200, 404 or similar depending on how many orders exist.
   4. Wire the request's "failed" port to nothing and check what happens on a 404: the flow stops and says why.

4.7. Close the app, reopen it, and check that flows and their layout are still there. Then:
   1. Delete a flow and use **Undo**: it comes back.
   2. Delete a flow (open it first, so its editor closes on delete) and don't undo. Close and reopen the app: it
      stays gone. Menu (≡) → **Export backup** doesn't contain it either (fixed in 0.5.0).

4.8. Menu (≡) → **Export backup**. Import that file again and confirm the flows are in it and still point at the
     right requests (no "doesn't point at a saved request" warnings).

## 5. Command-line tool on Windows

Run these from the repo folder in PowerShell.

5.1. `node dist-cli\dispatch-run.mjs --help` prints the usage.

5.2. `node dist-cli\dispatch-run.mjs examples\demo-shop.postman_collection.json -d examples\users.csv -r cli,junit`
   - It runs and writes `dispatch-report.xml`.
   - The exit code is 0, or 1 if `/flaky` failed. Check `$LASTEXITCODE`.

5.3. `node dist-cli\dispatch-run.mjs examples\browser-login.dispatch.json -e "Demo local"`
   - Both requests pass and the browser step is shown as `WEB`.
   - This proves the CLI finds Edge or Chrome on Windows by itself.

5.4. `node dist-cli\dispatch-run.mjs flow examples\browser-login.dispatch.json -e "Demo local" --flow "Login then orders" --json flow.json`
   - Prints `Passed` and writes `flow.json`.

5.5. `node dist-cli\dispatch-run.mjs load examples\demo-shop.postman_collection.json --request "5 Flaky" -u 5 --duration 10s --i-have-permission --p95 500`
   - Prints p50/p95 and statuses, plus a pass/fail line for the threshold.

5.6. `node dist-cli\dispatch-run.mjs mock examples\demo-shop.postman_collection.json --port 4319`, then in another
     terminal run `curl.exe http://127.0.0.1:4319/orders/7`. You get the saved example
     `{ "id": 1, "item": "coffee", "qty": 2 }`. `curl.exe http://127.0.0.1:4319/nope` gives a 404 listing the routes.
     Stop the mock with Ctrl+C.

5.7. A path with spaces: copy `examples` to `C:\Temp\dispatch test\` and run 5.3 from there.

## 6. Other protocols and desktop-only features

6.1. **Server-sent events:** protocol "Server-sent events", URL `http://localhost:4318/events`, connect. Five
     "tick" messages arrive, then the stream ends.

6.2. **WebSocket:** `wss://echo.websocket.org`. Connect, send `hello`, and get it echoed back.

6.3. **MQTT:** `wss://broker.hivemq.com:8884/mqtt`. Connect, subscribe to `dispatch/test/<random>`, publish to the
     same topic, and see the message come back.

6.4. **MCP (stdio), Dispatch talking to itself:**
   1. New request → protocol **MCP** → transport "Local command (stdio)".
   2. Command (forward slashes; 6.4b tries backslashes):
      `node C:/Users/<you>/dispatch-test/onelifestack-dispatch/dist-cli/dispatch-run.mjs mcp C:/Users/<you>/dispatch-test/onelifestack-dispatch/examples/browser-login.dispatch.json -e "Demo local"`.
   3. Connect and approve the "Run this command?" prompt. No console window should pop up. Tools `list_requests`, `send_request`, `run_collection` and `run_flow` appear.
   4. Call `run_flow` with name "Login then orders". The result starts with `Passed`.
   5. Disconnect. Check Task Manager: no `node.exe` left over from this.

6.4b. **Windows fixes from 0.4.1**: confirmed from a source build in the first test run. Check them again in
     the installed app:
   - The command from 6.4 with **backslashes** in the paths (`node C:\Users\<you>\...\dispatch-run.mjs mcp ...`)
     also connects. In 0.4.0 the backslashes were dropped.
   - A command starting with `npx` starts. Try `npx -y @modelcontextprotocol/server-everything` (needs internet);
     tools such as `echo` appear. In 0.4.0 this failed with "Couldn't start npx", because Windows' `npx` is
     `npx.cmd`.
   - No console window flashes up when an MCP server (6.4) or a browser login (3.3, 3.4) starts.

   Record exactly what you see for each.

6.4c. **MCP over HTTP** (testing an HTTP MCP server from the desktop app):
   1. In a new terminal: `node examples\mcp-http-server.mjs` (serves `http://localhost:4320/mcp`).
   2. New request → protocol **MCP** → transport "HTTP (Streamable HTTP)" → URL `http://localhost:4320/mcp`.
      Connect. The server shows as `dispatch-demo-mcp` with 4 tools: `add`, `echo`, `whoami`, `fail`.
   3. Tools:
      - `add` with `{"a": 40, "b": 2}` gives `42`.
      - `fail` shows "The tool reported an error."
   4. Resources: "Greeting for Ann" shows `Hello, Ann!`, and "Demo config" shows JSON.
   5. Prompts: `review` with some code returns a message that contains it.
   6. Disconnect. The server's terminal logs each call.
   7. **With a token and event-stream replies.** Stop the server and start
      `node examples\mcp-http-server.mjs --port 4322 --token tk --sse`. Then:
      - Connect to `http://localhost:4322/mcp` with no auth. Expect a readable 401 error that mentions `Bearer`.
      - Set the request's **Auth** tab to Bearer Token `tk` and connect again. It connects.
      - `whoami` returns `Authorization: Bearer tk`.

6.4d. **MCP sign-in** (new; only runs in the desktop app, so this is its first real test):
   1. Start `node examples\mcp-http-server.mjs --port 4323 --oauth --token-ttl 60`. Tokens last 60 s, so renewal
      gets tested too.
   2. Select the **Demo local** environment. Make a new MCP request with transport HTTP and URL
      `http://localhost:4323/mcp`, then Connect. Expect a blue banner: "This server needs you to sign in (kept for the
      Demo local environment)", with a **Sign in** button.
   3. Click **Sign in**. Your default browser opens a page "Allow Dispatch?". Click **Allow**. The browser shows
      "You're signed in", and Dispatch shows "Signed in for Demo local" and connects (4 tools). The server's terminal
      logs `registered client-…` and `signed in client-…`. Record whether Windows Firewall asks about anything.
   4. `whoami` returns `Authorization: Bearer <a token>`.
   5. Wait more than 60 s and call `add` again. It still works, and the server logs `refreshed a token`.
   6. Disconnect, switch the environment to **No environment** and connect again. The sign-in banner comes back,
      because sign-ins are kept per environment. Switch back to Demo local and connect: no sign-in needed.
   7. While still connected, click **Sign out**. The panel no longer says "Signed in", and the server logs no
      `refreshed a token` at that moment. Connect again: the banner comes back (fixed in 0.5.0).
   8. Press Deny on the consent page instead: Dispatch shows a readable "Login failed: access_denied" and nothing
      hangs.
   9. Optional, only with your own account: pick **Well-known servers… → Linear** (or Notion, Sentry, …), connect,
      sign in, and check that tools are listed. Don't call tools that change anything.

6.5. **gRPC** (optional; needs the extra packages in `examples\grpc\README.md`):
   1. Start `node examples\grpc\server.cjs`.
   2. New request → gRPC → `localhost:50051` → **Load services** → call `SayHello`.

6.6. **Collections as files:**
   1. Open a collection → **Files** → keep it as a folder, and choose e.g. `C:\Temp\dispatch-files`.
   2. YAML files appear, one per request. Edit a request in the app and check the file changes.
   3. Edit a `.req.yaml` in Notepad, then **Reload from folder**: the change shows in the app.
   4. Check how Windows path separators and long names behave.
   5. Edit a `.req.yaml` in Notepad, then edit the same request in the app **without** reloading. The file keeps
      the Notepad edit, and the collection page says "1 file changed outside Dispatch" with **Use the folder's
      version** and **Keep mine**. Try both.

6.6b. **Workspaces as files** (new in 0.5):
   1. Menu → Workspaces → **Link to a folder…** on your workspace, and pick an empty folder such as
      `C:\Temp\dispatch-ws`. If a collection was linked in 6.6, accept moving it in. Files appear:
      `dispatch.workspace.yaml`, `collections\…`, `environments\*.env.yaml`, `flows\*.flow.yaml`. No secret value
      appears in any file (search the folder for a secret you know).
   2. Rename a flow in the app: its file is renamed. Change an environment variable: its file changes.
   3. In Notepad, change a flow's `name:`, then change the same flow in the app. The Workspaces page shows the
      conflict and the file keeps the Notepad edit. **Use the folder's version**: the app shows the Notepad name.
   4. Close Dispatch, edit an environment file in Notepad, reopen Dispatch: the Workspaces page reports it.
   5. **Unlink**, then use **Open a workspace folder…** on `C:\Temp\dispatch-ws`. Dispatch recognises its own
      workspace and asks "You already have this workspace… Link it to this folder and use the folder's version?".
      Accept: it is linked again and the secret values are still there.
   6. Copy `C:\Temp\dispatch-ws` to `C:\Temp\dispatch-copy` and, in the copy's `dispatch.workspace.yaml`, change
      `id:` to any new text and `name:` to "Copy". **Open a workspace folder…** on the copy: it opens as its own
      workspace "Copy" with the same collections, environments and flows, and secret values are empty there. The
      original workspace still has everything, with its secrets (it lost them in 0.5.0). In "Copy", a flow's request
      block runs the copy's request.

6.7. **Schedules:**
   1. Create a schedule for "Demo shop", every 1 minute, with failure notifications on.
   2. Wait 2–3 minutes. Runs are listed, and if `/flaky` fails a **Windows notification** appears.
   3. Delete the schedule afterwards.

6.8. **Settings → Proxy, CA certificates, client certificates:**
   - Confirm the screens open, accept file paths from the Windows file picker, and save.
   - Optional deeper test: follow `examples\tls\README.md`. You need Git Bash for `make-certs.sh`, or run its
     openssl commands by hand.

6.9. **Backups:** Menu (≡) → **Local backups…** → **Back up now**, then restore it. The app must reload with the
     same data.

6.10. **OAuth 2 browser flow** (optional; needs a test OAuth provider): the "authorization code" grant must open
      the system browser and receive the redirect on `http://127.0.0.1:<port>`. Windows Firewall may prompt the
      first time; record that.

## 7. General checks

- **Window controls:** check minimise, maximise and restore, snap layouts (Win+Arrow), and multiple monitors with
  different scaling if available.
- **Keyboard:** Ctrl+S saves, Ctrl+Enter sends, Ctrl+K searches the sidebar, Tab order is sensible, Esc closes
  dialogs.
- **Copy/paste:** paste a cURL command into the URL field and check it becomes a full request.
- **Performance:** send a request returning a large response (POST about 2 MB of JSON to the demo API and look at
  the echo, or use any large public JSON file). Scrolling and the JSON view must stay responsive.
- **Errors:** check that messages are readable when the demo server is stopped ("connection refused") and for a
  wrong host name.
- **Leftovers:** after closing the app, Task Manager shows no `Dispatch.exe`, `msedge.exe` (from browser logins) or
  `node.exe` (from MCP) processes it started.

## Report template

Post the report as a comment on the GitHub issue that pointed you here, with screenshots attached to the
comment (drag them into the comment box, or `gh issue comment <number> --repo onelifestack/onelifestack-dispatch
--body-file windows-test-report.md` and add the images in the web UI). Open a separate issue for each serious
failure, titled `[Windows] <problem>`, and link it from the report.

```markdown
# Dispatch 0.5.1 — Windows test report

- Date / tester:
- Windows version (winver) and build:
- Display scaling(s) tested:
- Browser used for browser login (Edge/Chrome + version):
- Node version:
- Installer(s) tested: setup.exe / msi

## Summary
- Total: N checks — PASS x, FAIL y, BLOCKED z
- Top problems (most serious first):
  1.
  2.

## Results
| Check | Result | Notes |
| --- | --- | --- |
| 1.1 | PASS | SmartScreen text: "..." |
| 1.2 | | |
| ... | | |

## Failures in detail
### <check id> — <one-line title>
- Steps:
- Expected:
- Actual:
- Console output:
- Screenshot: <file name>

## Other observations
(look and feel, confusing wording, slow spots, ideas)
```
