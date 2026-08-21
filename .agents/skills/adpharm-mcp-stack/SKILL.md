---
name: adpharm-mcp-stack
description: 'Build and extend remote MCP servers the Adpharm way — a Cloudflare Worker (agents SDK createMcpHandler + @cloudflare/workers-oauth-provider) that lets MCP clients (claude.ai, Claude Code) drive an existing app or data store, scoped by the same authority the app enforces, without duplicating business logic. Use this skill WHENEVER creating, updating, debugging, or reviewing an MCP server or its tools — "add an MCP server", "expose <app/data> to Claude", "add/change an MCP tool", "hook our app up to claude.ai", OAuth/consent/token TTLs/revocation for MCP, wrangler config for a Worker MCP, the MCP Inspector, or a companion skill/doc that describes a server. It encodes two shipped variants — A: direct gateway (external IdP, direct data-store access behind a restricted DB role) and B: app-relay (the app is the IdP in effect; the Worker relays tool calls into existing action helpers via short-lived JWTs) — plus the shared OAuth rails, spec-conformance MUSTs, tool-design rules, drift guards, and the mcp: Taskfile block. Reach for it even for "should this be an MCP server at all", and for any work inside an existing <app>-mcp/ directory.'
---

# Remote MCP — the gateway patterns

**Goal:** let a user of an existing app (or data store) drive it from an MCP client, scoped by the same authority the app enforces — **without duplicating business logic anywhere**. The moment a tool reimplements logic another surface also implements, you've created the drift bug this skill exists to prevent.

Distilled from two shipped builds — **silo-cdp-mcp** (Variant A) and **adapts-mcp** (Variant B) — with all claims verified against their source on 2026-07-28. They turned out to be *different variants*, not two data points for one pattern. What's still provisional is marked as such (Variant A's revocation options; "Mixing" is untried).

## Doctrine: engine vs shape (same as adpharm-stack)

The conventions in `references/` are **fixed**. *How* you satisfy them splits in two:

- **Engine — copy faithfully.** Files in `assets/` (the consent-hardening module, the Taskfile block, config templates). Copy verbatim; don't refactor or "improve". If an engine looks wrong, STOP and ask the user.
- **Shape — write fresh at current best practice.** Everything shown as a "Representative shape" — illustration, not gospel. Verify the current library API and write it yourself; don't paste snippets from the reference or from training-data memory.

Each reference file follows one schema — **Read when · Contract · Non-negotiables · Engine · Shape · Verify at latest** — with keyed non-negotiable rows. When you change how something works, **edit the owning row in place**; never append a parallel rule, and never restate a fact outside its owner file.

## Pick your variant (the fork is: who owns identity)

```
Does the app already sit behind an IdP (Google Workspace, Auth0, WorkOS, Okta…)?
│
├─ YES ──▶ Do the tools need the app's own mutation logic
│           (side effects: file generation, CDN purge, guards, audit rows)?
│          ├─ NO  ──▶  A. DIRECT GATEWAY — Worker → IdP for identity, → data store
│          │           directly; authority enforced AT the store (restricted DB role)
│          └─ YES ──▶  Mixing: A's auth + B's action route (untried — design it, don't assume)
│
└─ NO ───▶ App has cookie-session login only, and tools trigger real mutations
            └────────▶ B. APP-RELAY — the app is the IdP in effect; the Worker relays
                        every call into the app's existing action helpers
```

**Neither**, if you have no serverless-duration problem and no OAuth-AS problem — a plain MCP server next to the app may beat both. Don't build a Worker to look sophisticated. **Reconsider both** when several MCP servers serve one org — token audience-binding across servers becomes load-bearing and a real external IdP earns its keep.

| | **A. Direct gateway** | **B. App-relay** |
|---|---|---|
| Identity from | external IdP (OAuth upstream) | the app's own session login |
| Worker holds | a data-store credential | no data credential; only signing keys |
| Authority enforced at | the data store (DB roles) | the app's action route, per call |
| Tool surface | few, read-mostly (often one constrained primitive) | ~10–20 goal-shaped CRUD |
| Deployables | 1 | 2 (coupled — sequence app-first) |
| Shared secret between own services | none | yes — its weakest link (go asymmetric greenfield) |
| Revocation | **the hard part** (lags by refresh TTL) | immediate (DB re-read per call) |

Write the choice and the reason down. **Re-decide when the tool surface changes — adding a mutation to a Variant A server is a re-architecture, not a feature.**

## Routing map — read only what you're touching

