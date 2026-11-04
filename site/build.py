#!/usr/bin/env python3
"""Builds the Dispatch website into site/dist. No dependencies: python3 site/build.py [--strict]

--strict also fails the build when the web app build (dist/ in the repo root) is missing, so a publish can never
go out without /app/.
Optional inputs: site/release.json (desktop installers, see README), ../dist (web app, copied to dist/app/),
../dist-cli/dispatch-run.mjs (CLI, copied to dist/downloads/).
"""
import hashlib, html, json, re, shutil, sys, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parent
SRC, DIST = ROOT / "src", ROOT / "dist"
BASE = "https://dispatch.onelifestack.com"
EMAIL = "hello@onelifestack.com"
DAY = datetime.date.today().isoformat()
VERSION = json.loads((REPO / "package.json").read_text())["version"]
STRICT = "--strict" in sys.argv
e = html.escape

RELEASE = None  # {"version","date","assets":[{"os","arch","kind","url","size_mb","sha256"}]}
if (ROOT / "release.json").exists(): RELEASE = json.loads((ROOT / "release.json").read_text())
WEB_DIST = REPO / "dist"
WEB = (WEB_DIST / "index.html").exists()
CLI_FILE = REPO / "dist-cli" / "dispatch-run.mjs"
CLI = CLI_FILE.exists()

NAV = [("/#features", "Features"), ("/download/", "Download"), ("/cli/", "CLI"), ("/changelog/", "Changelog"), ("/support/", "Support")]
SHOTS = {  # file -> (alt text, caption)
    "request": ("Dispatch in light theme: a POST request to a login endpoint and its 200 response with a JSON body", "Send a request and read the response, with the JSON folded and filterable."),
    "request-dark": ("Dispatch in dark theme: the same request and response", "The same request in the dark theme."),
    "scripts": ("A post-response script with pm.test and pm.collectionVariables, and the passing test listed under the response", "Scripts and tests run in a sandbox. The response shows each test."),
    "runner": ("The collection runner results: fifteen requests across three data rows, all passed", "The runner sends a collection once per data row and lists every result."),
    "load": ("A load test result with median, p95 and error rate, and charts of response time and requests per second", "A load test with charts, thresholds and a per-status breakdown."),
    "docs": ("Generated documentation for a collection: variables, the Login request with headers and body", "Documentation generated from the collection, ready to export as Markdown."),
}

# ---------- small helpers ----------
def inline(t):
    t = e(t, quote=False)
    t = re.sub(r"`([^`]+)`", r"<code>\1</code>", t)
    t = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", r'<a href="\2">\1</a>', t)
    t = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", t)
    return t
def ul(items): return "<ul>" + "".join(f"<li>{inline(i)}</li>" for i in items) + "</ul>"

def picture(name, lazy=True, dark=None):
    alt, _ = SHOTS[name]
    l = ' loading="lazy"' if lazy else ""
    img = f'<img src="/assets/shots/{name}.png" width="1440" height="900" alt="{e(alt)}"{l}>'
    if dark: img = f'<picture><source srcset="/assets/shots/{dark}.png" media="(prefers-color-scheme: dark)">{img}</picture>'
    return img
def figure(name, lazy=True, dark=None):
    pic = picture(name, lazy, dark)
    if lazy: pic = f'<a href="/assets/shots/{name}.png" aria-label="Open the full-size screenshot: {e(SHOTS[name][0])}">{pic}</a>'
    return f'<figure class="shot">{pic}<figcaption>{e(SHOTS[name][1])}</figcaption></figure>'

