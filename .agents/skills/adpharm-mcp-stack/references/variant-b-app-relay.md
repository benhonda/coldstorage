# Variant B — App-relay (the app is the IdP in effect)

The Worker relays every tool call into the app's existing action helpers over one authenticated route. Users authenticate on the app domain they already trust; passwords never touch the Worker. Reference build: **adapts-mcp** (+ its remix-app counterpart) — 16 goal-shaped tools. All claims below verified against that source 2026-07-28.

**Read when:** building/changing a Variant B server — the token handshake, the consent route, the action route, or adding/altering a relayed tool.

## Contract

```
MCP client ──OAuth──▶ Worker ──signed JWT (~60s)──▶ App  POST /api/mcp-actions
                                                     · verify JWT → re-read user + role from DB
                                                     · dispatch into EXISTING action helpers
                                                          ▼
                                        DB · file generation · CDN purge · audit records
```

Three token kinds, distinct `purpose` claims so no kind can be replayed as another:

| # | `purpose` | Direction | Carries | TTL |
|---|---|---|---|---|
| 1 | `mcp-consent-request` | Worker → app | serialized OAuth `AuthRequest` (opaque to the app, round-tripped verbatim), client name, Worker callback URL | ~10 min |
| 2 | `mcp-user-grant` | app → Worker | identity (`sub`, email, name, role) + `jti`, `aud` = callback URL | ~5 min |
| 3 | `mcp-api` | Worker → app | `sub` + email only — **deliberately no role**; authorization truth lives server-side | ~60 s |

Flow: client hits `/authorize` → Worker signs #1, redirects to the app's `/mcp-consent?req=<token>` → the consent route requires the normal session login, role-gates via a shared role module, renders "Allow \<client\> to …?" → on approval the app signs #2 → Worker verifies it, **records the `jti` in KV (reusing `OAUTH_KV`) and rejects replays**, then `completeAuthorization({ props: identity })` → every tool call mints a fresh #3 from `props`.

The action route, one `POST /api/mcp-actions`:

1. Verify the Bearer `mcp-api` JWT → `{ userId }`.
2. **Fresh DB read** of the user; active check + role gate (401/403 early).
3. Parse with a **zod discriminated union on `type`** — one variant per tool, reusing the app's existing form schemas where they exist. For partial updates, the reference build's trick is the keeper: merge the partial input over the current DB row, then re-parse the *merged* object through the full form schema — full validation without requiring full input.
4. Dispatch (exhaustive `match`) to the **existing** action helper — they should already take a `user` param; build it from the fresh read.
5. Audit every mutation **inside the shared helpers** (both surfaces get it free), tagged with channel (`web` vs `mcp`), with `before` snapshots on update/delete (that's your undo data). Hoist the audit object above the `try` so the `catch` can log failures (`ok: false` + status/error) too — the reference build audits failures, and it's paid off.

## Non-negotiables

| key | rule | why |
| --- | --- | --- |
| identity-not-authority | tokens carry identity, never authority — role re-read from the DB on every call | revocation is immediate; a stale role in a token can never grant access — deliberately better than a session cookie that bakes the role in until re-login |
| single-use-grants | grant `jti` recorded in KV, replays rejected (KV TTL comfortably outliving the token's expiry) | a leaked grant must not mint a second session (note: KV read-then-write isn't atomic; a theoretical simultaneous-replay race remains — acceptable at 5-min TTL) |
| audience-bind-everything | #2 is `aud`-bound to the callback URL at signing **and** verification. **Bind #3 too** (aud = the action-route URL) — the reference build skips this, leaving #3's replay defense as TTL + `purpose` only; close that gap in new builds | audience binding is what stops a token minted for one endpoint being replayed at another |
| loud-secret-guards | fail loudly on missing/short (<32 chars) signing secrets **at point of use**, not in the boot-time env schema | the MCP feature can be absent from an environment without breaking app startup — but must never silently sign with a weak key |
| asymmetric-keys-greenfield | the reference build shares one HS256 secret between Worker and app — its known weakest link. Greenfield: asymmetric keys (each side signs with its private key, verifies with the other's public) | same effort when starting fresh; removes "compromise either store, forge for both" |
| role-module-shared | the allowed-roles list is one module, deliberately **not** `.server.ts` | consent UI and route gate on the same SSOT |
| deploy-app-first | two deployables, coupled: when the Worker starts requiring something the app issues, new consents fail until the app deploy lands — sequence app-first, note it in the PR | Variant A has one deployable; B's coupling is the price of the relay |

## Engine — copy faithfully

`assets/workers-oauth-utils.ts` (consent hardening — see `shared-core.md`). The JWT module is deliberately **not** shipped as an engine: the reference build's is HS256-shared-secret, which `asymmetric-keys-greenfield` supersedes. Write it fresh with `jose` at latest, keeping the reference's *structure*: one module per side, the three-purpose scheme, TTL constants, zod-validated claims, the jti replay check, the secret guard.

## Shape — write fresh (illustration, not gospel)

- Worker: `src/index.ts` (entrypoint, `shared-core.md`), `src/auth-handler.ts` (~100 lines: `/authorize` signs #1 + redirects; `/callback` verifies #2 + jti + completes), `src/jwt.ts`, `src/mcp.ts` (the `McpServer` factory + tools calling one shared `callApi`), `src/<app>-api.ts` (thin fetch client; a stable `{ok, result, error, issues}` envelope).
- App: the consent route (loader requires session + role; action signs #2), the action route (five steps above), the shared role module, the audit helper.
- Tool wire types: tool names are snake_case for the model; the `type` values in the discriminated union may be camelCase — fine, but generate or cross-check the mapping; it has drifted in the reference build.

## Verify at latest

- **`jose`** — current API for sign/verify + your chosen algorithm (asymmetric: EdDSA or ES256 per current guidance).
- The app framework's session/CSRF idioms for the consent route.
- `zod` — both v3 and v4 are live in the reference builds; use the repo's version, don't fight it.
