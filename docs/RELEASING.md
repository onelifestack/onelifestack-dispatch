# Releasing Dispatch

## Today

1. Bump the version in `package.json`, `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml`.
2. Merge to `main`, then push a tag: `git tag -a vX.Y.Z -m "Dispatch X.Y.Z" && git push origin vX.Y.Z`.
3. GitHub Actions builds installers and attaches them to a **draft** release:
   Windows (`.msi`, NSIS `.exe`), Linux x64 and ARM64 (`.deb`, `.rpm`, AppImage), macOS universal (`.dmg`).
4. Check the draft, edit the notes, publish.

The installers aren't signed yet, so Windows SmartScreen and macOS Gatekeeper warn on first launch.

## Installer look

The Windows setup (NSIS `.exe` and `.msi`) and the macOS `.dmg` use branded artwork from `src-tauri/installer/`
(wired up in `tauri.conf.json` under `bundle.windows.nsis`, `bundle.windows.wix` and `bundle.macOS.dmg`). The images
are generated: change the look in `scripts/make-installer-art.mjs` and run it (it documents what it needs), then
commit the new images. The `.bmp` sizes are fixed by the installers: 164x314 sidebar, 150x57 header (NSIS), 493x312
dialog and 493x58 banner (WiX).

The `.dmg` background is drawn at 1320x800 and marked 144 dpi so Finder shows it at 660x400 points, sharp on Retina.
The Windows setup has no custom Start menu folder: `nsis.startMenuFolder` was left out because it hasn't been tested
on an upgrade from an older install (the old root-level shortcut could be left behind). Try it on a machine with
0.5.x installed before adding it.

## Code signing (needs the owner)

- **Windows:** an OV or EV code-signing certificate (or Azure Trusted Signing). Add the certificate as GitHub
  secrets and set `bundle.windows.certificateThumbprint` / a `signCommand` in `tauri.conf.json`
  (https://v2.tauri.app/distribute/sign/windows/).
- **macOS:** an Apple Developer account (99 USD/year). Add `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`,
  `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` as GitHub secrets; Tauri signs and
  notarizes during `tauri build` when they're set (https://v2.tauri.app/distribute/sign/macos/).

## Auto-updates (needs the owner's signing key)

Tauri's updater only installs updates signed with your key, so the key must be created and kept by you:

1. `npx tauri signer generate -w ~/.tauri/dispatch.key` (choose a password). Keep the private key safe; losing it
   means existing installs can't update.
2. Add GitHub secrets `TAURI_SIGNING_PRIVATE_KEY` (file contents) and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
3. Then the code changes (Claude can make these once the public key exists):
   - `src-tauri/Cargo.toml`: `tauri-plugin-updater = "2"`; register it in `lib.rs`.
   - `tauri.conf.json`: `bundle.createUpdaterArtifacts: true` and
     `plugins.updater: { pubkey: "<public key>", endpoints: ["https://github.com/onelifestack/onelifestack-dispatch/releases/latest/download/latest.json"] }`.
   - The workflow passes the two secrets as env to `tauri build` and uploads `latest.json` with the release.
   - A "Check for updates" item in the menu and a quiet check on start.

The repo is private, so release downloads need a GitHub login; for updates to reach other people, releases would
have to be published somewhere public (a public releases repo or the homelab).