# ---------- page shell ----------
def shell(path, title, desc, body, current="", noindex=False):
    canon = BASE + path
    navs = "".join(f'<a href="{h}"{" aria-current=\"page\"" if h == current else ""}>{l}</a>' for h, l in NAV)
    app = '<a href="/app/">Open the web app</a>' if WEB else ""
    robots = '<meta name="robots" content="noindex">' if noindex else ""
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{e(title)}</title>
<meta name="description" content="{e(desc)}">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#FFF9F2" media="(prefers-color-scheme: light)"><meta name="theme-color" content="#1A1226" media="(prefers-color-scheme: dark)">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; img-src 'self' data:; style-src 'self'; font-src 'self'; base-uri 'self'; form-action 'none'">
<link rel="canonical" href="{canon}">{robots}
<link rel="manifest" href="/site.webmanifest">
<link rel="icon" href="/assets/icon.svg" type="image/svg+xml"><link rel="icon" href="/assets/icon-32.png" sizes="32x32" type="image/png"><link rel="apple-touch-icon" href="/assets/icon-180.png">
<link rel="preload" href="/assets/fonts/nunito-400.woff2" as="font" type="font/woff2" crossorigin><link rel="preload" href="/assets/fonts/nunito-800.woff2" as="font" type="font/woff2" crossorigin>
<meta property="og:type" content="website"><meta property="og:site_name" content="Dispatch"><meta property="og:title" content="{e(title)}">
<meta property="og:description" content="{e(desc)}"><meta property="og:url" content="{canon}"><meta property="og:image" content="{BASE}/assets/og.png">
<meta name="twitter:card" content="summary_large_image">
<link rel="stylesheet" href="/assets/site.css">
<script src="/assets/site.js" defer></script>
</head><body>
<a class="skip" href="#main">Skip to content</a>
<header class="site"><div class="wrap"><a class="brand" href="/"><img src="/assets/icon-32.png" width="32" height="32" alt="">Dispatch</a>
<nav class="main" aria-label="Main">{navs}{'<a href="/app/">Web app</a>' if WEB else ""}</nav></div></header>
<main id="main">
{body}
</main>
<footer class="site"><div class="wrap">
<div><a class="brand" href="/"><img src="/assets/icon-32.png" width="32" height="32" alt="">Dispatch</a>
<p>A local-first API client. No account, no cloud, no telemetry.</p></div>
<div><h2>Dispatch</h2><ul><li><a href="/#features">Features</a></li><li><a href="/download/">Download</a></li><li><a href="/cli/">Command line</a></li><li>{app or '<a href="/download/">Web app</a>'}</li><li><a href="/changelog/">Changelog</a></li></ul></div>
<div><h2>Fine print</h2><ul><li><a href="/privacy/">Privacy policy</a></li><li><a href="/terms/">Terms of use</a></li><li><a href="/support/">Support</a></li><li><a href="mailto:{EMAIL}">{EMAIL}</a></li></ul></div>
<small>&copy; {DAY[:4]} OneLifeStack. Dispatch is part of <a href="https://onelifestack.com">OneLifeStack</a>. Other product and format names that appear on this site are used only to say what Dispatch can import or export; they belong to their owners, and Dispatch is independent of and not affiliated with them.</small>
</div></footer></body></html>"""

def article(path, title, desc, inner, crumb):
    body = f'<div class="article"><div class="wrap"><p class="crumbs"><a href="/">Home</a> / {crumb}</p>{inner}</div></div>'
    return shell(path, f"{title} | Dispatch", desc, body, current=path)

# ---------- content ----------
FEATURES = [
 ("Requests", "HTTP with params, path variables, headers and bodies: JSON, text, XML, HTML, urlencoded, multipart with files, binary and GraphQL. Also WebSocket, MQTT over WebSocket, server-sent events, Socket.IO and, on desktop, gRPC with server reflection or a `.proto` file. Several requests open in tabs."),
 ("GraphQL", "Fetch the schema by introspection, get completions and checks as you type, and browse the schema with starter operations."),
 ("Auth", "Basic, bearer, API key, Digest, OAuth 2.0 (client credentials, password, authorization code with PKCE, refresh), JWT and AWS Signature v4. Folders and collections can set auth for everything inside."),
 ("Variables and secrets", "Globals, collection, environment, data-file and script scopes, plus 70 `{{$random...}}` fake-data generators. Secret values are hidden, left out of exports, and encrypted on this device."),
 ("Scripts and tests", "Pre-request and post-response JavaScript with a `pm` API (variables, request edits, `pm.test`, `pm.expect`, `pm.sendRequest`). Scripts run in a sandbox with no network or storage access of their own. Common libraries can be loaded with `require`."),
 ("Browser logins", "On desktop, a Browser login request drives your installed Chrome or Edge through a login page: open, type, click, wait. It keeps the cookies (HttpOnly too) or the token from local storage as secret variables, so the requests after it are signed in. It also runs in the runner, schedules and the CLI."),
 ("Flows", "Wire saved requests together on a canvas with If, Script, Set variable, For each, Delay and End blocks. Requests branch on ok or failed, and each block shows its status live while the flow runs. Run flows in the app or with `dispatch-run flow`."),
 ("MCP", "Test MCP servers: connect over HTTP or, on desktop, start a local server command, then list and call tools, read resources and get prompts. `dispatch-run mcp` works the other way round and lets an AI assistant list, send and run your saved requests, limited to the methods you allow."),
 ("Runner and data-driven runs", "Run a collection, a folder or a suite, with iterations, delays, CSV or JSON data files and stop-on-failure. Export JSON or JUnit reports."),
 ("Load testing", "Up to 200 virtual users with ramp-up, duration or loops, think time and pass/fail thresholds (p95, error rate, throughput). Latency and throughput charts, and a CSV of every sample."),
 ("Schedules", "On desktop, run a collection every few minutes and get a notification when it fails. Results are kept."),
 ("Mocks and docs", "Generated Markdown documentation per collection. A mock server that serves your saved examples, on desktop or with the CLI."),
 ("Collections as files", "On desktop, save a collection as a folder of YAML files written as you work, so it can live in git. The CLI runs those folders."),
 ("Import and export", "Import Postman collections and environments, Insomnia exports, Bruno folders, OpenAPI 3 and Swagger 2 (JSON or YAML), HAR files and curl commands. Export a Dispatch backup, one collection, or a Postman collection."),
 ("Code in 12 languages", "Copy any request as curl, JavaScript fetch, Node axios, Python requests, Go, Java, C#, PHP, Ruby, Rust, HTTPie or PowerShell."),
 ("The CLI", "`dispatch-run` runs collections, folders, suites and flows with environments and data files, runs load tests with pass/fail thresholds, serves mocks, and serves a collection to AI assistants over MCP. Built for CI."),
 ("Workspaces and tidy-ups", "Group collections and environments into workspaces. Duplicate an environment. Parameterize turns hard-coded hosts, tokens and IDs in a request into variables, and is offered right after you paste a curl command. A variable can hold named alternatives, such as the load balancer or one instance, and the runner can run once per alternative to compare them."),
 ("Everyday comforts", "A code editor with syntax colours and `{{variable}}` completion, undo for every delete, daily local backups with restore, drag and drop in the sidebar, search across bodies and headers (Ctrl+K), and response history with side-by-side compare."),
]
COMPARE = [
 ("Requests are sent from", "The Rust side of the app", "Your browser, with `fetch`"),
 ("Servers you can reach", "Any server", "Servers that allow it through CORS"),
 ("Response headers shown", "All of them", "Only the ones the server exposes through CORS"),
 ("Self-signed certificates", "Allowed, if you turn it on", "Up to the browser"),
 ("Cookies", "Cookie jar with a manager", "The browser's own rules"),
 ("Client certificates, extra CAs, proxy", "Yes", "No"),
 ("gRPC", "Yes", "No"),
 ("Browser logins", "Yes, with your installed Chrome or Edge", "No"),
 ("MCP servers", "Over HTTP, or a local command", "Over HTTP, if the server allows CORS"),
 ("Mock server", "Yes", "No (use the CLI)"),
 ("Collections as files, schedules", "Yes", "No"),
 ("Load tests", "No browser limits", "About six connections per server, and CORS applies"),
 ("Everything else", "Same", "Same: tabs, scripts, runner, docs, imports, code generation"),
]
FAQ = [
 ("Is Dispatch free?", "Yes. There are no accounts, ads or paid tiers."),
 ("Where is my data stored?", "On your device. The desktop app and the web app both keep collections, environments and history in local storage (IndexedDB). With collections as files on desktop, the folder you choose holds them too. We run no server that receives your data."),
 ("Does it send anything besides my requests?", "No. Dispatch has no analytics, no crash reporting, no update check and no fonts or scripts from other sites. The only network traffic is the requests you send."),
 ("What happens to my secrets?", "Secret variables, passwords, tokens, keys and Authorization or Cookie headers are encrypted before they are stored, using a key that stays on the device and cannot be exported. A copy of the database moved to another device cannot read them. Exports and backups leave secrets out."),
 ("What if I clear my browser data?", "The web app keeps its data in that browser, so clearing site data erases it. Use Menu, Export backup now and then. The desktop app is not affected by browser data."),
 ("Why does the web app say servers must allow CORS?", "A web page can only read responses from servers that permit it. If a server does not, use the desktop app, which has no such rule."),
 ("Can it replace my current API client?", "It can import Postman collections and environments, Insomnia exports, Bruno folders, OpenAPI files, HAR files and curl commands, so you can try it on your own collections. Check the feature list for what you rely on."),
 ("Are the installers signed?", "Not yet. Windows SmartScreen and macOS Gatekeeper will warn on first launch. The <a href=\"/download/#unsigned\">download page</a> explains how to open them."),
 ("Does it sync between devices?", "Not now. Export a backup or keep a collection folder in git."),
 ("Is there a mobile app?", "No. The web app works in a phone browser but is built for a larger screen."),
 ("How do I get help or report a problem?", f"Write to <a href=\"mailto:{EMAIL}\">{EMAIL}</a>."),
]
PRIVACY_KEEP = ["Collections, requests, environments, history and settings", "Secret values, encrypted with a key that stays on the device", "Daily local backups", "Everything the app saves, in local storage or in the folder you pick"]
PRIVACY_NEVER = ["No account or sign-in", "No analytics, telemetry or crash reports", "No update checks or other calls home", "No fonts, scripts or images from other sites", "No server that receives your collections"]
NEXT = [
 ("Sign-in for MCP servers", "Connect to MCP servers that need you to sign in with OAuth, with the token kept as a secret."),
 ("Signed installers", "Code-signed installers for Windows and macOS, so they open without a warning."),
]

def app_buttons(primary=True):
    out = ""
    if WEB: out += f'<a class="btn primary" href="/app/">Open in your browser</a>'
    out += f'<a class="btn{"" if WEB else " primary"}" href="/download/">Download for desktop</a>'
    return out

def home():
    feats = "".join(f'<div class="card"><h3>{t}</h3><p>{inline(d)}</p></div>' for t, d in FEATURES)
    cmp_rows = "".join(f"<tr><th scope=\"row\">{inline(a)}</th><td>{inline(b)}</td><td>{inline(c)}</td></tr>" for a, b, c in COMPARE)
    faq = "".join(f"<details><summary>{q}</summary><p>{a if '<a' in a else inline(a)}</p></details>" for q, a in FAQ)
    nxt = "".join(f'<div class="card"><h3>{t} <span class="tag">Planned</span></h3><p>{d}</p></div>' for t, d in NEXT)
    keep = "".join(f"<li>{inline(k)}</li>" for k in PRIVACY_KEEP)
    never = "".join(f"<li>{inline(k)}</li>" for k in PRIVACY_NEVER)
    return f"""
