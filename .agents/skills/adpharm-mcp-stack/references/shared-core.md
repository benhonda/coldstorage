# Shared core — Worker rails, OAuth conformance, consent hardening

Everything here applies to **both variants**. Owns the transport/OAuth facts (entrypoint, TTLs, spec conformance, consent-state hardening) that the variant files link to.

**Read when:** scaffolding the Worker, touching anything under `/authorize`–`/callback`–`/token`, changing token lifetimes, or debugging client connection/auth failures.

## Contract

```
MCP client ──OAuth 2.1 + Streamable HTTP /mcp──▶ Cloudflare Worker  (<app>-mcp/)
  · agents SDK createMcpHandler (stateless — fresh McpServer per request, no Durable Object)
  · @cloudflare/workers-oauth-provider (KV token store, tokens hashed)
```

- The Worker owns **transport + OAuth, and nothing else**. Both variants exist to keep that true; they differ only in where "everything else" lives. The moment a tool reimplements logic another surface also implements, you've created the drift bug both variants exist to prevent.
- Why not serve MCP from the app itself (`mcp-handler` on a resource route): serverless duration caps are hostile to long-lived MCP sessions, and you'd hand-roll the OAuth authorization-server side that `workers-oauth-provider` gives you maintained. Revisit if either fact changes.
- Neither variant, if you have no serverless-duration problem and no OAuth-AS problem — a plain MCP server next to the app may beat both. Don't build a Worker to look sophisticated.

## Non-negotiables

