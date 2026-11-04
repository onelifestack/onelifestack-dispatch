# Browser steps and flows (design, for discussion)

Status: proposal, nothing built. From inbox item 5: "UI testing, like user name and password, fetching of cookies,
or auth token from browser cookies and then using it as token for the rest of the pipeline for REST calls. More like
n8n for testing."

## The problem

Many APIs can only be reached after a login that happens in a web page: a form, an SSO redirect (Okta, Entra ID,
Google), sometimes MFA. The session ends up in cookies (often `HttpOnly`, so page scripts can't read them) or in
`localStorage`/`sessionStorage` as a token. Today you'd log in in a browser, open DevTools, copy the cookie or token,
and paste it into an environment, and do it again every time it expires.

What people want:

1. **Get a session from a real login** and use it for the following REST calls, without copying by hand.
2. **Run that unattended** (runner, schedules, CI) where the login can be scripted.
3. **Check the UI itself** a little: the page loaded, a value is shown, a button works (light UI testing, not a
   full Playwright replacement).
4. **Chain all of it** visually, like n8n: browser steps, HTTP requests, scripts, conditions, loops.

## Options

### A. A "browser login" step (desktop)

A request type, Browser, that opens a real browser window inside Dispatch at a URL. You log in by hand (SSO and MFA
just work, since it's a real browser). When the page reaches a URL you choose (e.g. `/dashboard`), or you press
"Done", Dispatch captures:

- cookies for chosen domains (through the native cookie store, so `HttpOnly` cookies work),
- values from `localStorage` / `sessionStorage` (e.g. the `access_token` key),

into variables (secret by default), and the cookies also go into Dispatch's cookie jar, so the next requests carry
them automatically.

- Engine: a Tauri webview window with its own data folder per environment, kept between runs (so "remember me"
  survives and a re-login is often silent).
- Pros: small, no extra download; handles SSO and MFA because a human is there.
- Cons: needs a person; desktop only; WebKitGTK on Linux, WebView2 on Windows, WKWebView on macOS behave slightly
  differently.

### B. Scripted browser steps (desktop and CLI)

The same step, but driven by a short script of actions: `goto`, `fill`, `click`, `waitFor`, `expect text`,
`extract cookie / storage / text`. A recorder fills the script in while you click through once.

- Engine options:
  1. **The system's Chrome or Edge via the DevTools protocol (CDP).** Dispatch starts it with a separate profile
     and drives it. No bundled browser; works in the CLI and in CI images that have Chrome. Recommended.
  2. Drive the Tauri webview with injected JavaScript: no dependency, but can't read `HttpOnly` cookies or cross
     origins reliably, and the engines differ per OS. Not recommended for scripting.
  3. Bundle Playwright's Chromium: most reliable, but about 150 MB per platform. Not recommended for the app; the
     CLI could offer it as an optional install.
- Pros: unattended runs, schedules, CI; doubles as light UI testing (`expect text`, screenshots on failure).
- Cons: SSO with MFA can't be fully unattended (needs a stored session from option A, or a test account
  without MFA); more to maintain.

### C. Flows (the n8n-like part)

A new item type, Flow: a canvas of steps (HTTP request, browser step, script, condition, loop over data, wait,
extract) wired together, with variables passing between steps. Under the hood it's the existing runner with
branching, so collections stay the simple, linear case.

- Pros: the most visual and flexible; good for multi-system tests (log in on A, create on B, check on C).
- Cons: by far the biggest piece (editor, execution engine, error handling, storage, CLI support); risk of
  building a second, worse n8n.

## Recommendation

Build in three steps, each useful on its own:

1. **A: Browser login step** (desktop). Solves the everyday problem (getting a session from SSO) with little code.
   About 2–3 days.
2. **B1: scripted steps over CDP with a recorder**, in the app, the runner, schedules and the CLI. Gives unattended
   runs and light UI checks. About 1–2 weeks.
3. **C: Flows** only if 1 and 2 show that linear collections plus scripts aren't enough. Collections already have
   `setNextRequest` for simple branching.

## Safety

- Usernames and passwords for scripted logins are secret variables (encrypted, never exported).
- Each environment gets its own browser profile; nothing is shared with your personal browser profile.
- Captured cookies and tokens are secret variables and go into the encrypted cookie jar.
- Scripted browsing is for your own apps and test accounts; the same "you're allowed to test this" checkbox as
  load tests before unattended runs against a host.
- Screenshots on failure stay on the device (and in the runner report if you export it).

## Questions for you

1. Is the main need SSO/MFA logins (favours A first) or simple username/password forms (B alone may do)?
2. Is relying on an installed Chrome/Edge acceptable for scripted steps, or must it work with no browser installed?
3. Should UI checks be a real goal (assertions on page content, screenshots) or only a means to get tokens?
4. Flows: is a visual canvas important to you, or would "steps in a collection" be enough?