<section class="hero"><div class="wrap"><div>
<p class="eyebrow">Dispatch by OneLifeStack</p>
<h1>A local-first API client.</h1>
<p class="lead">Build, send, test and document APIs. No account, no cloud, no telemetry. Your collections stay on your device.</p>
<div class="cta-row">{app_buttons()}</div>
<p class="note">Version {e(VERSION)}. Desktop for Windows, macOS and Linux, the same app in your browser, and a command-line runner for CI. Free.</p></div>
{figure("request", lazy=False, dark="request-dark")}</div></section>
<div class="promise"><div class="wrap"><ul><li>No account</li><li>No cloud</li><li>No telemetry</li><li>Collections as files for git</li><li>CLI for CI</li></ul></div></div>
<section id="features"><div class="wrap"><div class="section-head"><p class="eyebrow">What it does</p><h2>Everything you need to work with an API.</h2><p class="lead">One app for sending requests, checking responses, running them in bulk and documenting the result.</p></div>
<div class="grid">{feats}</div></div></section>
<section class="tint" id="tour"><div class="wrap">
<div class="split"><div><p class="eyebrow">Scripts and tests</p><h2>Check every response.</h2><p>Write a few lines of JavaScript after a request to test the status, the body or the timing, and to save a value like a token for the next request. Each test shows as passed or failed under the response.</p><p>Scripts run in a sandbox, apart from the app and your saved data.</p></div>{figure("scripts")}</div>
<div class="split flip"><div><p class="eyebrow">Runner</p><h2>Run it again for every row.</h2><p>Run a whole collection, a folder or several collections as a suite. Give it a CSV or JSON file and it runs once per row, with the columns as variables. Export the results as JSON or JUnit.</p><p>The same run works from the command line, so CI can do it too.</p></div>{figure("runner")}</div>
<div class="split"><div><p class="eyebrow">Load testing</p><h2>See how it holds up.</h2><p>Send the same request, or a whole flow, from up to 200 virtual users. Set pass and fail thresholds for p95 latency, error rate and throughput, and watch the charts.</p><p>Load test only servers you own or have permission to test. Dispatch asks you to confirm that before it starts.</p></div>{figure("load")}</div>
<div class="split flip"><div><p class="eyebrow">Docs and mocks</p><h2>Documentation comes with the collection.</h2><p>Dispatch writes Markdown documentation from your requests, parameters, bodies and saved examples, and leaves secret values out. Save a response as an example and a mock server can serve it back.</p></div>{figure("docs")}</div>
</div></section>
<section id="imports"><div class="wrap"><div class="section-head"><p class="eyebrow">Bring what you have</p><h2>Import, export, keep in git.</h2><p>Dispatch reads the formats your collections are probably in, and writes its own as plain files.</p></div>
<ul class="chips"><li>Postman collections and environments</li><li>Insomnia</li><li>Bruno folders</li><li>OpenAPI 3 and Swagger 2</li><li>HAR</li><li>curl</li><li>Postman export</li><li>YAML folders for git</li></ul>
<p class="muted">Import any of them from the menu, or paste a curl command into the URL bar. Names of other tools appear here only to describe file formats.</p></div></section>
<section class="tint" id="compare"><div class="wrap"><div class="section-head"><p class="eyebrow">Desktop or web</p><h2>Same app, two ways to send.</h2><p>The desktop app sends requests from Rust, so it can reach any server. The web app uses the browser&rsquo;s <code>fetch</code>, so the browser&rsquo;s rules apply.</p></div>
<div class="table-wrap"><table><thead><tr><th scope="col">&nbsp;</th><th scope="col">Desktop</th><th scope="col">Web</th></tr></thead><tbody>{cmp_rows}</tbody></table></div></div></section>
<section id="privacy"><div class="wrap"><div class="section-head"><p class="eyebrow">Privacy</p><h2>Your APIs are your business.</h2><p>Dispatch has no servers of its own to send your data to. The <a href="/privacy/">privacy policy</a> has the details in plain words.</p></div>
<div class="grid"><div class="card"><h3>Kept on your device</h3><ul>{keep}</ul></div><div class="card"><h3>Never happens</h3><ul>{never}</ul></div></div></div></section>
<section class="tint" id="next"><div class="wrap"><div class="section-head"><p class="eyebrow">Coming next</p><h2>Planned, not shipped.</h2><p>These are ideas we intend to build. They are not in the current release, and there is no date.</p></div><div class="grid">{nxt}</div></div></section>
<section id="faq"><div class="wrap"><div class="section-head"><p class="eyebrow">FAQ</p><h2>Good questions.</h2></div>{faq}<p>Still stuck? <a href="/support/">Contact support</a>.</p></div></section>
<section class="tint"><div class="wrap"><h2>Try it now.</h2><p class="lead">Open the web app and send a request, no sign-up.</p><div class="cta-row">{app_buttons()}</div></div></section>
"""

def dl_card(os_key, title, assets):
    rows = ""
    for a in assets:
        rows += (f'<li><div class="dl-main"><strong>{e(a["kind"])}</strong><span class="muted">{e(a["arch"])} &middot; {e(str(a["size_mb"]))} MB</span>'
                 f'<code class="hash">SHA-256 {e(a["sha256"])}</code></div><a class="btn small primary" href="{e(a["url"])}" download>Download</a></li>')
    return f'<div class="panel" data-os="{os_key}"><h3>{title}</h3><ul class="dl">{rows}</ul></div>'

def download():
    if RELEASE and RELEASE.get("assets"):
        by = {}
        for a in RELEASE["assets"]: by.setdefault(a["os"].lower(), []).append(a)
        names = {"windows": "Windows", "macos": "macOS", "linux": "Linux"}
        cards = "".join(dl_card(k, names[k], by[k]) for k in ("windows", "macos", "linux") if k in by)
        main = f'<p>Version <strong>{e(RELEASE["version"])}</strong>, released {e(RELEASE["date"])}.</p>{cards}<p class="note">Check a download against its SHA-256 checksum: <code>sha256sum file</code> on Linux, <code>shasum -a 256 file</code> on macOS, <code>Get-FileHash file</code> in PowerShell.</p>'
    else:
        main = '<div class="panel"><h2>Desktop downloads coming soon</h2><p>The installers are not public yet. Until they are, use the web app in your browser, or the command-line runner.</p></div>'
    web = f'<p><a class="btn primary" href="/app/">Open the web app</a></p>' if WEB else ""
    cli = '<a href="/cli/">command-line runner</a>'
    return f"""<h1>Download Dispatch</h1>