| key | rule | why |
| --- | --- | --- |
| spec-conformance | A protected MCP server is an **OAuth 2.1 resource server** (MCP auth spec rev 2025-11-25): RFC 9728 Protected Resource Metadata at `/.well-known/oauth-protected-resource` with `authorization_servers` populated; 401 + `WWW-Authenticate` pointing at it; RFC 8707 `resource` validation (a token minted for one server must not replay at another) | these are MUSTs in the current spec, not blog-post nice-to-haves |
| conformance-by-decision | `@cloudflare/workers-oauth-provider` ≥0.8 provides all of the above by default (PRM auto-served; RFC 8707 strict-exact via `resourceMatchOriginOnly: false`; CIMD opt-in). **State in `src/index.ts` comments which defaults you rely on, and pin a minimum version** | a silent default you don't know about is one you can't reason about when it changes |
| refresh-ttl-deliberate | set `accessTokenTTL`/`refreshTokenTTL` explicitly, or write a comment owning the defaults. **The refresh TTL is your revocation window** — nothing re-contacts the IdP/app on refresh | it's the single number deciding "how long after someone leaves can they still call this" |
| consent-state-bound | OAuth `state` is KV-stored (short TTL), its **hash** in a `__Host-` cookie, both must match at `/callback`, KV entry deleted on use (single-use). CSRF token on the approval form | without it an attacker's state token can be injected into a victim's flow |
| headless-auth-path | browser OAuth alone locks out every client that can't receive a loopback redirect — dev containers, SSH, CI. Ship a second door: a prefixed long-lived key the user mints in the app, sent as `Authorization: Bearer <app>_…`, matched on that prefix and routed past the OAuth provider before it sees the request, accepted on `/mcp` only. Store `sha256(key)` and nothing else; per-key revoke + last-used stamp; resolve it wherever that variant already resolves authority, so the key names a caller and never carries authority | the client's callback listens on *its own* `127.0.0.1` while the browser resolves `localhost` to the host machine — MCP clients expose the callback **port** (`--callback-port`) but never the **host**, so no configuration on either side closes the gap |
| oauth-kv-binding | KV bound as exactly **`OAUTH_KV`** | the library requires that exact binding name |
| stateless-handler | serve `/mcp` via `createMcpHandler` (`agents/mcp/server`) — **`McpAgent` is deprecated + feature-frozen upstream**, and its per-session Durable Object is vestigial in the stateless shape. Add a DO only when you deliberately need server-side state between tool calls (both shipped variants don't: a token in, an operation out) — and then it must be SQLite-backed (`new_sqlite_classes`, the only free-plan-eligible kind) | the retired shape ships a DO binding + migration for a class the current API doesn't have |
| identity-per-request | read identity per request from `getMcpAuthContext()?.props` (or close it over in the request path) — **never hold identity in module scope** | one Worker isolate serves many requests; module-scope identity leaks one user's identity into another's call |
| one-public-url | `workers_dev: true`, `preview_urls: false` | no per-version public hostnames; smaller surface for a gateway |
| fetch-strictly-public | `global_fetch_strictly_public` in `compatibility_flags` | hardens the OAuth server against SSRF and enables claude.ai's CIMD path — only when the Worker fetches public hosts exclusively |
| secrets-via-wrangler | secrets only via `wrangler secret put` (`task mcp:secrets`); never in `wrangler.jsonc`, never in the repo | wrangler keeps values out of files and TF state |

## Engine — copy faithfully (`assets/`)

- **`assets/workers-oauth-utils.ts`** → `<app>-mcp/src/workers-oauth-utils.ts`. The consent-state + CSRF + approval-dialog engine (from silo-cdp-mcp; matches Cloudflare's own `securing-mcp-servers` guidance). Self-contained — one type-only import from the provider. Key exports: `generateCSRFProtection`/`validateCSRFToken`, `createOAuthState`/`bindStateToSession`/`validateOAuthState` (KV + hashed `__Host-` cookie, single-use), `isClientApproved`/`addApprovedClient` (HMAC-signed 30-day cookie that skips the dialog on repeat consent), `renderApprovalDialog` (self-contained sanitized HTML). The state token is *hashed* into the cookie so a leaked state param (URL logs, referrer) can't be replayed as the cookie.
- **`assets/upstream-oauth.ts`** → `<app>-mcp/src/upstream-oauth.ts` (Variant A only). Provider-agnostic authorize-URL + code-exchange helpers.
- **`assets/wrangler.jsonc`** → `<app>-mcp/wrangler.jsonc`. Template — fill placeholders, keep the rationale comments.

## Shape — write fresh (illustration, not gospel)

Worker entrypoint (`src/index.ts`):

```ts
import { createMcpHandler, getMcpAuthContext } from "agents/mcp/server";
import { McpServer } from "@modelcontextprotocol/server";

// Factory runs per request — a fresh McpServer each time, identity read inside handlers.
const mcpHandler = createMcpHandler(() => {
  const server = new McpServer({ name: "<app>-mcp", version: "1.0.0" }, { instructions });
  // server.registerTool(...) — inside a handler: getMcpAuthContext()?.props
  return server;
});

export default new OAuthProvider({
  apiRoute: "/mcp",
  apiHandler: { fetch: mcpHandler },
  defaultHandler: AuthHandler,        // /authorize + /callback (Hono app works, cast to ExportedHandler)
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
  // Set deliberately, or comment that you own the defaults (see token lifetimes):
  // accessTokenTTL, refreshTokenTTL
});
```

`props` is whatever `/callback` stored via `completeAuthorization({ props })` — the per-session identity, read per request via `getMcpAuthContext()?.props`. Stateless means no server-side state between tool calls — a non-issue for both variants, but it's the thing to reconsider if you ever need long-lived subscriptions or accumulated session state (that's when a DO earns its way back in; see `stateless-handler`).

Token lifetimes — library defaults (confirmed in `0.7.2` type defs; re-verify at latest):

| Option | Default | Notes |
|---|---|---|
| `accessTokenTTL` | 3600s (1h) | |
| `refreshTokenTTL` | 2,592,000s (30d) | `0` disables refresh; explicit `undefined` = never expires |
| `clientRegistrationTTL` | 7,776,000s (90d) | DCR-created clients only |

Thirty days of refresh is reasonable for a low-stakes read tool and poor for anything sensitive. Pick it per app; Variant A's revocation problem (see `variant-a-direct-gateway.md`) makes this number load-bearing.

## Verify at latest

- **`@cloudflare/workers-oauth-provider`** — conformance facts above verified at `0.8.2` (2026-07-28); reference builds ship `^0.7.0` (cdp) and `^0.8.1` (adapts). Read the changelog for auth-relevant changes before scaffolding; pin `>=0.8`.
- **MCP authorization spec** — facts above are from rev **2025-11-25**; check for a newer revision.
- **`agents` SDK + `@modelcontextprotocol/server`** — `createMcpHandler` facts above verified at `agents@0.20.1` (2026-07-28). The MCP TS SDK split into `@modelcontextprotocol/server` / `@modelcontextprotocol/client` at v2 (`@modelcontextprotocol/sdk` is the pre-split package — don't add it). `registerTool` trap: two overloads — the current one takes a standard-schema object; the raw `ZodRawShape` form is `@deprecated`, and an unpinned schema generic silently falls through to it with an error message that points at `ZodRawShape` rather than the real problem. `fromJsonSchema()` adapts a JSON Schema into the current interface — the practical route for generating a Worker's tool schemas from an app's zod definitions instead of hand-maintaining a second copy.
