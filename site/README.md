# dispatch.ogcrafts.cloud

Static marketing and legal site for Dispatch, with the web app published under `/app/`. Dispatch's own tokens (warm ground, ink and violet, method colours, 12px radius; dark theme through `prefers-color-scheme`), Nunito and Geist Mono self-hosted (SIL Open Font License; licence text for Geist Mono is in `src/assets/fonts`). No trackers, no cookies, no third-party requests. A strict Content-Security-Policy `<meta>` is on every site page.

Pages: home (hero, features, tour with screenshots, imports, desktop vs web table, privacy summary, planned items, FAQ), `/download/`, `/cli/`, `/changelog/`, `/privacy/`, `/terms/`, `/support/`, 404, sitemap, robots, web manifest, `/app/` (the web app), `/downloads/dispatch-run.mjs` (the CLI).

## Build
```
python3 site/build.py            # python3 only; writes site/dist and runs the checks
python3 site/build.py --strict   # also fails if ../dist (web app) or ../dist-cli (CLI) is missing
```
Checks that fail the build: broken internal link or anchor, `<img>` without `alt`, duplicate ids, a page without exactly one `h1`, inline script, inline style or event handler, third-party resource, external CSS url, any text/background pair under WCAG AA 4.5:1 in light and dark (the pairs are read from the two `:root` token blocks in `src/site.css`), a malformed `release.json`.

Preview locally: `npx serve -c site/serve.json site/dist` (or any static server with `site/dist` as the root; `/app/` must be reached with the trailing slash).

## The web app under /app/
`scripts/publish-site.sh` builds the app (`npm run build`, relative base) and `build.py` copies the repo's `dist/` into `site/dist/app/`. The app's own `index.html` has no CSP, on purpose: it has to send requests to any host, open WebSockets, run workers and load CodeMirror. Do not put the site's CSP on `/app/`. GitHub Pages cannot set headers, so there are none; if you ever add a CSP for the app it must allow `connect-src * ws: wss:` and `worker-src 'self' blob:`. The web app keeps its data in IndexedDB for the origin `dispatch.ogcrafts.cloud`.

## Screenshots
`src/assets/shots/*.png` (1440x900) are real captures of the built web app (Playwright, headless Chromium) with `examples/demo-shop.postman_collection.json` imported and requests sent to `examples/demo-server.mjs` on :4318: request and response (light and dark), scripts and tests, runner with `examples/users.csv`, a load test of the flaky endpoint, and the generated docs. Retake them when the UI changes (recipe in CLAUDE.md, "Visual check without a desktop"). `og.png` is 1200x630.

## Desktop downloads (`site/release.json`, optional)
The source repo is public (since 0.5.0), so `site/release.json` points straight at the installers on its published GitHub release. After publishing a release, regenerate `site/release.json` (see `release.example.json`):
`{version, date, assets:[{os: windows|macos|linux, arch, kind, url, size_mb, sha256}]}`, with each `url` an https link to the attached asset. Compute checksums with `sha256sum`. Without the file the page says "Desktop downloads coming soon" and points to the web app and CLI. The installers are **unsigned** (no certificates yet), so Windows SmartScreen and macOS Gatekeeper warn; the download page says so and explains how to open them. Update `release.json` and rerun the publish script for each version.

## Publishing (owner steps)
1. Create the public repo `ogcrafts/dispatch-site`; Settings, Pages, deploy from branch `main`, root.
2. `scripts/publish-site.sh` (builds, checks, pushes `site/dist` to `main`; commits as Omprakash Gautam).
3. Cloudflare DNS: CNAME `dispatch` -> `ogcrafts.github.io`, DNS only (grey cloud). The build writes `CNAME` with `dispatch.ogcrafts.cloud`.
4. When GitHub issues the certificate, tick Enforce HTTPS in the Pages settings.
5. After each published release: regenerate `site/release.json` from the release (checksums are in the GitHub API `digest` field), republish.
6. Add Dispatch to the developer site (`~/projects/developer`, "Keep in sync" table).