<p class="lead">The desktop app for Windows, macOS and Linux, free and with no account.</p>
{main}
<h2>No install: the web app</h2><p>The same app runs in your browser and keeps its data in that browser. It can only reach servers that allow it through CORS, and it has no gRPC, mock server or collection folders. See <a href="/#compare">desktop or web</a>.</p>{web}
<h2>Command line</h2><p>The {cli} runs collections in CI and needs Node.js 20 or newer.</p>
<h2 id="unsigned">The installers are not signed yet</h2>
<div class="callout">Windows and macOS will warn you the first time you open Dispatch. That is expected for an app without a paid code-signing certificate, and it does not mean the file is damaged.</div>
<h3>Windows</h3><p>SmartScreen shows &ldquo;Windows protected your PC&rdquo;. Choose <strong>More info</strong>, then <strong>Run anyway</strong>.</p>
<h3>macOS</h3><p>Gatekeeper says it cannot verify the app. Open the <code>.dmg</code> and drag Dispatch to Applications. Then Control-click the app, choose <strong>Open</strong>, and confirm. If that option is missing, open <strong>System Settings, Privacy &amp; Security</strong> and choose <strong>Open Anyway</strong> next to the message about Dispatch.</p>
<h3>Linux</h3><p>There is no signing warning. Install the <code>.deb</code> with <code>sudo apt install ./file.deb</code> or the <code>.rpm</code> with <code>sudo dnf install ./file.rpm</code>. For an AppImage, make it executable (<code>chmod +x file.AppImage</code>) and run it.</p>
<p>Check the SHA-256 checksum next to each download before you open it. Dispatch does not update itself, so come back here for new versions.</p>"""

def cli_page():
    dl = (f'<p><a class="btn primary" href="/downloads/dispatch-run.mjs" download>Download dispatch-run.mjs</a><code class="hash">SHA-256 {CLI_SHA}</code></p>' if CLI else '<p class="note">The download link appears here when the site is published.</p>')
    return f"""<h1>Command line</h1>
