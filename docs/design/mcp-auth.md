# Signing in to protected MCP servers (plan)

Status: built 2026-11-04 on `feature/mcp-auth` (issue #11).

## Decisions (owner, 2026-11-04)

1. No preferred servers: offer well-known ones as suggestions. These are 16 remote servers whose addresses and
   sign-in were checked on 2026-11-04 (`MCP_SUGGESTIONS` in `src/core/mcpAuth.ts`). 11 register Dispatch by
   themselves, GitHub and Asana need a client ID you register with them, and 3 are open.
2. Sign-in in the desktop app only. The CLI and the web app use a token pasted into the request's auth.
3. Sign-ins are kept per environment (and per server).

## Today

The MCP request type sends the request's own auth (a bearer token, an API key header, …) with every call. That
covers servers that take a static token. What's missing is MCP's own sign-in: a server answers `401`, and the client
finds out where to log in, registers itself and gets a token, with nothing typed by hand. Remote MCP servers that
connect to people's accounts (GitHub, Linear, Atlassian, …) work this way.

## How MCP sign-in works (protocol 2025-06-18)

1. The client calls the server and gets `401` with
   `WWW-Authenticate: Bearer resource_metadata="https://server/.well-known/oauth-protected-resource"`.
2. **Protected resource metadata** (RFC 9728): that document names the server's authorization server(s).
3. **Authorization server metadata** (RFC 8414 `/.well-known/oauth-authorization-server`, or OpenID discovery):
   the authorize, token and registration endpoints, and the supported features.
4. **Dynamic client registration** (RFC 7591), when there's no pre-registered client: POST a client description and
   get a `client_id` back. The redirect URI is a loopback address.
5. **OAuth 2.1 authorization code with PKCE**, plus a `resource` parameter (RFC 8707) naming the MCP server, so the
   token is only good for that server.
6. Every MCP request then sends `Authorization: Bearer <token>`. A refresh token renews it, and a new `401` starts
   again from step 1.

## What Dispatch already has

- OAuth 2 authorization code + PKCE, token refresh and saving the refreshed token (`src/core/auth.ts`).
- A loopback redirect listener in the desktop app (`oauth_listen` in `lib.rs`), plus opening the system browser.
- Encrypted storage for tokens (the vault).

## Plan

1. **Discovery** (`src/core/mcpAuth.ts`):
   - parse `WWW-Authenticate` and fetch the resource metadata, then the authorization server metadata
   - fall back to `/.well-known/oauth-authorization-server` on the server's origin, as older servers expect
2. **Registration:** use dynamic client registration when it's offered. Otherwise ask for a client ID (and secret),
   as Dispatch's OAuth 2 form does today. Keep the registration per server, so it isn't repeated each time.
3. **Sign-in:** reuse the authorization-code flow with PKCE, adding `resource` and the scopes from the metadata.
4. **In the MCP pane:**
   - a "Sign in" button when a server answers `401` with resource metadata
   - who you're signed in as and when the token expires
   - "Sign out", which forgets the tokens
5. **Tokens:** sealed in the vault, per server URL. Refresh is automatic before expiry and on `401`. Tokens are never
   exported.
6. **CLI** (`dispatch-run`): use a saved token from an environment variable. An interactive sign-in from the CLI
   comes later, if it's wanted.
7. **Tests:**
   - a test authorization server plus a protected MCP server in `examples/`, covering discovery, registration, the
     PKCE exchange, refresh and the 401 retry
   - one real-world check against a public MCP server that supports it

Size: about 3–4 days, mostly discovery edge cases and the pane UI. Desktop app only: the web build can't receive the
loopback redirect, and most authorization servers don't allow its origin.

## Questions for the owner

1. Which MCP servers do you want to reach first? That decides which discovery variants matter.
2. Is desktop-only fine for sign-in, with the CLI using a pasted token?
3. Should sign-ins be kept per environment (e.g. separate staging and prod accounts) or once per server?
