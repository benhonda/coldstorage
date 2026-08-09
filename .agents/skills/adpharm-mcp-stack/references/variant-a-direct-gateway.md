# Variant A — Direct gateway (external IdP → data store)

Worker authenticates the user against an external IdP, then talks to the data store directly. There is no app in the path. Reference build: **silo-cdp-mcp** (`apps/cdp-mcp` in silo-services) — read-only SQL over the Silo CDP event store for `@theadpharm.com` analysts; one tool.

**Read when:** building/changing a Variant A server — the IdP handshake, the access gate, the data-store connection, or the shared contract package.

## Contract

```
MCP client ──OAuth──▶ Worker ──OAuth upstream──▶ IdP (e.g. Google Workspace)
                        │
                        └──────────────────────▶ data store (e.g. Neon Postgres)
                                                 as a restricted role
```

Auth flow: `/authorize` parses the request, renders the approval dialog (CSRF-protected), creates + session-binds the state token → redirect to the IdP → `/callback` validates state (KV **and** cookie), exchanges the code, fetches the profile, **enforces the access gate**, then `completeAuthorization({ props: identity })`. Tool handlers read identity from `getMcpAuthContext()?.props` and query the store.

## Non-negotiables

| key | rule | why |
| --- | --- | --- |
| gate-in-callback | the access gate runs in `/callback` on the **IdP's assertion** after the code exchange — never on a parameter you sent upstream. Google's `hd=domain` authorize param only pre-fills the account chooser; the upstream Cloudflare template shipped it as though it were a gate | a request parameter stops nobody |
| gate-checks-all | for a Google domain gate: `hd` claim matches, email's domain matches, **and `verified_email === true`** (strict — the shipped build's `=== false` check lets an *omitted* field pass; don't copy that), fail-closed when the expected domain env var is unset. Anything else → 403, no token issued | each check covers a spoof path the others miss |
| authority-is-a-wall | prefer authority the Worker *cannot* bypass: a restricted DB role (e.g. `mcp_analyst_ro`) inside `BEGIN TRANSACTION READ ONLY`. Per-tenant: `SET LOCAL ROLE tenant_<slug>_ro` + **assert `current_user` actually changed** (fail closed), with view predicates keyed on `current_user` | a guard you can't bypass beats a guard you must remember to call |
| ssot-shared-package | single-source the tool contract (name, descriptions) **and** the safety wrapper in a typed workspace package consumed by every surface (Worker + app backends) — compile-time SSOT, no HTTP hop. Only valid because A's tools are read-only; that's the condition for being in A at all | two hand-kept copies of a contract always drift |
| no-credential-leaks | the store credential is a restricted role and appears in no tool response, log, or repo | it's the only data secret the Worker holds |
| log-identity | every authorization and denial logged with identity (`[auth] OK <email> …` / `[auth] DENIED <email> hd=… verified=…`), browsable via `task mcp:tail` | the Worker is the only place that knows who called |
| mutation-means-rearchitect | **adding a mutation to a Variant A server is a re-architecture, not a feature** — that's the moment you need B's per-call authority re-read | A's revocation + attribution weaknesses are unacceptable for writes |

## Engine — copy faithfully

`assets/workers-oauth-utils.ts` + `assets/upstream-oauth.ts` (see `shared-core.md`). The auth *handler* itself is Shape — the choreography is boilerplate but provider-specific literals (endpoints, userinfo shape, gate predicate) make it yours.

## Shape — write fresh (illustration, not gospel)

The data-access safety wrapper (from `@adpharm/silo-query` — generalize, don't import):

```ts
// Pre-flight (friendlier errors; NOT the guarantee — the role + READ ONLY txn are):
// strip leading SQL comments, require /^(with|select)\b/i, reject ";" (single statement).
await client.query("BEGIN TRANSACTION READ ONLY");
await client.query(`SET LOCAL statement_timeout = '60s'`);
const page = await client.query(`SELECT * FROM (${sql}) _q LIMIT ${ROW_CAP + 1}`); // cap IN the query
const capped = page.rows.length > ROW_CAP;
// report the true total when capped, so a capped result is visibly capped
// on any throw: ROLLBACK (so a pooled session isn't left aborted), then a structured error result
```

Fresh `Client` per Worker request, `await client.end()` in `finally` — WebSocket connections can't outlive a Worker request. Keep the package framework-agnostic (a `Queryable` interface, no MCP SDK dep) and let each consumer build its own zod schema from an exported description constant, avoiding shared-zod-version coupling.

## The open problem: revocation and attribution (be honest about it)

**Revocation lags.** The gate runs *once*, at consent; access (1h) and refresh (30d default) tokens renew without re-contacting the IdP. Remove someone from the Workspace and their connected client keeps working until the refresh token ages out or someone hand-deletes the grant from KV. Options, cheapest first — no settled default yet:

1. **Shorten `refreshTokenTTL`** — one line; shrinks the window; doesn't close it. Right answer for a read-only internal tool.
2. **Re-check per tool call** against something authoritative (users table, IdP directory) — immediate, but couples the Worker to a system it otherwise doesn't read, and adds a hop per call.
3. **Access proxy in front** (e.g. Cloudflare Access) for dashboard-managed revocation.

Whichever you pick, **document the actual revocation procedure** — "remove them from the IdP" only governs *new* authorizations.

**Attribution is weak by construction.** Every caller shares one store role, so the store's logs can't tell you who ran what. The Worker knows (the auth context's `props.email`) — log it per call and set `application_name` on the DB session so it reaches the store's logs. Cheap, and the difference between having an audit trail and believing you have one.

Neither is fatal for a read-only internal tool. Both are unacceptable the day A grows a write (see `mutation-means-rearchitect`).

## Verify at latest

- IdP endpoints + userinfo/claim shapes (Google's have moved before). If the IdP offers an ID token, verifying its signature beats a bearer-token userinfo fetch — the reference build does the latter; check current best practice.
- DB driver (`@neondatabase/serverless` or equivalent) — current connection-lifecycle guidance for Workers.