<p class="lead"><code>dispatch-run</code> runs your Dispatch collections without the app, for CI, scripts and load checks. It uses the same code as the app.</p>
{dl}
<p>It is one file and needs Node.js 20 or newer. No install step, no dependencies to fetch.</p>
<h2>Run a collection</h2>
<pre><code>node dispatch-run.mjs demo-shop.postman_collection.json -d users.csv --junit report.xml</code></pre>
<p>It accepts a Dispatch backup, a Postman collection, or a collection folder of YAML files written by the desktop app. Requests run in order with their scripts and tests, once per row of the data file. The exit code is non-zero when a test fails, so a CI job fails with it.</p>
<h2>Options</h2>
<div class="table-wrap"><table><thead><tr><th scope="col">Option</th><th scope="col">What it does</th></tr></thead><tbody>
<tr><td><code>-c, --collection</code></td><td>Collection to run (default: the only or first one)</td></tr>
<tr><td><code>-f, --folder</code></td><td>Folder to run, like <code>Parent/Child</code>. Repeat to run a suite</td></tr>
<tr><td><code>-e, --environment</code></td><td>Environment file, or a name inside the file</td></tr>
<tr><td><code>--env-var key=value</code></td><td>Set a variable. It wins over the environment</td></tr>
<tr><td><code>-d, --data</code></td><td>CSV or JSON data file, one iteration per row</td></tr>
<tr><td><code>-n, --iterations</code></td><td>Number of iterations</td></tr>
<tr><td><code>--delay</code>, <code>--timeout</code></td><td>Wait between requests, and per-request timeout, in milliseconds</td></tr>
<tr><td><code>--bail</code></td><td>Stop at the first failure</td></tr>
<tr><td><code>-k, --insecure</code></td><td>Accept self-signed TLS certificates</td></tr>
<tr><td><code>-r, --reporters</code></td><td><code>cli</code>, <code>json</code>, <code>junit</code> (with <code>--json</code> and <code>--junit</code> for the file paths)</td></tr>
</tbody></table></div>
<h2>Load test</h2>
<pre><code>node dispatch-run.mjs load demo-shop.postman_collection.json --request Flaky \\
  --vus 20 --duration 30s --p95 800 --max-errors 1 --i-have-permission</code></pre>
<p>Sends from virtual users and exits non-zero if a threshold is missed. <code>--i-have-permission</code> is required: use it only against servers you own or may test. Other options: <code>--loops</code>, <code>--ramp-up</code>, <code>--think</code>, <code>--min-rps</code>, <code>--samples</code> (write every sample as CSV).</p>
<h2>Mock server</h2>
<pre><code>node dispatch-run.mjs mock demo-shop.postman_collection.json</code></pre>
<p>Serves the saved examples in a collection. Run <code>node dispatch-run.mjs --help</code> for every option.</p>
<h2>Flows</h2>
<pre><code>node dispatch-run.mjs flow my-backup.json --flow "Checkout" -e staging.json</code></pre>
<p>Runs a flow from a Dispatch backup or export, with the same blocks and branches as in the app. Browser login steps need Chrome or Edge on the machine.</p>
<h2>Serve a collection to an AI assistant (MCP)</h2>
<pre><code>claude mcp add dispatch -- node dispatch-run.mjs mcp ./my-collection -e staging.json --allow-methods GET,HEAD</code></pre>
<p>An MCP server over stdio with three tools: <code>list_requests</code>, <code>send_request</code> and <code>run_collection</code>. Requests go through their auth, scripts and tests. <code>--allow-methods</code> limits what the assistant may send.</p>
<h2>In GitHub Actions</h2>
<pre><code>- uses: actions/setup-node@v4
  with: {{ node-version: 22 }}