| Working on… | Read | Engine in `assets/`? |
| --- | --- | --- |
| Worker scaffold, OAuth endpoints, spec conformance, token TTLs, consent hardening | `references/shared-core.md` | ✓ `workers-oauth-utils.ts`, `wrangler.jsonc` |
| Variant A — IdP handshake, access gate, DB-role wall, shared contract package, revocation | `references/variant-a-direct-gateway.md` | ✓ `upstream-oauth.ts` |
| Variant B — three-token handshake, consent route, action route, audit | `references/variant-b-app-relay.md` | — (shape; JWT module deliberately written fresh) |
| Tool surface — which tools, descriptions, `instructions`, caps, uploads, companion-doc drift guards | `references/tool-design.md` | — |
| Taskfile, provisioning (KV/secrets/OAuth client), dev loop, deploy | `references/ops.md` | ✓ `Taskfile.mcp.yml`, `mprocs.yaml`, `tsconfig.json` |

**Composes with `adpharm-stack` — this skill owns only what's MCP-specific.** Universal firm practice (pillars, TP1–TP7, bun/latest-deps) is already in every session via the global CLAUDE.md — never restated here. App-foundation facts (zod env validation, TF-managed env vars, AWS OIDC, Drizzle, app Taskfile conventions) are owned by the **adpharm-stack** sibling skill — invoke it when the MCP server sits beside an adpharm-stack app, and follow it for everything on the app side of a Variant B build (the action route, consent route, audit helpers are normal app code). Where the Worker deliberately deviates from that foundation — `wrangler.jsonc` as the IaC instead of Terraform, secrets via `wrangler secret put` instead of TF-managed env vars, point-of-use secret guards instead of a boot-time env schema — the owning reference here says so and why; don't "fix" the Worker back to app conventions.

## Build order — hardest first

1. **Steel thread:** the full auth handoff + **one real operation** end-to-end, from an actual MCP client against production. No mocks, no simulated auth. Variant A: one real query as the restricted role, gate proven *including the negative test* (an out-of-domain account gets a 403). Variant B: one real mutation through the action route into an existing helper, producing real side effects. If this slice is wrong, everything above it is.
2. **Full v1 tool surface** on the proven rails; hardening in the same pass (single-use state/`jti`, secret guards, deliberate TTLs).
3. **Hygiene:** identity-tagged logs/audit in the shared code path; rollback runbooks (DB PITR + object-store versioning). While auditing the MCP path, audit the web path too — the adapts build found a web action missing its session check exactly this way.

Defer real scope honestly; never hack interim versions of it.

## Per-app adaptation checklist

- [ ] **Variant chosen**, reason written down (and re-checked when the surface changes).
- [ ] **The gate:** who gets MCP at all, enforced *where*? Prefer a wall (DB role, proxy) over a check; a check runs on the IdP's assertion after code exchange, never on a parameter you sent.
- [ ] **Revocation:** what actually kills a live session, how long does it take, and is the real procedure written down? `refreshTokenTTL` set deliberately.
- [ ] **Attribution:** can you tell who ran a given operation from the logs, after the fact?
- [ ] **Spec conformance:** which of PRM / RFC 8707 / CIMD you rely on the library for — stated in comments, minimum version pinned.
- [ ] **Tool surface:** re-derived from this app's user goals (constrained primitive vs goal-shaped CRUD); side effects of each mutation inventoried.
- [ ] **Input schemas:** reuse the app's existing zod/form schemas where they exist.
- [ ] **SSOT mechanism:** shared typed package (A) or HTTP into existing helpers (B) — and what *fails the build* when surfaces drift?
- [ ] **`instructions`:** workflow order, destructive-action warnings, which values to ask the user for.
- [ ] **Config:** account id, KV namespace, origin URL in `wrangler.jsonc`; secrets in every store that needs them (`task mcp:secrets`).
- [ ] **Audit + rollback:** where records go, the PITR window, object-store versioning on.

## Global guardrails (owned here)

- Typecheck before done: `task mcp:typecheck` (regenerates Env types first — see `references/ops.md`).
- **Never deploy (`task mcp:deploy`) or run `wrangler secret put` without explicit permission** — deploys are live immediately on the one public URL.
- Never start the dev loop (`task mcp:dev`) unprompted (TP5).
- Secrets never in `wrangler.jsonc`, `.dev.vars` stays gitignored, and no credential ever appears in a tool response or log.
- Bun + latest deps (`bun add <pkg>@latest`), per global TP2/TP3 — nothing here pins a version except the OAuth provider's *minimum* (`>=0.8`, for spec conformance).