- run: node dispatch-run.mjs api.collection.json -e staging.json --junit report.xml</code></pre>"""

def changelog():
    def rel(v, d, title, items): return f'<div class="release"><h2 id="v{v.replace(".", "-")}">{v} <span class="muted">{d}</span></h2><p>{title}</p>{ul(items)}</div>'
    return "<h1>Changelog</h1><p class=\"lead\">What changed in each release, newest first.</p>" + \
    rel("0.4.0", "2026-11-04", "Browser logins, flows and MCP. 0.4.1 and 0.4.2 fixed Windows issues found in testing.", [
        "Browser login requests: drive an installed Chrome or Edge through a login page and keep its cookies or token as secret variables (desktop, runner, schedules and CLI).",
        "Flows: wire requests together on a canvas with If, Script, Set variable, For each, Delay and End blocks, with live status and a run log. `dispatch-run flow` runs them from an export.",
        "MCP requests: test MCP servers over HTTP or, on desktop, a local command; list and call tools, read resources, get prompts.",
        "`dispatch-run mcp` serves a collection to AI assistants, with `--allow-methods` to limit what they may send.",
        "Workspaces to group collections and environments.",
        "Duplicate environments.",
        "Parameterize: turn hard-coded hosts, credentials and IDs into variables, also offered after pasting curl.",
        "Endpoint alternatives: one variable, several named targets; the runner can run once per alternative.",
        "Windows fixes: commands keep their backslashes, `.cmd` tools are found, no stray console windows.",
    ]) + rel("0.3.0", "2026-11-04", "Safer storage, a real editor, and collections that live in files.", [
        "Code editor with syntax colours, `{{variable}}` and `pm.` completion, GraphQL completion from the schema, and foldable JSON responses.",
        "Secrets are encrypted at rest with a device key that cannot be exported. OAuth tokens are saved after an automatic refresh.",
        "Undo for every delete, and daily local backups with restore.",
        "Sidebar drag and drop, multi-select, and search across bodies, headers and docs (Ctrl+K).",
        "Desktop: client certificates (mTLS), extra CA certificates, proxy settings and a cookie manager.",
        "Scripts can `require` lodash, moment, crypto-js, uuid, ajv and handlebars; JSON Schema checks; `pm.visualizer` with a Visualize tab.",
        "Export to Postman format; import from Insomnia and Bruno.",
        "Desktop: collections as a folder of YAML files for git, written as you work. The CLI runs those folders.",
        "Desktop: scheduled runs with failure notifications.",
        "Server-sent events and Socket.IO requests.",
        "Response history per request, with side-by-side compare.",
        "Installers built for Windows, Linux (x64 and ARM64) and macOS (Intel and Apple silicon).",
    ]) + rel("0.2.0", "2026-11-04", "Scripts, the runner, load tests and many more request types.", [
        "Nested folders, request tabs, path variables, and more body types: form-data with files, binary, XML, HTML and GraphQL.",
        "Pre-request and post-response scripts with tests, in a sandbox, with a console.",
        "70 fake-data variables like `{{$randomEmail}}`, and a panel listing the variables in scope.",
        "Collection and suite runner with iterations, delays, and CSV or JSON data files; JSON and JUnit reports.",
        "Load testing with virtual users, ramp-up, thresholds and charts.",
        "The `dispatch-run` command-line runner.",
        "Digest, OAuth 2.0, JWT and AWS Signature v4 auth.",
        "Code generation in 12 languages.",
        "Import OpenAPI 3, Swagger 2 and HAR files.",
        "Generated Markdown docs, saved examples, and a local mock server.",
        "GraphQL schema tools, WebSocket and MQTT (over WebSocket), and gRPC on desktop.",
    ]) + rel("0.1.0", "2026-11-03", "The first version.", [
        "HTTP requests with params, headers, bodies and auth, a response viewer, collections and history.",
        "Runs as a web app and in a desktop shell, with the data kept on the device.",
    ])

def support():
    faq = "".join(f"<details><summary>{q}</summary><p>{a if '<a' in a else inline(a)}</p></details>" for q, a in FAQ)
    return f"""<h1>Support</h1><p>We are a small team and we read every message.</p>
<div class="panel"><h2>Write to us</h2><p>Email <a href="mailto:{EMAIL}">{EMAIL}</a>. Say which version you use (Menu in the app, or the changelog) and whether it is the desktop app, the web app or the CLI. Please do not send secrets or whole collections; describe the request instead.</p></div>
<h2>Common questions</h2>{faq}"""

# ---------- legal ----------
def privacy():
    return f"""<h1>Privacy policy</h1><p class="updated">Last updated {DAY}.</p>
<p>Dispatch is built so that we never receive your data. This page says what that means.</p>
<h2>What Dispatch stores</h2>
<p>Your collections, requests, environments, variables, history, cookies, settings and backups. They stay on your device: in your browser&rsquo;s local storage (IndexedDB) for the web app, in the app&rsquo;s local storage for the desktop app, and in a folder you choose if you turn on collections as files. We have no server that receives any of it.</p>
<h2>Secrets</h2>
<p>Secret variables, passwords, tokens, keys, and Authorization and Cookie headers are encrypted before they are saved, using a key that stays on the device and cannot be exported. Exports and backups you download leave secrets out.</p>
<h2>Requests you send</h2>
<p>When you press Send, Dispatch sends that request to the address you typed, with the headers and body you set. That is the only network traffic Dispatch makes. What the other server does with it is up to that server. Scripts you write can send requests too (<code>pm.sendRequest</code>), to the places you tell them to.</p>
<p>A Browser login request opens your installed Chrome or Edge with a new, empty profile that is deleted afterwards, with sync and background networking turned off. It visits the pages in your steps. The values it keeps, such as cookies or a token, are stored as secret variables on this device.</p>
<h2>What Dispatch does not do</h2>
<ul><li>No account, sign-in or sync.</li><li>No analytics, telemetry or crash reporting.</li><li>No update check. Dispatch does not contact us or anyone else on its own.</li><li>No advertising and no trackers.</li><li>No fonts, scripts or images loaded from other sites, in the app or on this website.</li></ul>
<h2>The web app and this website</h2>
<p>This website and the web app at <a href="/app/">dispatch.onelifestack.com/app/</a> are static files hosted on GitHub Pages. When you open them, GitHub&rsquo;s servers receive the request for the files and, like any web host, may log your IP address and browser details under <a href="https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement">GitHub&rsquo;s privacy statement</a>. We do not receive those logs for individual visitors and we do not add cookies or tracking. After the files load, the web app does its work in your browser.</p>
<h2>Your control</h2>
<p>To remove everything, delete the data in the app, clear this site&rsquo;s data in your browser, or uninstall the desktop app and delete any collection folder you created. Nothing is kept anywhere else.</p>
<h2>Children</h2><p>Dispatch is a developer tool and is not directed at children.</p>
<h2>Changes and contact</h2>
<p>If this policy changes, the date above changes and the changelog says so. Questions: <a href="mailto:{EMAIL}">{EMAIL}</a>.</p>"""

def terms():
    return f"""<h1>Terms of use</h1><p class="updated">Last updated {DAY}.</p>
<p>These terms cover your use of Dispatch, its website and its web app. By using them you agree to these terms.</p>
<h2>What you get</h2>
<p>Dispatch is free software provided by OneLifeStack. You may use it for personal and commercial work, and you may use the command-line runner in your own build pipelines.</p>
<h2>Your data and your requests</h2>
<p>You are responsible for the requests you send and for the servers you send them to. Send requests, and especially load tests, only to systems you own or have permission to test. Keep the credentials you put in Dispatch safe, and keep backups: the web app&rsquo;s data lives in one browser and can be lost when site data is cleared.</p>
<h2>Third-party names</h2>
<p>Dispatch can import and export file formats from other tools. Their names are used only to describe those formats. Dispatch is independent and is not affiliated with or endorsed by them.</p>
<h2>No warranty</h2>
<p>Dispatch is provided &ldquo;as is&rdquo;, without warranties of any kind. It is a developer tool, and it can send requests that change or delete data on the servers you point it at. To the extent the law allows, OneLifeStack is not liable for loss or damage from using Dispatch, including lost data or requests sent in error.</p>
<h2>Installers</h2>
<p>Desktop installers are not code-signed yet, so your system may warn when you open them. Check the SHA-256 checksum published with each download, and download only from this website.</p>
<h2>Changes and contact</h2>
<p>We may update these terms; the date above will change. Questions: <a href="mailto:{EMAIL}">{EMAIL}</a>.</p>"""

# ---------- contrast check (WCAG) from the tokens in site.css ----------
def lum(h):
    c = [int(h[i:i+2], 16) / 255 for i in (1, 3, 5)]
    c = [x / 12.92 if x <= .03928 else ((x + .055) / 1.055) ** 2.4 for x in c]
    return .2126 * c[0] + .7152 * c[1] + .0722 * c[2]
def ratio(a, b):
    la, lb = sorted((lum(a), lum(b)), reverse=True); return (la + .05) / (lb + .05)
def tokens():
    css = (SRC / "site.css").read_text()
    blocks = re.findall(r":root \{(.*?)\n\s*\}", css, re.S)
    if len(blocks) != 2: raise SystemExit("site.css must have a light :root block and a dark :root block")
    return [dict(re.findall(r"--([\w-]+):\s*(#[0-9A-Fa-f]{6})", b)) for b in blocks]
PAIRS = [("ink", "bg"), ("ink", "surface"), ("ink", "sunken"), ("ink", "primary-soft"), ("muted", "bg"), ("muted", "surface"), ("muted", "sunken"),
         ("link", "bg"), ("link", "surface"), ("link", "sunken"), ("link", "primary-soft"), ("on-primary", "primary"),
         ("good", "surface"), ("good", "good-soft"), ("good", "bg"), ("warn", "warn-soft"), ("warn", "surface"), ("muted", "good-soft"),
         ("m-get", "surface"), ("m-post", "surface"), ("m-put", "surface"), ("m-patch", "surface"), ("m-delete", "surface"), ("danger", "surface")]
def check_contrast():
    out = []
    for mode, t in zip(("light", "dark"), tokens()):
        for fg, bg in PAIRS:
            if fg not in t or bg not in t: out.append(f"contrast: token missing {fg}/{bg} ({mode})"); continue
            r = ratio(t[fg], t[bg])
            if r < 4.5: out.append(f"contrast {mode} {fg} on {bg}: {r:.2f}")
    return out

# ---------- build ----------
CLI_SHA = hashlib.sha256(CLI_FILE.read_bytes()).hexdigest() if CLI else ""

def main():
    if DIST.exists(): shutil.rmtree(DIST)
    A = DIST / "assets"
    (A / "fonts").mkdir(parents=True); (A / "shots").mkdir()
    shutil.copy(SRC / "site.css", A / "site.css"); shutil.copy(SRC / "site.js", A / "site.js")
    for f in (SRC / "assets/fonts").glob("*.*"): shutil.copy(f, A / "fonts" / f.name)
    for f in (SRC / "assets/icons").glob("*.*"): shutil.copy(f, A / f.name)
    shutil.copy(SRC / "assets/og.png", A / "og.png")
    for f in (SRC / "assets/shots").glob("*.png"): shutil.copy(f, A / "shots" / f.name)
    if WEB: shutil.copytree(WEB_DIST, DIST / "app")
    if CLI: (DIST / "downloads").mkdir(); shutil.copy(CLI_FILE, DIST / "downloads/dispatch-run.mjs")

    pages = {"/": shell("/", "Dispatch: a local-first API client", "Build, send, test and document APIs. No account, no cloud, no telemetry; your collections stay on your device. Desktop, web and CLI.", home(), current="/")}
    pages["/download/"] = article("/download/", "Download", "Download Dispatch for Windows, macOS and Linux, open the web app, or get the command-line runner.", download(), "Download")
    pages["/cli/"] = article("/cli/", "Command line", "dispatch-run runs Dispatch collections, load tests and mock servers from the command line and in CI.", cli_page(), "Command line")
    pages["/changelog/"] = article("/changelog/", "Changelog", "What changed in each Dispatch release.", changelog(), "Changelog")
    pages["/privacy/"] = article("/privacy/", "Privacy policy", "Dispatch keeps your data on your device and sends nothing to us. Read the privacy policy in plain words.", privacy(), "Privacy policy")
    pages["/terms/"] = article("/terms/", "Terms of use", "The terms for using Dispatch.", terms(), "Terms of use")
    pages["/support/"] = article("/support/", "Support", "Get help with Dispatch.", support(), "Support")
    for path, h in pages.items():
        out = DIST / path.lstrip("/") / "index.html"; out.parent.mkdir(parents=True, exist_ok=True); out.write_text(h)
    (DIST / "404.html").write_text(shell("/404.html", "Page not found | Dispatch", "That page is not here.", '<div class="article"><div class="wrap"><h1>Page not found</h1><p>That page is not here. Try the <a href="/">home page</a> or <a href="/support/">support</a>.</p></div></div>', noindex=True))
    urls = list(pages) + (["/app/"] if WEB else [])
    (DIST / "sitemap.xml").write_text('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' + "".join(f"<url><loc>{BASE}{p}</loc><lastmod>{DAY}</lastmod></url>\n" for p in urls) + "</urlset>\n")
    (DIST / "CNAME").write_text("dispatch.onelifestack.com\n"); (DIST / ".nojekyll").write_text("")
    (DIST / "robots.txt").write_text(f"User-agent: *\nAllow: /\nSitemap: {BASE}/sitemap.xml\n")
    (DIST / "site.webmanifest").write_text(json.dumps({"name": "Dispatch", "short_name": "Dispatch", "description": "A local-first API client", "start_url": "/app/", "scope": "/app/", "display": "standalone",
        "icons": [{"src": "/assets/icon-192.png", "sizes": "192x192", "type": "image/png"}, {"src": "/assets/icon-512.png", "sizes": "512x512", "type": "image/png"}],
        "theme_color": "#FFF9F2", "background_color": "#FFF9F2"}) + "\n")
    return check(pages)

def check(pages):
    problems = []
    allp = {**pages, "/404.html": (DIST / "404.html").read_text()}
    ids_of = {p: re.findall(r'\bid="([^"]+)"', h) for p, h in allp.items()}
    for path, h in allp.items():
        for href in re.findall(r'(?:href|src|srcset)="(/[^"#?]*)', h):
            t = DIST / href.lstrip("/")
            if not (t.is_file() or (t / "index.html").is_file()): problems.append(f"{path}: broken {href}")
        for href, frag in re.findall(r'href="(/[^"#]*)#([^"]+)"', h):
            tgt = href if href else path
            tp = tgt if tgt in ids_of else (tgt + "/" if tgt + "/" in ids_of else None)
            if tp and frag not in ids_of[tp]: problems.append(f"{path}: missing anchor {href}#{frag}")
        for frag in re.findall(r'href="#([^"]+)"', h):
            if frag not in ids_of[path]: problems.append(f"{path}: missing anchor #{frag}")
        for tag in re.findall(r"<img [^>]*>", h):
            if " alt=" not in tag: problems.append(f"{path}: img without alt: {tag[:60]}")
        ids = ids_of[path]
        if len(ids) != len(set(ids)): problems.append(f"{path}: duplicate ids {sorted({i for i in ids if ids.count(i) > 1})}")
        if h.count("<h1") != 1: problems.append(f"{path}: needs exactly one h1")
        if "Content-Security-Policy" not in h: problems.append(f"{path}: no CSP meta")
        if re.search(r"<script(?![^>]*\ssrc=)", h): problems.append(f"{path}: inline script")
        if re.search(r"\son\w+=\"", h): problems.append(f"{path}: inline event handler")
        if re.search(r"\sstyle=\"", h): problems.append(f"{path}: inline style attribute (CSP style-src 'self')")
        if "<style" in h: problems.append(f"{path}: inline <style>")
        for tag in re.findall(r"<(?:img|script|link|source|iframe|audio|video)\b[^>]*>", h):
            m = re.search(r'(?:src|srcset|href)="(https?:)?//([^"]*)', tag)
            if m and 'rel="canonical"' not in tag: problems.append(f"{path}: third-party resource: {tag[:80]}")
    for r in check_contrast(): problems.append(r)
    css = (DIST / "assets/site.css").read_text()
    if "http://" in css or re.search(r"url\(\s*['\"]?(https?:|//)", css): problems.append("css has an external url")
    for m in re.findall(r"url\(([^)]+)\)", css):
        t = DIST / m.strip("'\" ").lstrip("/")
        if not t.is_file(): problems.append(f"css: missing {m}")
    if RELEASE:
        for a in RELEASE.get("assets", []):
            if not str(a.get("url", "")).startswith("https://"): problems.append(f"release.json: asset url must be https: {a.get('url')}")
            if not re.fullmatch(r"[0-9a-f]{64}", str(a.get("sha256", ""))): problems.append(f"release.json: bad sha256 for {a.get('url')}")
            if a.get("os", "").lower() not in ("windows", "macos", "linux"): problems.append(f"release.json: unknown os {a.get('os')}")
    if WEB and not (DIST / "app/index.html").exists(): problems.append("app/index.html missing")
    if STRICT and not WEB: problems.append("strict: web app build (dist/ in the repo root) is missing; run npm run build")
    if STRICT and not CLI: problems.append("strict: CLI build (dist-cli/) is missing; run npm run build:cli")
    return problems

if __name__ == "__main__":
    pr = main()
    if pr: print("\n".join(pr)); sys.exit(1)
    print("site built:", sum(1 for p in DIST.rglob("*.html") if "app" not in p.relative_to(DIST).parts[:1]), "pages; web app:", "yes" if WEB else "no", "; cli:", "yes" if CLI else "no", "; release.json:", "yes" if RELEASE else "no")
